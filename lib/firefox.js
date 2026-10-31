/**
 * FirefoxOperator: owns one Firefox 153 ESR instance through its built-in
 * WebDriver BiDi remote agent.
 *
 * Firefox side: no extension and no native-messaging host is needed. Firefox is
 * started with `--remote-debugging-port=<port>`; the remote agent exposes
 * `http://127.0.0.1:<port>/json/version` and a BiDi WebSocket at `/session`.
 *
 * dsh side: the plugin creates the process (or attaches to one the user already
 * started), performs a BiDi handshake, and exposes the operations as agent
 * tools. Every operation is serialized through one promise queue because a
 * Firefox remote agent session is a single ordered protocol stream.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BidiClient, remoteValueToJs } from "./bidi-client.js";
import { FirefoxOperatorError, fromBidiError } from "./errors.js";

const WINDOWS = process.platform === "win32";
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_MS = 10_000;
const MAX_READ_CHARS = 200_000;
const MANAGED_PREFS_START = "// >>> dsh-firefox-operator managed prefs >>>";
const MANAGED_PREFS_END = "// <<< dsh-firefox-operator managed prefs <<<";

/** Defaults, exposed for documentation and tests. */
export const DEFAULT_CONFIG = Object.freeze({
  firefoxPath: undefined,
  profileDir: undefined,
  port: 0,
  headless: true,
  connectExisting: true,
  attachOnly: false,
  launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
  commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
  defaultWaitMs: DEFAULT_WAIT_MS,
  maxReadChars: MAX_READ_CHARS,
  killOnDispose: true,
});

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} name @param {number} min @param {number} max */
function asInteger(value, name, min, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.trunc(value) !== value) {
    throw new FirefoxOperatorError("INVALID_CONFIG", `${name} must be an integer`);
  }
  if (value < min || value > max) {
    throw new FirefoxOperatorError("INVALID_CONFIG", `${name} must be between ${min} and ${max}`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function asBoolean(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new FirefoxOperatorError("INVALID_CONFIG", `${name} must be a boolean`);
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function asString(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new FirefoxOperatorError("INVALID_CONFIG", `${name} must be a non-empty string`);
  }
  return value;
}

/** @param {string | undefined} value */
function expandHome(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** @param {string} value */
function absolutePath(value) {
  const expanded = expandHome(value);
  if (!expanded) return expanded;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** @param {Record<string, unknown>} raw @param {NodeJS.ProcessEnv} [env] */
export function resolveConfig(raw = {}, env = process.env) {
  if (raw === undefined || raw === null) raw = {};
  if (!isRecord(raw)) throw new FirefoxOperatorError("INVALID_CONFIG", "plugin config must be an object");

  const envHeadless = env.DSH_FIREFOX_HEADLESS;
  const envPort = env.DSH_FIREFOX_PORT;
  const headless = asBoolean(raw.headless, "headless")
    ?? (envHeadless === undefined ? undefined : /^(1|true|yes|on)$/i.test(envHeadless))
    ?? DEFAULT_CONFIG.headless;
  const port = asInteger(raw.port, "port", 0, 65535)
    ?? (envPort ? asInteger(Number(envPort), "DSH_FIREFOX_PORT", 1, 65535) : undefined)
    ?? DEFAULT_CONFIG.port;

  const profileDir = absolutePath(
    asString(raw.profileDir, "profileDir")
      ?? env.DSH_FIREFOX_PROFILE
      ?? (WINDOWS
        ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dsh-firefox-operator", "firefox-profile")
        : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "dsh-firefox-operator", "firefox-profile")),
  );

  const firefoxPath = absolutePath(
    asString(raw.firefoxPath, "firefoxPath")
      ?? env.DSH_FIREFOX_PATH
      ?? env.FIREFOX_PATH
      ?? "",
  ) || undefined;

  const config = {
    firefoxPath,
    profileDir,
    port,
    headless,
    connectExisting: asBoolean(raw.connectExisting, "connectExisting") ?? DEFAULT_CONFIG.connectExisting,
    attachOnly: asBoolean(raw.attachOnly, "attachOnly") ?? DEFAULT_CONFIG.attachOnly,
    launchTimeoutMs: asInteger(raw.launchTimeoutMs, "launchTimeoutMs", 1000, 180_000) ?? DEFAULT_CONFIG.launchTimeoutMs,
    commandTimeoutMs: asInteger(raw.commandTimeoutMs, "commandTimeoutMs", 1000, 180_000) ?? DEFAULT_CONFIG.commandTimeoutMs,
    navigationTimeoutMs: asInteger(raw.navigationTimeoutMs, "navigationTimeoutMs", 1000, 300_000) ?? DEFAULT_CONFIG.navigationTimeoutMs,
    defaultWaitMs: asInteger(raw.defaultWaitMs, "defaultWaitMs", 100, 180_000) ?? DEFAULT_CONFIG.defaultWaitMs,
    maxReadChars: asInteger(raw.maxReadChars, "maxReadChars", 1000, MAX_READ_CHARS) ?? DEFAULT_CONFIG.maxReadChars,
    killOnDispose: asBoolean(raw.killOnDispose, "killOnDispose") ?? DEFAULT_CONFIG.killOnDispose,
  };
  return config;
}

/** @param {number} ms @param {AbortSignal} [signal] */
function delay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(new FirefoxOperatorError("ABORTED", "operation cancelled"));
      return;
    }
    let onAbort;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      reject(new FirefoxOperatorError("ABORTED", "operation cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @param {number} port */
async function isPortOpen(port, host = "127.0.0.1", timeoutMs = 700) {
  return new Promise((resolveOpen) => {
    const socket = new Socket();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveOpen(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/** @returns {Promise<number>} */
export async function getFreePort(host = "127.0.0.1") {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new FirefoxOperatorError("PORT_LOOKUP_FAILED", "could not allocate a loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Wait until Firefox's remote agent accepts TCP connections.
 *
 * We intentionally do not probe Firefox's optional `/json/version` HTTP route:
 * on Firefox 153 ESR (2026-10 build) it accepts the TCP connection but never
 * answers, while the BiDi WebSocket at `/session` works. Connecting directly is
 * both the protocol's real entry point and the only reliable readiness check.
 *
 * @param {number} port
 * @param {{timeoutMs?: number, signal?: AbortSignal, isAlive?: () => boolean, host?: string}} [options]
 */
export async function waitForFirefoxPort(port, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const host = options.host ?? "127.0.0.1";
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new FirefoxOperatorError("ABORTED", "Firefox startup cancelled");
    if (options.isAlive && !options.isAlive()) {
      throw new FirefoxOperatorError("FIREFOX_EXITED", "Firefox exited before its remote agent became reachable");
    }
    if (await isPortOpen(port, host, Math.min(700, Math.max(100, deadline - Date.now())))) return true;
    await delay(200, options.signal);
  }
  throw new FirefoxOperatorError(
    "FIREFOX_START_TIMEOUT",
    `Firefox did not open its remote agent on ${host}:${port} within ${timeoutMs} ms`,
    { hint: "Start Firefox with --remote-debugging-port, or inspect the launch error for the selected profile." },
  );
}

/** @param {string | undefined} explicitPath */
export function findFirefoxPath(explicitPath) {
  if (explicitPath) {
    const normalized = absolutePath(explicitPath);
    if (normalized && existsSync(normalized)) {
      try {
        if (statSync(normalized).isDirectory()) {
          const inside = join(normalized, WINDOWS ? "firefox.exe" : "firefox");
          if (existsSync(inside)) return inside;
          throw new FirefoxOperatorError(
            "FIREFOX_NOT_FOUND",
            `configured Firefox directory does not contain a Firefox executable: ${normalized}`,
          );
        }
      } catch (error) {
        if (error instanceof FirefoxOperatorError) throw error;
        // fall through to the existence check below
      }
      return normalized;
    }
    throw new FirefoxOperatorError(
      "FIREFOX_NOT_FOUND",
      `configured Firefox path does not exist: ${normalized}`,
      { hint: "Set firefoxPath in the plugin config or FIREFOX_PATH in the dsh host environment." },
    );
  }

  const candidates = WINDOWS
    ? [
        process.env.ProgramFiles ? join(process.env.ProgramFiles, "Mozilla Firefox", "firefox.exe") : undefined,
        process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Mozilla Firefox", "firefox.exe") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Mozilla Firefox", "firefox.exe") : undefined,
        "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
        "D:\\Program Files\\Mozilla Firefox\\firefox.exe",
        "D:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
      ]
    : [
        "/Applications/Firefox.app/Contents/MacOS/firefox",
        "/usr/bin/firefox",
        "/usr/lib/firefox/firefox",
        "/opt/firefox/firefox",
      ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  if (WINDOWS) {
    try {
      const result = spawnSync("where.exe", ["firefox.exe"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
      const first = result.stdout?.split(/\r?\n/).map((line) => line.trim()).find((line) => line && existsSync(line));
      if (first) return first;
    } catch {
      // fall through to the actionable error
    }
  } else {
    for (const candidate of ["/usr/local/bin/firefox", "/snap/bin/firefox"]) {
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new FirefoxOperatorError(
    "FIREFOX_NOT_FOUND",
    "could not locate firefox.exe",
    {
      hint: WINDOWS
        ? "Install Firefox ESR or set config.firefoxPath / FIREFOX_PATH to the full firefox.exe path."
        : "Install Firefox or set config.firefoxPath / FIREFOX_PATH.",
    },
  );
}

/** @param {string} profileDir */
function managedPrefsBlock() {
  return [
    MANAGED_PREFS_START,
    'user_pref("remote.active-protocols", 1);',
    'user_pref("remote.enabled", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("browser.startup.page", 0);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.newtabpage.enabled", false);',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("browser.warnOnQuit", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("app.update.auto", false);',
    MANAGED_PREFS_END,
    "",
  ].join("\n");
}

/** @param {string} profileDir */
export function ensureProfilePrefs(profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const userJs = join(profileDir, "user.js");
  let previous = "";
  try {
    previous = readFileSync(userJs, "utf8");
  } catch {
    previous = "";
  }
  const start = previous.indexOf(MANAGED_PREFS_START);
  const end = previous.indexOf(MANAGED_PREFS_END);
  let preserved = previous;
  if (start !== -1 && end !== -1 && end > start) {
    preserved = `${previous.slice(0, start)}${previous.slice(end + MANAGED_PREFS_END.length)}`;
  }
  preserved = preserved.replace(/\s+$/u, "");
  const next = `${preserved}${preserved ? "\n\n" : ""}${managedPrefsBlock()}`;
  if (next !== previous) writeFileSync(userJs, next, "utf8");
  return profileDir;
}

/** @param {unknown} value */
function normalizeWaitUntil(value) {
  return value === "none" || value === "interactive" || value === "complete" ? value : "complete";
}

/** @param {string} selector */
function jsonLiteral(value) {
  return JSON.stringify(value);
}

/** Build the page-side locator used by click/fill. */
function locatorExpression(selector, text, index) {
  return `(() => {
    const selector = ${jsonLiteral(selector ?? null)};
    const text = ${jsonLiteral(text ?? null)};
    const index = ${Number.isInteger(index) ? index : 0};
    const norm = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    let el = null;
    if (selector !== null) {
      try { el = document.querySelector(selector); }
      catch (error) { return JSON.stringify({ ok: false, error: "invalid selector: " + String(error && error.message || error) }); }
    } else if (text !== null) {
      const needle = norm(text).toLowerCase();
      const candidates = Array.from(document.querySelectorAll(
        'a,button,input,textarea,select,label,[role="button"],[role="link"],[onclick]'
      )).filter((candidate) => {
        const haystack = norm(candidate.innerText || candidate.value || candidate.getAttribute("aria-label") || candidate.getAttribute("title"));
        return haystack.toLowerCase().includes(needle);
      });
      el = candidates[index] || null;
    } else {
      return JSON.stringify({ ok: false, error: "either selector or text is required" });
    }
    if (!el) {
      return JSON.stringify({ ok: false, error: selector !== null ? "selector not found: " + selector : "text not found: " + text });
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const top = visible ? document.elementFromPoint(x, y) : null;
    const covered = Boolean(top && top !== el && !el.contains(top));
    return JSON.stringify({
      ok: true,
      x,
      y,
      visible,
      tag: String(el.tagName || "").toLowerCase(),
      text: norm(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title")).slice(0, 300),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      covered,
      coveredBy: covered ? String(top.tagName || "").toLowerCase() : null,
      type: String(el.type || ""),
    });
  })()`;
}

/** Click by selector/text entirely in the page; used as a fallback when input.performActions is unsupported. */
function domClickExpression(selector, text, index) {
  return `(() => {
    const selector = ${jsonLiteral(selector ?? null)};
    const text = ${jsonLiteral(text ?? null)};
    const index = ${Number.isInteger(index) ? index : 0};
    const norm = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    let el = null;
    if (selector !== null) {
      try { el = document.querySelector(selector); }
      catch (error) { return JSON.stringify({ ok: false, error: "invalid selector: " + String(error && error.message || error) }); }
    } else if (text !== null) {
      const needle = norm(text).toLowerCase();
      const candidates = Array.from(document.querySelectorAll(
        'a,button,input,textarea,select,label,[role="button"],[role="link"],[onclick]'
      )).filter((candidate) => norm(candidate.innerText || candidate.value || candidate.getAttribute("aria-label") || candidate.getAttribute("title")).toLowerCase().includes(needle));
      el = candidates[index] || null;
    }
    if (!el) return JSON.stringify({ ok: false, error: "target not found" });
    el.click();
    return JSON.stringify({ ok: true, tag: String(el.tagName || "").toLowerCase() });
  })()`;
}

/** Build the form filler expression. */
function fillExpression(selector, value, submit) {
  return `(() => {
    const selector = ${jsonLiteral(selector)};
    const value = ${jsonLiteral(value)};
    const submit = ${submit === true ? "true" : "false"};
    let el = null;
    try { el = document.querySelector(selector); }
    catch (error) { return JSON.stringify({ ok: false, error: "invalid selector: " + String(error && error.message || error) }); }
    if (!el) return JSON.stringify({ ok: false, error: "selector not found: " + selector });
    if (el.disabled === true) return JSON.stringify({ ok: false, error: "element is disabled" });
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.type || "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      el.checked = !/^(false|0|no|off)$/i.test(String(value));
    } else if (tag === "select") {
      el.value = value;
      if (el.value !== value) {
        const option = Array.from(el.options || []).find((candidate) => candidate.value === value || candidate.text === value);
        if (option) el.value = option.value;
      }
    } else if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
    } else {
      el.focus();
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    let submitted = false;
    let formAction = null;
    if (submit) {
      const form = el.form || el.closest("form");
      if (form) {
        formAction = form.action || null;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        submitted = true;
      }
    }
    return JSON.stringify({
      ok: true,
      tag,
      type,
      filled: type === "checkbox" || type === "radio" ? el.checked : String(el.value ?? el.textContent ?? "").slice(0, 200),
      submitted,
      formAction
    });
  })()`;
}

/** Build the read expression. */
function readExpression(selector, includeHtml, maxChars) {
  return `(() => {
    const selector = ${jsonLiteral(selector ?? null)};
    const includeHtml = ${includeHtml === true ? "true" : "false"};
    const maxChars = ${maxChars};
    let root = null;
    try { root = selector === null ? (document.body || document.documentElement) : document.querySelector(selector); }
    catch (error) { return JSON.stringify({ ok: false, error: "invalid selector: " + String(error && error.message || error) }); }
    if (!root) return JSON.stringify({ ok: false, error: selector === null ? "page has no body" : "selector not found: " + selector });
    let text = "";
    try { text = root.innerText ?? root.textContent ?? ""; } catch { text = ""; }
    let html = "";
    if (includeHtml) {
      try { html = root.outerHTML ?? ""; } catch { html = ""; }
    }
    const textTruncated = text.length > maxChars;
    const htmlTruncated = html.length > maxChars;
    return JSON.stringify({
      ok: true,
      title: document.title,
      url: location.href,
      readyState: document.readyState,
      tag: String(root.tagName || "").toLowerCase(),
      text: text.slice(0, maxChars),
      textTruncated,
      html: includeHtml ? html.slice(0, maxChars) : undefined,
      htmlTruncated: includeHtml ? htmlTruncated : false
    });
  })()`;
}

/** Build the selector/load wait expression. */
function waitExpression(selector, state, loadState) {
  return `(() => {
    const selector = ${jsonLiteral(selector ?? null)};
    const state = ${jsonLiteral(state ?? "visible")};
    const loadState = ${jsonLiteral(loadState ?? "none")};
    const norm = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const ready = document.readyState;
    const loadReady = loadState === "interactive" ? (ready === "interactive" || ready === "complete") : loadState === "complete" ? ready === "complete" : true;
    if (selector === null) {
      return JSON.stringify({ ok: true, matched: loadReady, readyState: ready, title: document.title, url: location.href });
    }
    let el = null;
    try { el = document.querySelector(selector); }
    catch (error) { return JSON.stringify({ ok: false, error: "invalid selector: " + String(error && error.message || error) }); }
    let elementReady = false;
    if (state === "attached") elementReady = Boolean(el);
    else if (state === "detached") elementReady = !el;
    else {
      let visible = false;
      if (el) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      }
      elementReady = state === "hidden" ? !visible : visible;
    }
    return JSON.stringify({
      ok: true,
      matched: Boolean(elementReady && loadReady),
      readyState: ready,
      title: document.title,
      url: location.href,
      found: Boolean(el)
    });
  })()`;
}

/** Serialize an arbitrary JS value inside the page, tolerating DOM/circular values. */
const EVAL_WRAPPER_PREFIX = `(async () => {
  try {
    const __dshValue = await (`;
const EVAL_WRAPPER_SUFFIX = `);
    const __dshSeen = new WeakSet();
    const __dshJson = JSON.stringify(__dshValue, (key, value) => {
      if (typeof value === "bigint") return String(value) + "n";
      if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
      if (typeof value === "symbol") return String(value);
      if (value instanceof Node) {
        return {
          nodeType: value.nodeType,
          nodeName: value.nodeName,
          id: value.id || undefined,
          text: String(value.textContent || "").slice(0, 500)
        };
      }
      if (value === window) return "[Window]";
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (value && typeof value === "object") {
        if (__dshSeen.has(value)) return "[Circular]";
        __dshSeen.add(value);
      }
      return value;
    });
    return JSON.stringify({
      ok: true,
      type: typeof __dshValue,
      value: __dshJson === undefined ? null : JSON.parse(__dshJson)
    });
  } catch (__dshError) {
    return JSON.stringify({
      ok: false,
      error: String(__dshError && (__dshError.stack || __dshError.message) || __dshError)
    });
  }
})()`;

/** @param {string} expression */
function wrapUserExpression(expression) {
  return `${EVAL_WRAPPER_PREFIX}${expression}${EVAL_WRAPPER_SUFFIX}`;
}

/**
 * Resolve a tab id and return a stable failure for stale ids.
 * @param {Array<{tabId: string}>} tabs
 */
function describeTabs(tabs) {
  if (tabs.length === 0) return "no tabs";
  return tabs.map((tab) => `${tab.tabId}${tab.url ? ` (${tab.url})` : ""}`).join(", ");
}

export class FirefoxOperator {
  /**
   * @param {Record<string, unknown>} [config]
   * @param {{client?: BidiClient, spawnImpl?: typeof spawn, now?: () => number}} [deps]
   */
  constructor(config = {}, deps = {}) {
    this.config = resolveConfig(config);
    this.client = deps.client ?? new BidiClient({
      connectTimeoutMs: this.config.launchTimeoutMs,
      commandTimeoutMs: this.config.commandTimeoutMs,
    });
    this.spawnImpl = deps.spawnImpl ?? spawn;
    this.now = deps.now ?? (() => Date.now());
    this.child = null;
    this.childPid = null;
    this.connection = null;
    this.activeTabId = null;
    this._titleCache = new Map();
    this._queue = Promise.resolve();
    this._disposed = false;
  }

  /**
   * Serialize one public operation. Commands must not interleave on a single
   * BiDi stream, and serialization also makes launch/reconnect atomic.
   *
   * @template T
   * @param {() => Promise<T>} fn
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  _run(fn, signal) {
    if (this._disposed) {
      return Promise.reject(new FirefoxOperatorError("PLUGIN_DISPOSED", "Firefox Operator was unloaded"));
    }
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => undefined, () => undefined);
    if (!signal) return run;
    if (signal.aborted) {
      return Promise.reject(new FirefoxOperatorError("ABORTED", "operation cancelled before it started"));
    }
    return new Promise((resolveRun, rejectRun) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        rejectRun(new FirefoxOperatorError("ABORTED", "operation cancelled by caller"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolveRun(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          rejectRun(error);
        },
      );
    });
  }

  /** @param {{signal?: AbortSignal}} [options] */
  async launch(options = {}, signal = options.signal) {
    return this._run(async () => {
      const wasConnected = this.client.connected;
      await this._ensure(options, signal);
      if (options.url) {
        await this._navigateInternal(String(options.url), undefined, false, normalizeWaitUntil(options.waitUntil), signal);
      }
      const status = await this._statusInternal(signal);
      return {
        ...status,
        launched: Boolean(this.childPid) && !status.external,
        alreadyConnected: wasConnected,
      };
    }, signal);
  }

  /** @param {{signal?: AbortSignal}} [options] */
  async status(options = {}, signal = options.signal) {
    return this._run(() => this._statusInternal(signal), signal);
  }

  /**
   * @param {{action?: "list"|"new"|"switch"|"close", tabId?: string, url?: string, waitUntil?: string}} [options]
   * @param {AbortSignal} [signal]
   */
  async tabs(options = {}, signal) {
    return this._run(async () => {
      this._requireConnected();
      const action = options.action ?? "list";
      if (action === "list") {
        const state = await this._tabsState(signal, { titles: true });
        return { action, tabs: state.tabs, activeTabId: state.activeTabId };
      }
      if (action === "new") {
        const tabId = await this._createTab(signal);
        this.activeTabId = tabId;
        if (options.url) {
          await this._navigateInternal(String(options.url), tabId, false, normalizeWaitUntil(options.waitUntil), signal);
        }
        const state = await this._tabsState(signal, { titles: true });
        return { action, created: tabId, tabs: state.tabs, activeTabId: state.activeTabId };
      }
      if (action === "switch") {
        if (!options.tabId) throw new FirefoxOperatorError("TAB_ID_REQUIRED", "firefox_tabs action=switch needs tab_id");
        const state = await this._tabsState(signal);
        const target = state.tabs.find((tab) => tab.tabId === options.tabId);
        if (!target) {
          throw new FirefoxOperatorError(
            "NO_SUCH_TAB",
            `tab ${options.tabId} is not open (open tabs: ${describeTabs(state.tabs)})`,
            { hint: "Call firefox_tabs action=list and use a current tab_id." },
          );
        }
        try {
          await this.client.send("browsingContext.activate", { context: options.tabId }, { signal });
        } catch (error) {
          // Some Firefox builds do not implement activate; targeting a context
          // explicitly still works, so report the selected tab instead of failing.
          if (!/unknown command|unsupported operation|not implemented/i.test(String(error?.message))) throw error;
        }
        this.activeTabId = options.tabId;
        const updated = await this._tabsState(signal, { titles: true });
        return { action, switched: options.tabId, tabs: updated.tabs, activeTabId: updated.activeTabId };
      }
      if (action === "close") {
        const tabId = options.tabId ?? this.activeTabId;
        if (!tabId) throw new FirefoxOperatorError("TAB_ID_REQUIRED", "firefox_tabs action=close needs a tab_id or an active tab");
        await this._closeTab(tabId, signal);
        // Closing the last window may take the whole Firefox down; the close
        // itself succeeded, so report an empty tab list instead of a bogus error.
        const state = this.client.connected
          ? await this._tabsState(signal, { titles: true })
          : { tabs: [], activeTabId: null };
        return { action, closed: tabId, tabs: state.tabs, activeTabId: state.activeTabId };
      }
      throw new FirefoxOperatorError("INVALID_ACTION", `unknown firefox_tabs action: ${action}`);
    }, signal);
  }

  /**
   * @param {string} url
   * @param {{tabId?: string, newTab?: boolean, waitUntil?: string, timeoutMs?: number}} [options]
   * @param {AbortSignal} [signal]
   */
  async navigate(url, options = {}, signal) {
    return this._run(() => this._navigateInternal(url, options.tabId, options.newTab === true, normalizeWaitUntil(options.waitUntil), signal, options.timeoutMs), signal);
  }

  /**
   * @param {{tabId?: string, selector?: string, includeHtml?: boolean, maxChars?: number}} [options]
   * @param {AbortSignal} [signal]
   */
  async read(options = {}, signal) {
    return this._run(async () => {
      const tabId = await this._resolveTab(options.tabId, signal);
      const maxChars = Math.min(Math.max(options.maxChars ?? 30_000, 1), this.config.maxReadChars);
      const page = await this._evaluateJson(tabId, readExpression(options.selector, options.includeHtml, maxChars), signal);
      if (!page?.ok) {
        throw new FirefoxOperatorError(
          "PAGE_READ_FAILED",
          page?.error ?? "could not read the page",
          { hint: "Check the selector and that the page is not a privileged about: page." },
        );
      }
      return {
        tabId,
        url: page.url,
        title: page.title,
        readyState: page.readyState,
        tag: page.tag,
        text: page.text,
        textTruncated: page.textTruncated === true,
        ...(options.includeHtml === true ? { html: page.html, htmlTruncated: page.htmlTruncated === true } : {}),
      };
    }, signal);
  }

  /**
   * @param {{tabId?: string, selector?: string, text?: string, index?: number}} options
   * @param {AbortSignal} [signal]
   */
  async click(options = {}, signal) {
    return this._run(async () => {
      if (!options.selector && !options.text) {
        throw new FirefoxOperatorError("INVALID_ARGS", "firefox_click needs selector or text");
      }
      const tabId = await this._resolveTab(options.tabId, signal);
      const target = await this._evaluateJson(tabId, locatorExpression(options.selector, options.text, options.index), signal);
      if (!target?.ok) {
        throw new FirefoxOperatorError(
          "ELEMENT_NOT_FOUND",
          target?.error ?? "could not locate the element",
          { hint: "Use firefox_read or firefox_eval to inspect the page before clicking." },
        );
      }
      if (target.disabled) {
        throw new FirefoxOperatorError("ELEMENT_DISABLED", "the target element is disabled");
      }
      if (!target.visible) {
        throw new FirefoxOperatorError("ELEMENT_NOT_VISIBLE", "the target element has no visible box");
      }

      let method = "pointer";
      try {
        await this.client.send("input.performActions", {
          context: tabId,
          actions: [{
            type: "pointer",
            id: "dsh-firefox-pointer",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", x: target.x, y: target.y, origin: "viewport" },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          }],
        }, { signal });
      } catch (error) {
        const message = String(error?.message ?? error);
        if (!/unknown command|unsupported operation|not implemented|invalid argument/i.test(message)) throw error;
        const fallback = await this._evaluateJson(tabId, domClickExpression(options.selector, options.text, options.index), signal);
        if (!fallback?.ok) {
          throw new FirefoxOperatorError("CLICK_FAILED", fallback?.error ?? "pointer and DOM click both failed");
        }
        method = "dom";
      }
      await delay(120, signal);
      const state = await this._tabsState(signal);
      const current = state.tabs.find((tab) => tab.tabId === tabId) ?? { tabId, url: "", title: "" };
      const title = await this._titleForTab(tabId, signal);
      if (title !== null) current.title = title;
      return {
        tabId,
        url: current.url,
        title: current.title,
        method,
        clicked: {
          selector: options.selector ?? null,
          text: options.text ?? null,
          tag: target.tag,
          textPreview: target.text,
          point: { x: Math.round(target.x), y: Math.round(target.y) },
          covered: target.covered === true,
          coveredBy: target.coveredBy ?? null,
        },
      };
    }, signal);
  }

  /**
   * @param {{tabId?: string, selector: string, value: string, submit?: boolean}} options
   * @param {AbortSignal} [signal]
   */
  async fill(options = {}, signal) {
    return this._run(async () => {
      if (!options.selector) throw new FirefoxOperatorError("INVALID_ARGS", "firefox_fill needs selector");
      const tabId = await this._resolveTab(options.tabId, signal);
      const page = await this._evaluateJson(tabId, fillExpression(options.selector, options.value ?? "", options.submit === true), signal);
      if (!page?.ok) {
        throw new FirefoxOperatorError(
          "FILL_FAILED",
          page?.error ?? "could not fill the element",
          { hint: "Check that the selector targets an input, textarea, select, or contenteditable element." },
        );
      }
      const state = await this._tabsState(signal);
      const current = state.tabs.find((tab) => tab.tabId === tabId) ?? { tabId, url: "", title: "" };
      const title = await this._titleForTab(tabId, signal);
      if (title !== null) current.title = title;
      return {
        tabId,
        url: current.url,
        title: current.title,
        filled: {
          selector: options.selector,
          tag: page.tag,
          type: page.type,
          valueLength: String(options.value ?? "").length,
          submitted: page.submitted === true,
          formAction: page.formAction ?? null,
        },
      };
    }, signal);
  }

  /**
   * @param {{tabId?: string, expression: string, awaitPromise?: boolean}} options
   * @param {AbortSignal} [signal]
   */
  async evaluate(options = {}, signal) {
    return this._run(async () => {
      if (!options.expression || !String(options.expression).trim()) {
        throw new FirefoxOperatorError("INVALID_ARGS", "firefox_eval needs a non-empty expression");
      }
      const tabId = await this._resolveTab(options.tabId, signal);
      const wrapped = wrapUserExpression(String(options.expression));
      const page = await this._evaluateJson(tabId, wrapped, signal, { awaitPromise: options.awaitPromise !== false, timeoutMs: this.config.commandTimeoutMs });
      const state = await this._tabsState(signal);
      const current = state.tabs.find((tab) => tab.tabId === tabId) ?? { tabId, url: "", title: "" };
      const title = await this._titleForTab(tabId, signal);
      if (title !== null) current.title = title;
      if (!page?.ok) {
        return {
          tabId,
          url: current.url,
          title: current.title,
          ok: false,
          resultType: null,
          result: null,
          error: String(page?.error ?? "the page expression threw"),
        };
      }
      return {
        tabId,
        url: current.url,
        title: current.title,
        ok: true,
        resultType: page.type ?? "unknown",
        result: page.value ?? null,
        error: null,
      };
    }, signal);
  }

  /**
   * @param {{tabId?: string, selector?: string, state?: "attached"|"detached"|"visible"|"hidden", loadState?: "none"|"interactive"|"complete", timeoutMs?: number}} options
   * @param {AbortSignal} [signal]
   */
  async wait(options = {}, signal) {
    return this._run(async () => {
      const tabId = await this._resolveTab(options.tabId, signal);
      const selector = options.selector ?? null;
      const state = options.state ?? "visible";
      const loadState = options.loadState ?? (selector ? "none" : "complete");
      if (!["attached", "detached", "visible", "hidden"].includes(state)) {
        throw new FirefoxOperatorError("INVALID_ARGS", `unknown wait state: ${state}`);
      }
      if (!["none", "interactive", "complete"].includes(loadState)) {
        throw new FirefoxOperatorError("INVALID_ARGS", `unknown load_state: ${loadState}`);
      }
      const timeoutMs = Math.min(Math.max(options.timeoutMs ?? this.config.defaultWaitMs, 100), 180_000);
      const started = this.now();
      const expression = waitExpression(selector, state, loadState);
      let last = null;
      while (this.now() - started < timeoutMs) {
        if (signal?.aborted) throw new FirefoxOperatorError("ABORTED", "wait cancelled");
        try {
          last = await this._evaluateJson(tabId, expression, signal, { timeoutMs: Math.min(5000, timeoutMs) });
        } catch (error) {
          if (error?.code === "ABORTED") throw error;
          // A navigation can destroy the realm between polls; retry until the deadline.
          last = { ok: false, error: error?.message ?? String(error) };
        }
        if (last?.ok && last.matched) {
          return {
            tabId,
            matched: true,
            condition: selector ? `selector ${selector} is ${state}` : `document.readyState is ${loadState}`,
            elapsedMs: this.now() - started,
            url: last.url ?? null,
            title: last.title ?? null,
          };
        }
        if (last && last.ok !== true && last.error && /invalid selector/i.test(String(last.error))) {
          throw new FirefoxOperatorError("INVALID_SELECTOR", String(last.error));
        }
        await delay(150, signal);
      }
      const detail = last?.ok === false ? `; last page error: ${last.error}` : "";
      throw new FirefoxOperatorError(
        "WAIT_TIMEOUT",
        `timed out after ${timeoutMs} ms waiting for ${selector ? `selector ${selector} to be ${state}` : `document.readyState=${loadState}`}${detail}`,
        { hint: "Increase timeout_ms, or inspect the page with firefox_read." },
      );
    }, signal);
  }

  /**
   * @param {{target?: "tab"|"browser"|"disconnect", tabId?: string}} options
   * @param {AbortSignal} [signal]
   */
  async close(options = {}, signal) {
    return this._run(async () => {
      const target = options.target ?? "tab";
      if (target === "tab") {
        const tabId = options.tabId ?? this.activeTabId;
        if (!tabId) throw new FirefoxOperatorError("TAB_ID_REQUIRED", "firefox_close target=tab needs a tab_id or active tab");
        await this._closeTab(tabId, signal);
        const state = this.client.connected
          ? await this._tabsState(signal, { titles: true })
          : { tabs: [], activeTabId: null };
        return { target, closed: tabId, tabs: state.tabs, activeTabId: state.activeTabId };
      }
      if (target === "disconnect") {
        await this.client.endSession("disconnected by firefox_close");
        return { target, closed: "websocket", tabs: [], activeTabId: null };
      }
      if (target === "browser") {
        const wasConnected = this.client.connected;
        if (wasConnected) {
          try {
            await this.client.send("browser.close", {}, { timeoutMs: 5000, signal });
          } catch (error) {
            if (error?.code !== "DISCONNECTED") {
              // Fall through to killing only a process this plugin owns.
              this._lastCloseError = error;
            }
          }
        }
        this.client.close("browser closed");
        this._killOwned();
        this.connection = null;
        this.activeTabId = null;
        return { target, closed: "browser", tabs: [], activeTabId: null };
      }
      throw new FirefoxOperatorError("INVALID_ARGS", `unknown firefox_close target: ${target}`);
    }, signal);
  }

  /**
   * Release the BiDi session so a later plugin activation can attach to the
   * same Firefox. Returned so an effect cleanup can await it when supported.
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      await this.client.endSession("plugin disposed");
    } catch {
      // teardown must not throw
    }
    if (this.config.killOnDispose) this._killOwned();
  }

  /** @param {{port?: number, headless?: boolean, attachOnly?: boolean, url?: string, waitUntil?: string}} options */
  async _ensure(options = {}, signal) {
    if (this._disposed) throw new FirefoxOperatorError("PLUGIN_DISPOSED", "Firefox Operator was unloaded");
    if (this.client.connected) return;

    const attachOnly = options.attachOnly === true || this.config.attachOnly;
    let requestedPort = options.port ?? this.connection?.port ?? this.config.port;
    if (requestedPort !== undefined && requestedPort !== null && requestedPort !== 0) {
      requestedPort = Number(requestedPort);
      if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
        throw new FirefoxOperatorError("INVALID_ARGS", `port must be an integer between 1 and 65535`);
      }

      if (await isPortOpen(requestedPort)) {
        const external = !this._ownsProcessOn(requestedPort);
        const mayAttach = !external || this.config.connectExisting || attachOnly || options.port !== undefined;
        if (!mayAttach) {
          throw new FirefoxOperatorError(
            "PORT_IN_USE",
            `port ${requestedPort} is already in use`,
            { hint: "Choose another port or close the process that owns it." },
          );
        }
        try {
          await this._connect(requestedPort, { external, initial: true }, signal);
          return;
        } catch (error) {
          const staleOwnedSession = !external
            && !attachOnly
            && /maximum number of active sessions/i.test(String(error?.message ?? ""));
          if (staleOwnedSession) {
            // A previous plugin generation dropped its WebSocket without
            // session.end. Restart the Firefox this plugin owns to clear it.
            this._killOwned();
            this.connection = null;
          } else {
            throw new FirefoxOperatorError(
              attachOnly ? "FIREFOX_NOT_REACHABLE" : "PORT_IN_USE",
              `port ${requestedPort} is open but did not accept a Firefox BiDi session: ${error.message}`,
              {
                hint: attachOnly
                  ? "Confirm this is Firefox launched with --remote-debugging-port and that no other BiDi client is attached."
                  : /maximum number of active sessions/i.test(String(error?.message ?? ""))
                    ? "Another BiDi client still holds the only session; restart that Firefox or close the other client."
                    : "Choose another port, or stop the other process that owns this port.",
                cause: error,
              },
            );
          }
        }
      }

      if (attachOnly) {
        throw new FirefoxOperatorError(
          "FIREFOX_NOT_REACHABLE",
          `no Firefox WebDriver BiDi endpoint on 127.0.0.1:${requestedPort}`,
          { hint: "Start Firefox with --remote-debugging-port=<port>, then retry with attach_only=true." },
        );
      }
      if (this.connection?.external) {
        throw new FirefoxOperatorError(
          "FIREFOX_NOT_REACHABLE",
          `the attached Firefox on port ${requestedPort} is no longer running`,
          { hint: "Start it again with --remote-debugging-port, or call firefox_launch without attach_only to let the plugin launch one." },
        );
      }
    } else if (attachOnly) {
      throw new FirefoxOperatorError(
        "FIREFOX_NOT_REACHABLE",
        "attach_only=true but no port was given and no previous connection exists",
        { hint: "Start Firefox with --remote-debugging-port=<port> and pass that port." },
      );
    }

    const firefoxPath = findFirefoxPath(this.config.firefoxPath);
    const port = requestedPort && requestedPort !== 0 ? requestedPort : await getFreePort();
    const headless = options.headless ?? this.config.headless;
    const profileDir = ensureProfilePrefs(this.config.profileDir);
    await this._spawnAndWait(firefoxPath, port, profileDir, headless === true, signal);

    // The remote agent's WebSocket can accept a connection slightly after the
    // listening socket opens. Retry the BiDi handshake instead of treating the
    // first race as a fingerprint of the port owner.
    const handshakeDeadline = this.now() + Math.min(15_000, this.config.launchTimeoutMs);
    let lastError = null;
    while (this.now() < handshakeDeadline) {
      try {
        await this._connect(port, { external: false, initial: true }, signal);
        return;
      } catch (error) {
        lastError = error;
        await delay(250, signal);
      }
    }
    this._killOwned();
    throw new FirefoxOperatorError(
      "FIREFOX_BIDI_HANDSHAKE_FAILED",
      `Firefox opened 127.0.0.1:${port} but the BiDi session did not establish: ${lastError?.message ?? "unknown error"}`,
      {
        hint: `Profile: ${profileDir}. Check that Firefox is 153 ESR and that --remote-debugging-port is allowed.`,
        cause: lastError,
      },
    );
  }

  /** @param {number} port */
  _ownsProcessOn(port) {
    return Boolean(
      this.child
      && this.child.exitCode === null
      && this.childPid
      && this.connection?.port === port,
    );
  }

  /**
   * Connect to one Firefox BiDi endpoint.
   *
   * @param {number} port
   * @param {{external: boolean, initial?: boolean}} meta
   * @param {AbortSignal} [signal]
   */
  async _connect(port, meta, signal) {
    const webSocketUrl = `ws://127.0.0.1:${port}/session`;
    let session;
    try {
      session = await this.client.connect(webSocketUrl, {
        signal,
        // The listening socket can open several seconds before the remote
        // agent's WebSocket handshake is ready, especially on a first profile.
        connectTimeoutMs: meta.initial ? 12_000 : 10_000,
        sessionTimeoutMs: meta.initial ? 15_000 : Math.max(this.config.commandTimeoutMs, 15_000),
      });
    } catch (error) {
      throw fromBidiError("session.new", error);
    }
    const capabilities = session?.capabilities ?? {};
    this.connection = {
      port,
      webSocketDebuggerUrl: webSocketUrl,
      browser: typeof capabilities.browserName === "string" ? capabilities.browserName : "firefox",
      protocolVersion: null,
      browserVersion: typeof capabilities.browserVersion === "string" ? capabilities.browserVersion : null,
      firefoxPid: typeof capabilities["moz:processID"] === "number" ? capabilities["moz:processID"] : null,
      external: meta.external,
    };
    this._titleCache.clear();
    this.activeTabId = null;
    try {
      await this._tabsState(signal);
    } catch (error) {
      this.client.close("initial tab enumeration failed");
      throw fromBidiError("browsingContext.getTree", error);
    }
  }

  /**
   * @param {string} firefoxPath
   * @param {number} port
   * @param {string} profileDir
   * @param {boolean} headless
   */
  async _spawnAndWait(firefoxPath, port, profileDir, headless, signal) {
    const args = [
      "--no-remote",
      "--new-instance",
      `--remote-debugging-port=${port}`,
      "--remote-allow-hosts=127.0.0.1,localhost",
      "--profile",
      profileDir,
    ];
    if (headless) args.push("--headless");
    args.push("about:blank");

    let stderr = "";
    let launchError = null;
    /** @type {import("node:child_process").ChildProcess | null} */
    const child = this.spawnImpl(firefoxPath, args, {
      detached: true,
      windowsHide: headless,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
    });
    this.child = child;
    this.childPid = child.pid ?? null;
    this._lastCloseError = null;
    child.once("error", (error) => {
      launchError = error;
    });
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
      });
    }
    child.once("exit", (code, exitSignal) => {
      if (this.child === child) {
        this.childExit = { code, signal: exitSignal };
      }
    });
    try {
      child.unref();
    } catch {
      // Not fatal; the event handlers still work.
    }

    try {
      await waitForFirefoxPort(port, {
        timeoutMs: this.config.launchTimeoutMs,
        signal,
        isAlive: () => {
          if (launchError) return false;
          return child.exitCode === null;
        },
      });
      return true;
    } catch (error) {
      this._killOwned();
      const detail = stderr.trim() ? `\nFirefox stderr:\n${stderr.trim().slice(-4000)}` : "";
      const processDetail = launchError ? `\nspawn error: ${launchError.message}` : "";
      throw new FirefoxOperatorError(
        error.code ?? "FIREFOX_LAUNCH_FAILED",
        `${error.message}${processDetail}${detail}`,
        {
          hint: `Profile: ${profileDir}. Ensure no other Firefox uses this profile and that firefox.exe can start.`,
          details: { firefoxPath, port, profileDir },
        },
      );
    }
  }

  _killOwned() {
    const pid = this.childPid;
    const child = this.child;
    this.child = null;
    this.childPid = null;
    if (!pid || !child || child.exitCode !== null) return;
    try {
      if (WINDOWS) {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // Best-effort cleanup only.
    }
  }

  _requireConnected() {
    if (!this.client.connected) {
      throw new FirefoxOperatorError(
        "NOT_CONNECTED",
        "Firefox is not connected",
        { hint: "Call firefox_launch first." },
      );
    }
  }

  /**
   * @param {AbortSignal} [signal]
   * @param {{titles?: boolean}} [options]
   */
  async _tabsState(signal, options = {}) {
    this._requireConnected();
    const result = await this.client.send("browsingContext.getTree", { maxDepth: 1 }, { signal });
    const contexts = Array.isArray(result?.contexts) ? result.contexts : [];
    const tabs = contexts
      .filter((context) => context && typeof context.context === "string")
      .map((context) => ({
        tabId: context.context,
        url: typeof context.url === "string" ? context.url : "about:blank",
        // Firefox's browsingContext.getTree does not include a title field;
        // hydrate from the page below.
        title: typeof context.title === "string" ? context.title : "",
        type: typeof context.type === "string" ? context.type : "tab",
      }));
    if (tabs.length > 0 && !tabs.some((tab) => tab.tabId === this.activeTabId)) {
      this.activeTabId = tabs[0].tabId;
    }
    if (tabs.length === 0) this.activeTabId = null;
    if (options.titles === true) {
      for (const tab of tabs) {
        const title = await this._titleForTab(tab.tabId, signal);
        if (title !== null) tab.title = title;
      }
    }
    const liveTabs = new Set(tabs.map((tab) => tab.tabId));
    for (const tabId of this._titleCache.keys()) {
      if (!liveTabs.has(tabId)) this._titleCache.delete(tabId);
    }
    return { tabs, activeTabId: this.activeTabId, raw: result };
  }

  /**
   * Read document.title from one tab. This is the only way to get a tab title
   * from Firefox 153 ESR's getTree response. Failures are non-fatal: a
   * privileged page or a tab mid-navigation simply has an empty title.
   *
   * @param {string} tabId
   * @param {AbortSignal} [signal]
   * @returns {Promise<string | null>}
   */
  async _titleForTab(tabId, signal) {
    try {
      const result = await this.client.send("script.evaluate", {
        expression: "document.title",
        target: { context: tabId },
        awaitPromise: false,
        resultOwnership: "none",
      }, { timeoutMs: 1500, signal });
      if (result?.type === "success" && result.result?.type === "string") {
        const title = result.result.value;
        this._titleCache.set(tabId, title);
        return title;
      }
    } catch {
      // Tabs mid-navigation or privileged about: pages can reject evaluation.
    }
    return this._titleCache.get(tabId) ?? null;
  }

  /** @param {AbortSignal} [signal] */
  async _statusInternal(signal) {
    const connected = this.client.connected;
    let tabs = [];
    let activeTabId = null;
    if (connected) {
      try {
        const state = await this._tabsState(signal, { titles: true });
        tabs = state.tabs;
        activeTabId = state.activeTabId;
      } catch {
        // A status call must not crash the session because the browser vanished;
        // the next operation reports the actionable DISCONNECTED error.
      }
    }
    return {
      connected,
      port: this.connection?.port ?? null,
      webSocketUrl: this.connection?.webSocketDebuggerUrl ?? null,
      browser: this.connection?.browser ?? null,
      protocolVersion: this.connection?.protocolVersion ?? null,
      external: this.connection?.external ?? null,
      firefoxPid: this.childPid ?? this.connection?.firefoxPid ?? null,
      activeTabId,
      tabs,
    };
  }

  /** @param {string | undefined} tabId @param {AbortSignal} [signal] */
  async _resolveTab(tabId, signal) {
    const state = await this._tabsState(signal);
    if (tabId) {
      if (!state.tabs.some((tab) => tab.tabId === tabId)) {
        throw new FirefoxOperatorError(
          "NO_SUCH_TAB",
          `tab ${tabId} is not open (open tabs: ${describeTabs(state.tabs)})`,
          { hint: "Call firefox_tabs action=list and retry with a current tab_id." },
        );
      }
      this.activeTabId = tabId;
      return tabId;
    }
    if (this.activeTabId && state.tabs.some((tab) => tab.tabId === this.activeTabId)) return this.activeTabId;
    if (state.tabs.length > 0) {
      this.activeTabId = state.tabs[0].tabId;
      return this.activeTabId;
    }
    return this._createTab(signal);
  }

  /** @param {AbortSignal} [signal] */
  async _createTab(signal) {
    try {
      const result = await this.client.send("browsingContext.create", { type: "tab", background: false }, { signal });
      if (typeof result?.context === "string") {
        this.activeTabId = result.context;
        return result.context;
      }
      throw new FirefoxOperatorError("TAB_CREATE_FAILED", "browsingContext.create returned no context id");
    } catch (error) {
      if (/invalid argument|unknown command|unsupported operation/i.test(String(error?.message))) {
        const retry = await this.client.send("browsingContext.create", { type: "tab" }, { signal });
        if (typeof retry?.context === "string") {
          this.activeTabId = retry.context;
          return retry.context;
        }
      }
      throw error;
    }
  }

  /** @param {string} tabId @param {AbortSignal} [signal] */
  async _closeTab(tabId, signal) {
    const state = await this._tabsState(signal);
    if (!state.tabs.some((tab) => tab.tabId === tabId)) {
      throw new FirefoxOperatorError("NO_SUCH_TAB", `tab ${tabId} is not open`, {
        hint: "Call firefox_tabs action=list and retry with a current tab_id.",
      });
    }
    await this.client.send("browsingContext.close", { context: tabId }, { signal });
    if (this.activeTabId === tabId) this.activeTabId = null;
  }

  /**
   * @param {string} url
   * @param {string | undefined} tabId
   * @param {boolean} newTab
   * @param {string} waitUntil
   * @param {AbortSignal} [signal]
   * @param {number} [timeoutMs]
   */
  async _navigateInternal(url, tabId, newTab, waitUntil, signal, timeoutMs) {
    if (typeof url !== "string" || url.trim() === "") {
      throw new FirefoxOperatorError("INVALID_ARGS", "url must be a non-empty string");
    }
    const target = newTab ? await this._createTab(signal) : await this._resolveTab(tabId, signal);
    this.activeTabId = target;
    try {
      await this.client.send("browsingContext.navigate", {
        context: target,
        url,
        wait: waitUntil,
      }, {
        timeoutMs: timeoutMs ?? this.config.navigationTimeoutMs,
        signal,
      });
    } catch (error) {
      throw fromBidiError("browsingContext.navigate", error);
    }
    const state = await this._tabsState(signal);
    const current = state.tabs.find((tab) => tab.tabId === target) ?? { tabId: target, url, title: "" };
    const title = await this._titleForTab(target, signal);
    if (title !== null) current.title = title;
    return {
      tabId: target,
      url: current.url,
      title: current.title,
      requestedUrl: url,
      waitUntil,
    };
  }

  /**
   * Evaluate page code whose JavaScript returns a JSON string.
   *
   * @param {string} tabId
   * @param {string} expression
   * @param {AbortSignal} [signal]
   * @param {{awaitPromise?: boolean, timeoutMs?: number}} [options]
   */
  async _evaluateJson(tabId, expression, signal, options = {}) {
    const result = await this.client.send("script.evaluate", {
      expression,
      target: { context: tabId },
      awaitPromise: options.awaitPromise !== false,
      resultOwnership: "none",
    }, {
      timeoutMs: options.timeoutMs ?? this.config.commandTimeoutMs,
      signal,
    });
    if (!result || result.type === "exception") {
      const detail = result?.exceptionDetails?.text
        ?? result?.exceptionDetails?.exception?.description
        ?? "page JavaScript threw an exception";
      throw new FirefoxOperatorError("PAGE_SCRIPT_EXCEPTION", String(detail), {
        hint: "Check the expression or selector, and confirm the page is not a privileged about: page.",
      });
    }
    if (result.type !== "success") {
      throw new FirefoxOperatorError("PAGE_SCRIPT_FAILED", `script.evaluate returned ${JSON.stringify(result?.type)}`);
    }
    const value = remoteValueToJs(result.result);
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (error) {
        throw new FirefoxOperatorError(
          "PAGE_BRIDGE_ERROR",
          `page returned non-JSON data: ${value.slice(0, 300)}`,
          { cause: error },
        );
      }
    }
    return value;
  }
}
