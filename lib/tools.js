/**
 * Agent-facing tools for the Firefox Operator plugin.
 *
 * These are deliberately ordinary ToolDefinition objects (not imported
 * helpers): the plugin has no runtime package dependencies, so it resolves in a
 * linked dsh profile without installing a copy of @deepseek-ai/dsh-tools.
 */

const text = (value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];

/** @param {any} value */
function renderRead(value) {
  const lines = [
    `Title: ${value.title}`,
    `URL: ${value.url}`,
    `Ready: ${value.readyState}   Element: <${value.tag}>   Text chars: ${value.text.length}${value.textTruncated ? " (truncated)" : ""}`,
    "",
    value.text || "(no visible text)",
  ];
  if (value.html !== undefined) {
    lines.push("", `--- DOM HTML (${value.tag})${value.htmlTruncated ? ", truncated" : ""} ---`, value.html);
  }
  if (Array.isArray(value.links) && value.links.length > 0) {
    lines.push("", `--- Links (${value.links.length}${value.linksTruncated ? "+" : ""}) ---`);
    for (const link of value.links.slice(0, 30)) lines.push(`- ${link.text} -> ${link.href}`);
    if (value.links.length > 30) lines.push(`- … ${value.links.length - 30} more links (increase max_chars or read a selector)`);
  }
  return [{ type: "text", text: lines.join("\n") }];
}

/** @param {any} value */
function renderWait(value) {
  return [{
    type: "text",
    text: `Matched: ${value.condition} after ${value.elapsedMs} ms\nURL: ${value.url ?? "?"}\nTitle: ${value.title ?? "?"}`,
  }];
}

/** @param {any} value */
function renderScreenshot(value) {
  return [{
    type: "text",
    text: `Screenshot saved: ${value.path}\nURL: ${value.url}\nTitle: ${value.title}\nImage: ${value.mimeType}, ${value.bytes} bytes${value.width && value.height ? `, ${value.width}x${value.height} px` : ""}\nRead it with read_image({ path: ${JSON.stringify(value.path)} }).`,
  }];
}

const nullableString = { oneOf: [{ type: "string" }, { type: "null" }] };
const nullableInteger = { oneOf: [{ type: "integer" }, { type: "null" }] };

const tabSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tabId", "url", "title", "type"],
  properties: {
    tabId: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    type: { type: "string" },
  },
};

const tabsField = { type: "array", required: true, items: tabSchema };

const tabIdParam = {
  type: "string",
  description: "Target tab id from firefox_tabs. Omit to use the active tab.",
};

/**
 * The authoring shorthand `required: true` on a property is not a JSON Schema
 * keyword. Strip it recursively and rely on each object's `required` array.
 * @param {any} node
 */
function normalizeSchema(node) {
  if (Array.isArray(node)) return node.map((item) => normalizeSchema(item));
  if (node === null || typeof node !== "object") return node;
  const normalized = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "required" && typeof value === "boolean") continue;
    if (key === "required" && Array.isArray(value)) {
      normalized[key] = value;
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      normalized[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, normalizeSchema(schema)]),
      );
      continue;
    }
    if (key === "items") {
      normalized[key] = normalizeSchema(value);
      continue;
    }
    if (key === "oneOf" && Array.isArray(value)) {
      normalized[key] = value.map((item) => normalizeSchema(item));
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

/**
 * @param {{name: string, description: string, parameters: Record<string, any>, output: object, execute: Function, timeoutMs?: number, render?: Function}} definition
 */
function tool(definition) {
  const required = [];
  const properties = {};
  for (const [name, schema] of Object.entries(definition.parameters)) {
    if (schema?.required === true) required.push(name);
    properties[name] = normalizeSchema(schema);
  }
  return {
    name: definition.name,
    description: definition.description,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required }),
    },
    output: {
      schema: normalizeSchema(definition.output),
      render: definition.render ?? ((_args, value) => text(value)),
    },
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    execute: definition.execute,
  };
}

/**
 * Build the ten tools.
 * @param {import("./firefox.js").FirefoxOperator} operator
 */
