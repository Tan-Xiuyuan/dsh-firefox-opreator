#!/usr/bin/env node
/**
 * Live verification against a real Firefox 153 ESR.
 *
 * Default: launch a headless Firefox with a dedicated profile and stop it at
 * the end. Set FF_PORT + FF_ATTACH_ONLY=1 to test an already-running Firefox
 * that was started with --remote-debugging-port.
 *
 * This script must run outside the dsh workspace-write sandbox when it launches
 * Firefox (the sandboxed shell's low-integrity Firefox cannot complete startup
 * on Windows). Attaching to an already-running Firefox works from the normal
 * shell.
 */

import assert from "node:assert/strict";
import { FirefoxOperator } from "../lib/firefox.js";

const port = process.env.FF_PORT ? Number(process.env.FF_PORT) : undefined;
const attachOnly = process.env.FF_ATTACH_ONLY === "1" || port !== undefined;
const headless = process.env.FF_HEADLESS !== "0";

const html = `<!doctype html>
<html><head><title>Live Check</title></head>
<body>
  <h1 id="heading">Firefox Operator live check</h1>
  <button id="go" onclick="document.title='Clicked';document.body.insertAdjacentHTML('beforeend','<p id=clicked>clicked</p>')">Click me</button>
  <div id="divbtn" class="login-entry" style="cursor:pointer" onclick="document.title='Div Clicked'">Div Login</div>
  <button id="dup1" onclick="document.title='Duplicate One'">Duplicate</button>
  <button id="dup2" onclick="document.title='Duplicate Two'">Duplicate</button>
  <form id="form"><input id="name" name="name" value=""><button id="submit" type="submit">Submit</button></form>
  <a href="https://example.org/">Example link</a>
  <div id="delayed"></div>
  <script>
    setTimeout(() => { document.getElementById('delayed').innerHTML = '<span id="ready">ready</span>'; }, 700);
    document.getElementById('form').addEventListener('submit', (event) => {
      event.preventDefault();
      document.title = 'Submitted';
      document.body.dataset.submitted = '1';
    });
  </script>
</body></html>`;
const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
const url2 = `data:text/html;charset=utf-8,${encodeURIComponent("<title>Second Tab</title><h1>second</h1>")}`;

function log(label, value) {
  console.log(`\n## ${label}`);
  console.log(JSON.stringify(value, null, 2).slice(0, 2000));
}

const operator = new FirefoxOperator({
  port,
  attachOnly,
  headless,
  launchTimeoutMs: 30_000,
  commandTimeoutMs: 20_000,
  navigationTimeoutMs: 30_000,
  defaultWaitMs: 5000,
});

let browserOwned = false;
try {
  const launch = await operator.launch({ port, attachOnly, headless });
  browserOwned = launch.external === false;
  log("launch", launch);
  assert.equal(launch.connected, true);
  assert.ok(launch.tabs.length >= 1);

  const nav = await operator.navigate(url, { waitUntil: "complete" });
  log("navigate", nav);
  assert.equal(nav.requestedUrl, url);
  assert.equal(nav.title, "Live Check");

  const read = await operator.read({ includeHtml: true, maxChars: 20_000 });
  log("read", { ...read, html: read.html.slice(0, 200) });
  assert.equal(read.title, "Live Check");
  assert.match(read.text, /Firefox Operator live check/);
  assert.match(read.html, /id="go"/);
  assert.ok(read.links.some((link) => link.text === "Example link" && link.href.startsWith("https://example.org/")));

  const click = await operator.click({ selector: "#go" });
  log("click", click);
  assert.equal(click.method, "pointer");
  assert.equal(click.title, "Clicked");
  assert.equal(click.clicked.match.kind, "selector");
  const afterClick = await operator.read({ selector: "#clicked" });
  assert.match(afterClick.text, /clicked/);

  const divClick = await operator.click({ text: "Div Login" });
  log("text click on div", divClick);
  assert.equal(divClick.title, "Div Clicked");
  assert.equal(divClick.clicked.tag, "div");
  assert.equal(divClick.clicked.match.kind, "text");

  let ambiguous = null;
  try {
    await operator.click({ text: "Duplicate" });
  } catch (error) {
    ambiguous = error;
    log("expected ambiguous text", { code: error.code, message: error.message });
  }
  assert.equal(ambiguous?.code, "AMBIGUOUS_TEXT");
  assert.match(ambiguous.message, /Candidates:/i);

  const duplicateTwo = await operator.click({ text: "Duplicate", index: 1 });
  log("ambiguous resolved by index", duplicateTwo);
  assert.equal(duplicateTwo.title, "Duplicate Two");

  const screenshot = await operator.screenshot({ format: "png" });
  log("screenshot", screenshot);
  assert.ok(screenshot.path.endsWith(".png"));
  assert.ok(screenshot.bytes > 0);
  assert.equal(screenshot.width > 0, true);
  assert.equal(screenshot.height > 0, true);

  const fill = await operator.fill({ selector: "#name", value: "Ada Lovelace", submit: true });
  log("fill", fill);
  assert.equal(fill.filled.submitted, true);
  assert.equal(fill.title, "Submitted");

  const evalResult = await operator.evaluate({ expression: "6 * 7" });
  log("eval", evalResult);
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.result, 42);

  const wait = await operator.wait({ selector: "#ready", state: "visible", timeoutMs: 4000 });
  log("wait", wait);
  assert.equal(wait.matched, true);

  const tabs = await operator.tabs({ action: "list" });
  log("tabs", tabs);
  assert.ok(tabs.tabs.length >= 1);
  assert.equal(tabs.tabs.find((tab) => tab.tabId === tabs.activeTabId)?.title, "Submitted");

  const newTab = await operator.tabs({ action: "new", url: url2 });
  log("new tab", newTab);
  assert.equal(newTab.tabs.length, tabs.tabs.length + 1);
  const second = newTab.tabs.find((tab) => tab.tabId === newTab.created);
  assert.equal(second?.title, "Second Tab");

  const switched = await operator.tabs({ action: "switch", tabId: tabs.activeTabId });
  assert.equal(switched.activeTabId, tabs.activeTabId);

  const closed = await operator.tabs({ action: "close", tabId: newTab.created });
  assert.equal(closed.tabs.length, tabs.tabs.length);

  let errorCode = null;
  try {
    await operator.click({ selector: "#does-not-exist" });
  } catch (error) {
    errorCode = error.code;
    log("expected click error", { code: error.code, message: error.message });
  }
  assert.equal(errorCode, "ELEMENT_NOT_FOUND");
  const afterError = await operator.read({});
  assert.match(afterError.text, /Firefox Operator live check/);

  let timeoutError = null;
  try {
    await operator.wait({ selector: "#never-appears", timeoutMs: 400 });
  } catch (error) {
    timeoutError = error;
    log("expected wait timeout", { code: error.code, message: error.message.slice(0, 600) });
  }
  assert.equal(timeoutError?.code, "WAIT_TIMEOUT");
  assert.match(timeoutError.message, /Page now:/);
  assert.match(timeoutError.message, /Firefox Operator live check/);

  log("status", await operator.status());
  console.log("\nLIVE CHECK PASSED");
} catch (error) {
  console.error("\nLIVE CHECK FAILED");
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await operator.close({ target: browserOwned ? "browser" : "disconnect" });
  } catch (error) {
    console.error("cleanup close failed:", error.message);
  }
  operator.dispose();
}
