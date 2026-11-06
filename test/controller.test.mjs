import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FirefoxOperator } from "../lib/firefox.js";
import { createFirefoxTools, FIREFOX_TOOL_NAMES } from "../lib/tools.js";
import { startMockBidiServer } from "./mock-bidi-server.mjs";

async function makeOperator(server) {
  const profileDir = mkdtempSync(join(tmpdir(), "dsh-firefox-operator-test-"));
  const operator = new FirefoxOperator({
    port: server.port,
    attachOnly: true,
    profileDir,
    screenshotDir: join(profileDir, "screenshots"),
    headless: true,
    commandTimeoutMs: 3000,
    navigationTimeoutMs: 3000,
    defaultWaitMs: 3000,
  });
  const launch = await operator.launch({ attachOnly: true, port: server.port });
  return { operator, profileDir, launch };
}

test("controller covers launch, navigation, read, click, fill, eval, wait, tabs, and errors", async (t) => {
  const server = await startMockBidiServer();
  const { operator, profileDir, launch } = await makeOperator(server);
  t.after(async () => {
    operator.dispose();
    await server.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  assert.equal(launch.connected, true);
  assert.equal(launch.port, server.port);
  assert.equal(launch.tabs.length, 1);
  assert.equal(launch.activeTabId, launch.tabs[0].tabId);

  const nav = await operator.navigate("data:text/html,<title>Hello</title><h1>Hello</h1>");
  assert.equal(nav.requestedUrl, "data:text/html,<title>Hello</title><h1>Hello</h1>");
  assert.match(nav.title, /^Title of data:/);

  const read = await operator.read({ includeHtml: true, maxChars: 1000 });
  assert.equal(read.title, nav.title);
  assert.equal(read.text, `Mock body for ${nav.requestedUrl}`);
  assert.equal(read.html, "<body>mock</body>");
  assert.equal(read.readyState, "complete");
  assert.deepEqual(read.links, [{ text: "Example", href: "https://example.test/" }]);

  const shot = await operator.screenshot({ format: "png" });
  assert.equal(existsSync(shot.path), true);
  assert.ok(statSync(shot.path).size > 0);
  const signature = readFileSync(shot.path).subarray(0, 8).toString("hex");
  assert.equal(signature, "89504e470d0a1a0a");
  assert.equal(shot.width, 1);
  assert.equal(shot.height, 1);

  const click = await operator.click({ selector: "#go" });
  assert.equal(click.method, "pointer");
  assert.equal(click.clicked.tag, "button");
  assert.equal(server.state.inputActions, 1);

  const fill = await operator.fill({ selector: "#name", value: "Ada", submit: true });
  assert.equal(fill.filled.valueLength, 3);
  assert.equal(fill.filled.tag, "input");
  assert.equal(fill.filled.submitted, true);

  const evalResult = await operator.evaluate({ expression: "6 * 7" });
  assert.equal(evalResult.ok, true);
  assert.equal(evalResult.result, 42);

  const evalThrow = await operator.evaluate({ expression: "THROW_IN_PAGE" });
  assert.equal(evalThrow.ok, false);
  assert.match(evalThrow.error, /mock page error/);

  const wait = await operator.wait({ selector: "#ready", timeoutMs: 2000 });
  assert.equal(wait.matched, true);
  assert.match(wait.condition, /#ready/);

  const newTab = await operator.tabs({ action: "new", url: "data:text/html,<title>Second</title>" });
  assert.equal(newTab.tabs.length, 2);
  assert.equal(newTab.activeTabId, newTab.created);

  const switched = await operator.tabs({ action: "switch", tabId: launch.tabs[0].tabId });
  assert.equal(switched.activeTabId, launch.tabs[0].tabId);

  const closed = await operator.tabs({ action: "close", tabId: newTab.created });
  assert.equal(closed.tabs.length, 1);

  await assert.rejects(
    () => operator.click({ selector: "#missing" }),
    (error) => error.code === "ELEMENT_NOT_FOUND",
  );
  // The failed click did not crash the browser or desynchronize the controller.
  const afterError = await operator.read({});
  assert.equal(afterError.text.startsWith("Mock body for "), true);

  await assert.rejects(
    () => operator.read({ tabId: "not-a-tab" }),
    (error) => error.code === "NO_SUCH_TAB",
  );

  const status = await operator.status();
  assert.equal(status.connected, true);
  assert.equal(status.tabs.length, 1);

  const closedBrowser = await operator.close({ target: "browser" });
  assert.equal(closedBrowser.closed, "browser");
  assert.equal(operator.client.connected, false);
});

test("tools expose the documented names and strict schemas", async (t) => {
  const server = await startMockBidiServer();
  const profileDir = mkdtempSync(join(tmpdir(), "dsh-firefox-operator-tools-"));
  const operator = new FirefoxOperator({ port: server.port, attachOnly: true, profileDir });
  t.after(async () => {
    operator.dispose();
    await server.close();
    rmSync(profileDir, { recursive: true, force: true });
  });
  const tools = createFirefoxTools(operator);
  assert.deepEqual(tools.map((tool) => tool.name), [...FIREFOX_TOOL_NAMES]);
  assert.equal(tools[0].name, "firefox_launch");
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(typeof tool.output.render, "function");
    assert.equal(typeof tool.execute, "function");
    for (const [name, schema] of Object.entries(tool.parameters.properties)) {
      assert.equal(schema.required, undefined, `${tool.name}.${name} leaked an authoring annotation`);
    }
  }
  await assert.rejects(
    () => tools.find((tool) => tool.name === "firefox_tabs").execute({ action: "list" }, { signal: new AbortController().signal }),
    (error) => error.code === "NOT_CONNECTED",
  );
});