export function createFirefoxTools(operator) {
  return [
    tool({
      name: "firefox_launch",
      description: "Start Firefox 153 ESR with its WebDriver BiDi remote agent, or attach to an already running Firefox that was started with --remote-debugging-port. Use this first, before tabs, navigation, or page tools. With no port it selects a free loopback port and launches a dedicated profile; pass port to attach to an existing remote agent, and attach_only to refuse spawning. On Windows the plugin defaults to launching through WMI so Firefox escapes dsh Host's job/restricted environment; launchMethod reports \"wmi\" or \"direct\". 中文触发词：启动 Firefox、连接浏览器。",
      parameters: {
        url: {
          type: "string",
          description: "Optional URL to open after connecting. The current tab is reused when one exists.",
        },
        headless: {
          type: "boolean",
          description: "Launch without a visible window. Defaults to the plugin config (true). Ignored when attaching.",
        },
        port: {
          type: "integer",
          description: "Existing BiDi port to attach to, or the port to launch on. Omit to reuse the last port or select a free one.",
        },
        attach_only: {
          type: "boolean",
          description: "When true, never spawn Firefox; fail unless an existing BiDi endpoint answers on the requested port.",
        },
        wait_until: {
          type: "string",
          enum: ["none", "interactive", "complete"],
          description: "Navigation wait mode when url is given. Defaults to complete.",
        },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["connected", "port", "webSocketUrl", "browser", "protocolVersion", "external", "firefoxPid", "activeTabId", "tabs", "launched", "alreadyConnected"],
        properties: {
          connected: { type: "boolean", required: true },
          port: { ...nullableInteger, required: true },
          webSocketUrl: { ...nullableString, required: true },
          browser: { ...nullableString, required: true },
          protocolVersion: { ...nullableString, required: true },
          external: { oneOf: [{ type: "boolean" }, { type: "null" }], required: true },
          firefoxPid: { ...nullableInteger, required: true },
          launchMethod: { oneOf: [{ type: "string" }, { type: "null" }], description: "\"wmi\" when Windows WMI escaped the dsh Host job, \"direct\" for a normal child process, null for an attached browser." },
          activeTabId: { ...nullableString, required: true },
          tabs: { ...tabsField, required: true },
          launched: { type: "boolean", required: true },
          alreadyConnected: { type: "boolean", required: true },
        },
      },
      timeoutMs: 120_000,
      execute: (args, exec) => operator.launch({
        url: args.url,
        headless: args.headless,
        port: args.port,
        attachOnly: args.attach_only,
        waitUntil: args.wait_until,
      }, exec.signal),
    }),

    tool({
      name: "firefox_tabs",
      description: "List, open, switch to, or close Firefox tabs. This tool never starts Firefox: use firefox_launch first. Every other tool can name a tab_id; omitting it uses the active tab. 中文触发词：标签页、切换标签、关闭标签。",
      parameters: {
        action: {
          type: "string",
          enum: ["list", "new", "switch", "close"],
          description: "list (default) returns tabs; new opens a tab; switch focuses one; close closes one.",
        },
        tab_id: tabIdParam,
        url: {
          type: "string",
          description: "URL to open when action=new. Ignored for other actions.",
        },
        wait_until: {
          type: "string",
          enum: ["none", "interactive", "complete"],
          description: "Navigation wait mode for action=new with url. Defaults to complete.",
        },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["action", "tabs", "activeTabId"],
        properties: {
          action: { type: "string", required: true },
          tabs: { ...tabsField, required: true },
          activeTabId: { ...nullableString, required: true },
          created: { type: "string", description: "Tab id created by action=new." },
          switched: { type: "string", description: "Tab id selected by action=switch." },
          closed: { type: "string", description: "Tab id closed by action=close." },
        },
      },
      execute: (args, exec) => operator.tabs({
        action: args.action,
        tabId: args.tab_id,
        url: args.url,
        waitUntil: args.wait_until,
      }, exec.signal),
    }),

    tool({
      name: "firefox_navigate",
      description: "Navigate a Firefox tab to an absolute URL and wait for the requested load state. Use new_tab to preserve the current page. Returns the resulting url and title. 中文触发词：打开网页、访问地址、导航。",
      parameters: {
        url: { type: "string", required: true, description: "Absolute URL, including http, https, file, about, and data URLs." },
        tab_id: tabIdParam,
        new_tab: { type: "boolean", description: "Open the URL in a new tab and leave the current page untouched." },
        wait_until: {
          type: "string",
          enum: ["none", "interactive", "complete"],
          description: "Load state to wait for. Defaults to complete.",
        },
        timeout_ms: { type: "integer", description: "Navigation timeout in milliseconds." },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "url", "title", "requestedUrl", "waitUntil"],
        properties: {
          tabId: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          requestedUrl: { type: "string", required: true },
          waitUntil: { type: "string", required: true },
        },
      },
      timeoutMs: 300_000,
      execute: (args, exec) => operator.navigate(args.url, {
        tabId: args.tab_id,
        newTab: args.new_tab === true,
        waitUntil: args.wait_until,
        timeoutMs: args.timeout_ms,
      }, exec.signal),
    }),

    tool({
      name: "firefox_read",
      description: "Read the page title, URL, body text, and optionally the DOM HTML of the active or named tab. Use a selector to read one element. Text and HTML are capped and report truncation. 中文触发词：读取网页、页面标题、正文、DOM。",
      parameters: {
        tab_id: tabIdParam,
        selector: { type: "string", description: "Read this CSS selector instead of the whole body." },
        include_html: { type: "boolean", description: "Also return the selected element's outerHTML, capped by max_chars." },
        max_chars: { type: "integer", description: "Maximum characters returned for text and HTML (default 30000, capped by plugin config)." },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "url", "title", "readyState", "tag", "text", "textTruncated", "links", "linksTruncated"],
        properties: {
          tabId: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          readyState: { type: "string", required: true },
          tag: { type: "string", required: true },
          text: { type: "string", required: true },
          textTruncated: { type: "boolean", required: true },
          html: { type: "string", description: "Present only when include_html is true." },
          htmlTruncated: { type: "boolean" },
          links: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "href"],
              properties: {
                text: { type: "string", required: true },
                href: { type: "string", required: true },
              },
            },
          },
          linksTruncated: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => renderRead(value),
      execute: (args, exec) => operator.read({
        tabId: args.tab_id,
        selector: args.selector,
        includeHtml: args.include_html === true,
        maxChars: args.max_chars,
      }, exec.signal),
    }),

    tool({
      name: "firefox_screenshot",
      description: "Capture the visible Firefox viewport as a PNG/JPEG file and return its absolute path. Use this when layout, images, overlays, or whether the page rendered correctly matter; the file can be read with read_image. The screenshot is stored under the plugin's screenshot directory (temp by default). 中文触发词：截图、看看页面、画面。",
      parameters: {
        tab_id: tabIdParam,
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format. Defaults to png.",
        },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "url", "title", "path", "bytes", "mimeType", "width", "height"],
        properties: {
          tabId: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          path: { type: "string", required: true, description: "Absolute path readable by read_image." },
          bytes: { type: "integer", required: true },
          mimeType: { type: "string", required: true },
          width: { ...nullableInteger, required: true },
          height: { ...nullableInteger, required: true },
        },
      },
      render: (_args, value) => renderScreenshot(value),
      timeoutMs: 60_000,
      execute: (args, exec) => operator.screenshot({
        tabId: args.tab_id,
        format: args.format,
      }, exec.signal),
    }),

    tool({
      name: "firefox_click",
      description: "Click an element in a Firefox tab by CSS selector or visible text. Firefox receives a real trusted mouse press at the element centre; if the protocol rejects pointer input, the plugin falls back to a DOM click. Inspect the page with firefox_read first. 中文触发词：点击、按下按钮、点这个链接。",
      parameters: {
        tab_id: tabIdParam,
        selector: { type: "string", description: "CSS selector of the element to click." },
        text: { type: "string", description: "Visible text to click when selector is omitted. Searches semantic controls plus cursor:pointer/click-like div and span controls; exact matches rank first." },
        index: { type: "integer", description: "Zero-based index into the ranked text candidates. Omit to click a unique exact match; multiple matches return AMBIGUOUS_TEXT with the candidate list instead of clicking blindly." },
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "url", "title", "method", "clicked"],
        properties: {
          tabId: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          method: { type: "string", enum: ["pointer", "dom"], required: true },
          clicked: {
            type: "object",
            additionalProperties: false,
            required: ["selector", "text", "tag", "textPreview", "point", "covered", "coveredBy", "match"],
            properties: {
              selector: { ...nullableString, required: true },
              text: { ...nullableString, required: true },
              tag: { type: "string", required: true },
              textPreview: { type: "string", required: true },
              point: {
                type: "object",
                additionalProperties: false,
                required: ["x", "y"],
                properties: {
                  x: { type: "integer", required: true },
                  y: { type: "integer", required: true },
                },
              },
              covered: { type: "boolean", required: true },
              coveredBy: { ...nullableString, required: true },
              match: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "rank", "candidates"],
                properties: {
                  kind: { type: "string", enum: ["selector", "text"], required: true },
                  rank: { type: "integer", required: true },
                  candidates: { type: "integer", required: true },
                },
              },
            },
          },
        },
      },
      execute: (args, exec) => operator.click({
        tabId: args.tab_id,
        selector: args.selector,
        text: args.text,
        index: args.index,
      }, exec.signal),
    }),

    tool({
      name: "firefox_fill",
      description: "Fill an input, textarea, select, checkbox, radio, or contenteditable element and dispatch input/change events, then optionally submit its form. Use submit=true to call requestSubmit and fire the form's submit handlers. 中文触发词：填写表单、输入、提交表单。",
      parameters: {
        selector: { type: "string", required: true, description: "CSS selector of the field." },
        value: { type: "string", required: true, description: "Text or value to set. Checkbox/radio accept true/false-like strings." },
        submit: { type: "boolean", description: "Submit the field's form after filling it." },
        tab_id: tabIdParam,
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "url", "title", "filled"],
        properties: {
          tabId: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          filled: {
            type: "object",
            additionalProperties: false,
            required: ["selector", "tag", "type", "valueLength", "submitted", "formAction"],
            properties: {
              selector: { type: "string", required: true },
              tag: { type: "string", required: true },
              type: { type: "string", required: true },
              valueLength: { type: "integer", required: true },
              submitted: { type: "boolean", required: true },
              formAction: { ...nullableString, required: true },
            },
          },
        },
      },
      execute: (args, exec) => operator.fill({
        tabId: args.tab_id,
        selector: args.selector,
        value: args.value,
        submit: args.submit === true,
      }, exec.signal),
    }),

    tool({
      name: "firefox_eval",
      description: "Evaluate a JavaScript expression in the page context of a Firefox tab and return its JSON-able result. The expression is awaited, so `fetch(...)` and Promise chains work. Page exceptions are returned as ok=false with the error text; protocol failures fail the tool. 中文触发词：执行 JavaScript、页面脚本、js。",
      parameters: {
        expression: { type: "string", required: true, description: "JavaScript expression to evaluate. Wrap statements in an IIFE if needed." },
        await_promise: { type: "boolean", description: "Await a returned Promise. Defaults to true." },
        tab_id: tabIdParam,
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "url", "title", "ok", "resultType", "result", "error"],
        properties: {
          tabId: { type: "string", required: true },
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          ok: { type: "boolean", required: true },
          resultType: { ...nullableString, required: true },
          result: { description: "The JSON-able value returned by the expression; null when it threw.", required: true },
          error: { ...nullableString, required: true },
        },
      },
      execute: (args, exec) => operator.evaluate({
        tabId: args.tab_id,
        expression: args.expression,
        awaitPromise: args.await_promise !== false,
      }, exec.signal),
    }),

    tool({
      name: "firefox_wait",
      description: "Wait until a CSS selector reaches a state (visible, hidden, attached, detached) or the document reaches a load state. Polls the live page and returns elapsed time; throws a WAIT_TIMEOUT error instead of hanging forever. 中文触发词：等待加载、等待元素出现。",
      parameters: {
        selector: { type: "string", description: "CSS selector to wait for. Omit to wait only for a load state." },
        state: {
          type: "string",
          enum: ["visible", "hidden", "attached", "detached"],
          description: "Selector condition. Defaults to visible.",
        },
        load_state: {
          type: "string",
          enum: ["none", "interactive", "complete"],
          description: "Also require this document.readyState. Defaults to none with a selector, complete without one.",
        },
        timeout_ms: { type: "integer", description: "Maximum wait in milliseconds. Defaults to plugin config (10000)." },
        tab_id: tabIdParam,
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["tabId", "matched", "condition", "elapsedMs", "url", "title"],
        properties: {
          tabId: { type: "string", required: true },
          matched: { type: "boolean", required: true },
          condition: { type: "string", required: true },
          elapsedMs: { type: "number", required: true },
          url: { ...nullableString, required: true },
          title: { ...nullableString, required: true },
        },
      },
      render: (_args, value) => renderWait(value),
      timeoutMs: 200_000,
      execute: (args, exec) => operator.wait({
        tabId: args.tab_id,
        selector: args.selector,
        state: args.state,
        loadState: args.load_state,
        timeoutMs: args.timeout_ms,
      }, exec.signal),
    }),

    tool({
      name: "firefox_close",
      description: "Close one tab, disconnect the WebSocket, or close Firefox entirely. target=browser closes every window, including an attached Firefox, so use it only when the work is finished; target=disconnect leaves Firefox running so a later firefox_launch can reattach. 中文触发词：关闭标签页、关闭浏览器、断开。",
      parameters: {
        target: {
          type: "string",
          enum: ["tab", "browser", "disconnect"],
          description: "tab closes one tab (default); browser closes Firefox; disconnect only closes the dsh-side connection.",
        },
        tab_id: tabIdParam,
      },
      output: {
        type: "object",
        additionalProperties: false,
        required: ["target", "closed", "tabs", "activeTabId"],
        properties: {
          target: { type: "string", required: true },
          closed: { type: "string", required: true },
          tabs: { ...tabsField, required: true },
          activeTabId: { ...nullableString, required: true },
        },
      },
      execute: (args, exec) => operator.close({
        target: args.target,
        tabId: args.tab_id,
      }, exec.signal),
    }),
  ];
}

export const FIREFOX_TOOL_NAMES = Object.freeze([
  "firefox_launch",
  "firefox_tabs",
  "firefox_navigate",
  "firefox_read",
  "firefox_screenshot",
  "firefox_click",
  "firefox_fill",
  "firefox_eval",
  "firefox_wait",
  "firefox_close",
]);
