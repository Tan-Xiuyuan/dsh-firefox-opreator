/**
 * A tiny in-process WebDriver BiDi server used by the unit tests.
 *
 * It implements just enough of the protocol to exercise the real WebSocket
 * transport, session handshake, tab lifecycle, navigation, and the page-side
 * JSON bridges. It is not a Firefox emulator: the live test uses real Firefox.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** @param {Buffer} buffer */
function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Decode as many complete client frames as the buffer contains. */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const total = headerLength + maskLength + length;
    if (offset + total > buffer.length) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const dataStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(dataStart, dataStart + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ fin, opcode, payload });
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** @param {import("node:net").Socket} socket @param {string} text */
function sendText(socket, text) {
  if (socket.destroyed) return;
  socket.write(encodeFrame(text));
}

/** @param {import("node:net").Socket} socket @param {number} code @param {string} reason */
function closeSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed) return;
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  const header = Buffer.from([0x88, payload.length]);
  socket.write(Buffer.concat([header, payload]));
  socket.end();
}

/**
 * @param {{commandDelayMs?: number}} [options]
 */
export async function startMockBidiServer(options = {}) {
  /** @type {Map<string, {tabId: string, url: string, title: string}>} */
  const tabs = new Map();
  const addTab = (url = "about:blank") => {
    const tabId = `tab-${randomUUID().slice(0, 8)}`;
    tabs.set(tabId, { tabId, url, title: url === "about:blank" ? "" : `Title of ${url}` });
    return tabId;
  };
  const initialTab = addTab();
  const state = {
    tabs,
    initialTab,
    activeTabId: initialTab,
    lastMethod: null,
    lastParams: null,
    methods: [],
    inputActions: 0,
  };

  const server = createServer((request, response) => {
    if (request.url === "/json/version") {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        Browser: "firefox",
        "Protocol-Version": "1.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/session`,
      }));
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket) => {
    if (request.url !== "/session") {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));

    let buffer = Buffer.alloc(0);
    let fragments = [];
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeFrames(buffer);
      buffer = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          closeSocket(socket);
          return;
        }
        if (frame.opcode === 0x9) {
          const pong = Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload]);
          socket.write(pong);
          continue;
        }
        if (frame.opcode === 0xa) continue;
        if (frame.opcode === 0x0) {
          fragments.push(frame.payload);
        } else {
          fragments = [frame.payload];
        }
        if (!frame.fin) continue;
        const payload = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        let message;
        try {
          message = JSON.parse(payload);
        } catch {
          continue;
        }
        void handle(message, socket);
      }
    });
    socket.on("error", () => {
      // The client test may tear down mid-request.
    });
  });

  /** @param {{id: number, method: string, params?: any}} message @param {import("node:net").Socket} socket */
  async function handle(message, socket) {
    state.lastMethod = message.method;
    state.lastParams = message.params;
    state.methods.push(message.method);
    const respond = (result) => sendText(socket, JSON.stringify({ type: "success", id: message.id, result }));
    const fail = (error, text) => sendText(socket, JSON.stringify({ type: "error", id: message.id, error, message: text }));
    const params = message.params ?? {};

    if (message.method === "mock.delay") {
      await new Promise((resolve) => setTimeout(resolve, params.ms ?? options.commandDelayMs ?? 0));
    }

    switch (message.method) {
      case "session.new":
        respond({ sessionId: "mock-session", capabilities: { browserName: "firefox", browserVersion: "153.5.1" } });
        return;
      case "browsingContext.getTree": {
        const contexts = [...tabs.values()].map((tab) => ({
          context: tab.tabId,
          url: tab.url,
          title: tab.title,
          type: "tab",
        }));
        respond({ contexts });
        return;
      }
      case "browsingContext.create": {
        const tabId = addTab("about:blank");
        tabs.get(tabId).title = "";
        state.activeTabId = tabId;
        respond({ context: tabId });
        return;
      }
      case "browsingContext.activate": {
        if (!tabs.has(params.context)) {
          fail("no such frame", "no such tab");
          return;
        }
        state.activeTabId = params.context;
        respond({});
        return;
      }
      case "browsingContext.close": {
        if (!tabs.has(params.context)) {
          fail("no such frame", "no such tab");
          return;
        }
        tabs.delete(params.context);
        if (state.activeTabId === params.context) state.activeTabId = tabs.keys().next().value ?? null;
        respond({});
        return;
      }
      case "browsingContext.navigate": {
        if (!tabs.has(params.context)) {
          fail("no such frame", "no such tab");
          return;
        }
        const tab = tabs.get(params.context);
        tab.url = String(params.url ?? tab.url);
        tab.title = tab.url === "about:blank" ? "" : `Title of ${tab.url}`;
        state.activeTabId = params.context;
        respond({ navigation: "mock-navigation", url: tab.url });
        return;
      }
      case "input.performActions": {
        if (!tabs.has(params.context)) {
          fail("no such frame", "no such tab");
          return;
        }
        state.inputActions += 1;
        if (params.actions?.some?.((action) => action.type === "pointer" && action.actions?.some?.((item) => item.type === "pointerDown"))) {
          // No actual DOM state change is needed for the transport test.
        }
        respond({});
        return;
      }
      case "script.evaluate":
        respond(evaluatePage(params.expression, tabs.get(params.target?.context)));
        return;
      case "session.end":
        respond({});
        return;
      case "mock.delay":
        respond({ delayed: true });
        return;
      case "mock.fail":
        fail("mock failure", "deliberate mock failure");
        return;
      case "browser.close":
        respond({});
        closeSocket(socket);
        return;
      default:
        fail("unknown command", `unknown command: ${message.method}`);
    }
  }

  /** @param {string} expression @param {{tabId: string, url: string, title: string} | undefined} tab */
  function evaluatePage(expression, tab) {
    if (!tab) {
      return {
        type: "success",
        realm: "mock-realm",
        result: { type: "string", value: JSON.stringify({ ok: false, error: "no such tab" }) },
      };
    }
    if (expression.trim() === "document.title") {
      return {
        type: "success",
        realm: "mock-realm",
        result: { type: "string", value: tab.title },
      };
    }
    let value;
    if (expression.includes("__dshValue")) {
      if (expression.includes("THROW_IN_PAGE")) {
        value = { ok: false, error: "mock page error" };
      } else if (expression.includes("RETURN_OBJECT")) {
        value = { ok: true, type: "object", value: { answer: 42 } };
      } else {
        value = { ok: true, type: "number", value: 42 };
      }
    } else if (expression.includes("scrollIntoView") && expression.includes("elementFromPoint")) {
      if (expression.includes('"#missing"')) {
        value = { ok: false, error: "selector not found: #missing" };
      } else if (expression.includes('"#disabled"')) {
        value = { ok: true, x: 10, y: 20, visible: true, tag: "button", text: "Disabled", disabled: true, covered: false, coveredBy: null, type: "button" };
      } else {
        value = { ok: true, x: 10, y: 20, visible: true, tag: "button", text: "Submit", disabled: false, covered: false, coveredBy: null, type: "button" };
      }
    } else if (expression.includes("descriptor.set.call")) {
      value = {
        ok: true,
        tag: "input",
        type: "text",
        filled: "filled-value",
        submitted: expression.includes("const submit = true;"),
        formAction: expression.includes("const submit = true;") ? "https://example.test/form" : null,
      };
    } else if (expression.includes("const selector =") && expression.includes("const loadReady")) {
      value = { ok: true, matched: true, readyState: "complete", title: tab.title, url: tab.url, found: true };
    } else if (expression.includes("const selector =") && expression.includes("maxChars")) {
      value = {
        ok: true,
        title: tab.title,
        url: tab.url,
        readyState: "complete",
        tag: "body",
        text: `Mock body for ${tab.url}`,
        textTruncated: false,
        html: "<body>mock</body>",
        htmlTruncated: false,
      };
    } else if (expression.includes("loadReady")) {
      value = { ok: true, matched: true, readyState: "complete", title: tab.title, url: tab.url };
    } else {
      value = { ok: true, echo: expression.slice(0, 200) };
    }
    return {
      type: "success",
      realm: "mock-realm",
      result: { type: "string", value: JSON.stringify(value) },
    };
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind");
  return {
    port: address.port,
    state,
    addTab,
    /** @returns {Promise<void>} */
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        // Sockets are destroyed by the client close path; ensure the server
        // callback is not held forever by a lingering upgrade socket.
        setTimeout(resolve, 250).unref();
      });
    },
  };
}
