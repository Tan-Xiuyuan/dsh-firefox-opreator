/**
 * Minimal WebDriver BiDi client over one WebSocket.
 *
 * Firefox's remote agent speaks JSON commands with numeric ids. It also emits
 * events (type: "event") that this operator does not need; they are ignored.
 * All commands are serialized by the controller above this class, so one
 * outstanding command is the normal case.
 */

import { FirefoxOperatorError, fromBidiError } from "./errors.js";

const WS_OPEN = 1;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Extract a JavaScript value from a BiDi RemoteValue. The operator normally
 * returns JSON strings, but this handles the primitives and the object form as
 * a defensive fallback.
 *
 * @param {any} remote
 * @returns {any}
 */
export function remoteValueToJs(remote) {
  if (remote === null || remote === undefined) return null;
  if (typeof remote !== "object") return remote;
  if (remote.type === "undefined") return undefined;
  if (remote.type === "null") return null;
  if (remote.type === "string" || remote.type === "number" || remote.type === "boolean") {
    return remote.value;
  }
  if (remote.type === "bigint") return remote.value;
  if (remote.type === "array" && Array.isArray(remote.value)) {
    return remote.value.map((item) => remoteValueToJs(item));
  }
  if (remote.type === "object" && Array.isArray(remote.value)) {
    const out = {};
    for (const pair of remote.value) {
      if (Array.isArray(pair) && pair.length === 2) out[String(pair[0])] = remoteValueToJs(pair[1]);
    }
    return out;
  }
  return remote.value ?? null;
}

export class BidiClient {
  /**
   * @param {{connectTimeoutMs?: number, commandTimeoutMs?: number}} [options]
   */
  constructor(options = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {Map<string, {resolve: Function, reject: Function, timer?: ReturnType<typeof setTimeout>}>} */
    this.pending = new Map();
    this.nextId = 1;
    this.sessionId = null;
    this.capabilities = null;
    this.url = null;
    this.lastError = null;
    this._intentionalClose = false;
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WS_OPEN && this.sessionId !== null;
  }

  /**
   * Open the WebSocket and create a BiDi session.
   *
   * @param {string} webSocketUrl ws://127.0.0.1:PORT/session
   * @param {{signal?: AbortSignal, connectTimeoutMs?: number, sessionTimeoutMs?: number}} [options]
   */
  async connect(webSocketUrl, options = {}) {
    const connectTimeoutMs = options.connectTimeoutMs ?? this.connectTimeoutMs;
    if (typeof globalThis.WebSocket !== "function") {
      throw new FirefoxOperatorError(
        "WEBSOCKET_UNAVAILABLE",
        "this Node.js runtime has no global WebSocket (Node >= 22 is required)",
        { hint: "Run dsh with Node.js 22 or newer." },
      );
    }
    this.close("reconnecting");
    this._intentionalClose = false;
    this.lastError = null;
    this.url = webSocketUrl;

    const ws = new globalThis.WebSocket(webSocketUrl);
    this.ws = ws;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // The socket may never have opened; nothing else to clean up.
        }
        reject(new FirefoxOperatorError(
          "CONNECT_TIMEOUT",
          `WebSocket did not open within ${connectTimeoutMs} ms at ${webSocketUrl}`,
          { hint: "Confirm Firefox is running with --remote-debugging-port and that the port is reachable." },
        ));
      }, connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
        ws.removeEventListener("close", onEarlyClose);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new FirefoxOperatorError(
          "CONNECT_FAILED",
          `could not open WebSocket at ${webSocketUrl}`,
          { hint: "Firefox may have exited, or the remote-debugging port belongs to another program." },
        ));
      };
      const onEarlyClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new FirefoxOperatorError(
          "CONNECT_CLOSED",
          `Firefox closed the WebSocket before it opened (${webSocketUrl})`,
          { hint: "Check that the Firefox remote agent started and that no other BiDi client holds the only session." },
        ));
      };

      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("close", onEarlyClose, { once: true });
      options.signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.close();
        } catch {
          // ignored
        }
        reject(new FirefoxOperatorError("ABORTED", "WebSocket connection cancelled"));
      }, { once: true });
    });

    ws.addEventListener("message", (event) => {
      void this._onMessage(event, ws);
    });
    ws.addEventListener("close", () => {
      this._onClose(ws);
    });
    ws.addEventListener("error", () => {
      // A WebSocket error is followed by close in the browsers this targets.
      // Keep the close path as the single owner of pending rejection.
    });

    try {
      const session = await this.send("session.new", { capabilities: {} }, {
        timeoutMs: options.sessionTimeoutMs ?? Math.max(connectTimeoutMs, this.commandTimeoutMs),
        signal: options.signal,
      });
      this.sessionId = session?.sessionId ?? null;
      this.capabilities = session?.capabilities ?? null;
      if (!this.sessionId) {
        throw new FirefoxOperatorError(
          "SESSION_NOT_CREATED",
          "Firefox accepted session.new but returned no sessionId",
          { details: session },
        );
      }
      return session;
    } catch (error) {
      this.close("session.new failed");
      throw fromBidiError("session.new", error);
    }
  }

  /**
   * Send one BiDi command and await its result.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   * @returns {Promise<any>}
   */
  send(method, params = {}, options = {}) {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new FirefoxOperatorError(
        "NOT_CONNECTED",
        `cannot send ${method}: no WebSocket to Firefox`,
        { hint: "Call firefox_launch first, or call firefox_tabs to check the connection." },
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new FirefoxOperatorError("ABORTED", `${method} cancelled before sending`));
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const key = String(id);
      let settled = false;

      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(key);
      };
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(value);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      };
      const onAbort = () => {
        fail(new FirefoxOperatorError("ABORTED", `${method} cancelled by caller`));
      };
      const timer = setTimeout(() => {
        fail(new FirefoxOperatorError(
          "COMMAND_TIMEOUT",
          `${method} did not answer within ${timeoutMs} ms`,
          { hint: "The page may still be loading; retry or increase the timeout." },
        ));
      }, timeoutMs);

      this.pending.set(key, {
        resolve: succeed,
        reject: fail,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        fail(new FirefoxOperatorError("SEND_FAILED", `could not send ${method}`, { cause: error }));
      }
    });
  }

  /**
   * @param {MessageEvent} event
   * @param {WebSocket} socket the socket that produced the message
   */
  async _onMessage(event, socket) {
    if (socket !== this.ws) return;
    let text;
    try {
      if (typeof event.data === "string") {
        text = event.data;
      } else if (event.data instanceof ArrayBuffer) {
        text = Buffer.from(event.data).toString("utf8");
      } else if (ArrayBuffer.isView(event.data)) {
        text = Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength).toString("utf8");
      } else if (event.data && typeof event.data.text === "function") {
        text = await event.data.text();
      } else {
        text = String(event.data);
      }
    } catch (error) {
      this.lastError = error;
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      this.lastError = new Error(`invalid BiDi JSON: ${String(error)}`);
      return;
    }
    const messages = Array.isArray(message) ? message : [message];

    for (const item of messages) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "event") continue;
      if (item.id === undefined || item.id === null) continue;

      const pending = this.pending.get(String(item.id));
      if (!pending) continue;

      if (item.type === "success") {
        pending.resolve(item.result);
      } else if (item.type === "error") {
        pending.reject(fromBidiError("BiDi command", {
          error: item.error,
          message: item.message,
          stacktrace: item.stacktrace,
        }));
      } else {
        pending.reject(new FirefoxOperatorError(
          "PROTOCOL_ERROR",
          `unexpected BiDi response type ${JSON.stringify(item.type)} for command ${item.id}`,
          { details: item },
        ));
      }
    }
  }

  /** @param {WebSocket} socket */
  _onClose(socket) {
    if (socket !== this.ws) return;
    const reason = this.lastError
      ? `WebSocket closed: ${this.lastError.message}`
      : this._intentionalClose
        ? "WebSocket closed by this plugin"
        : "Firefox closed the WebSocket (browser exited, remote agent stopped, or session ended)";
    for (const pending of [...this.pending.values()]) {
      pending.reject(new FirefoxOperatorError("DISCONNECTED", reason, {
        hint: "Call firefox_launch to reconnect or restart Firefox.",
      }));
    }
    this.pending.clear();
    this.sessionId = null;
    this.ws = null;
  }

  /**
   * End the BiDi session, then close the socket. Firefox allows only one active
   * BiDi session per browser instance; simply dropping the socket leaves the
   * session attached and makes every later attach fail with "Maximum number of
   * active sessions". `session.end` does not close Firefox itself.
   *
   * @param {string} [reason]
   */
  async endSession(reason = "session ended") {
    if (!this.connected) {
      this.close(reason);
      return;
    }
    try {
      await this.send("session.end", {}, { timeoutMs: 2500 });
    } catch {
      // Firefox may close the WebSocket before the response; either way the
      // session is going away, so close the transport below.
    }
    this.close(reason);
  }

  /**
   * Close this client. Pending commands are rejected; an unresponsive socket is
   * abandoned instead of blocking plugin teardown.
   *
   * @param {string} [reason]
   */
  close(reason = "closed by plugin") {
    this._intentionalClose = true;
    this.sessionId = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (ws.readyState === WS_OPEN || ws.readyState === 0) ws.close(1000, reason.slice(0, 100));
      } catch {
        // ignore close races
      }
    }
    for (const pending of [...this.pending.values()]) {
      pending.reject(new FirefoxOperatorError("DISCONNECTED", reason, {
        hint: "Call firefox_launch to reconnect.",
      }));
    }
    this.pending.clear();
  }
}
