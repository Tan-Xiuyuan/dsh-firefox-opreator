import assert from "node:assert/strict";
import test from "node:test";
import { BidiClient, remoteValueToJs } from "../lib/bidi-client.js";
import { startMockBidiServer } from "./mock-bidi-server.mjs";

test("BidiClient performs session.new and maps command results", async () => {
  const server = await startMockBidiServer();
  const client = new BidiClient({ connectTimeoutMs: 3000, commandTimeoutMs: 3000 });
  try {
    const session = await client.connect(`ws://127.0.0.1:${server.port}/session`);
    assert.equal(session.sessionId, "mock-session");
    assert.equal(client.sessionId, "mock-session");
    const tree = await client.send("browsingContext.getTree", { maxDepth: 1 });
    assert.equal(Array.isArray(tree.contexts), true);
    assert.equal(tree.contexts.length, 1);
  } finally {
    client.close("test done");
    await server.close();
  }
});

test("BidiClient surfaces BiDi errors and command timeouts without crashing", async () => {
  const server = await startMockBidiServer();
  const client = new BidiClient({ connectTimeoutMs: 3000, commandTimeoutMs: 3000 });
  try {
    await client.connect(`ws://127.0.0.1:${server.port}/session`);
    await assert.rejects(
      () => client.send("mock.fail"),
      (error) => error.code === "FIREFOX_MOCK_FAILURE" && /deliberate mock failure/.test(error.message),
    );
    await assert.rejects(
      () => client.send("mock.delay", { ms: 300 }, { timeoutMs: 40 }),
      (error) => error.code === "COMMAND_TIMEOUT",
    );
    // The client is still usable after a failed command.
    const tree = await client.send("browsingContext.getTree", {});
    assert.equal(tree.contexts.length, 1);
  } finally {
    client.close("test done");
    await server.close();
  }
});

test("BidiClient rejects a connection to a closed port with one actionable error", async () => {
  const client = new BidiClient({ connectTimeoutMs: 1500, commandTimeoutMs: 1500 });
  await assert.rejects(
    () => client.connect("ws://127.0.0.1:1/session"),
    (error) => ["CONNECT_FAILED", "CONNECT_CLOSED", "CONNECT_TIMEOUT"].includes(error.code),
  );
  assert.equal(client.connected, false);
});

test("remoteValueToJs handles BiDi primitives, arrays, and object pairs", () => {
  assert.equal(remoteValueToJs({ type: "string", value: "x" }), "x");
  assert.equal(remoteValueToJs({ type: "number", value: 3 }), 3);
  assert.equal(remoteValueToJs({ type: "null" }), null);
  assert.equal(remoteValueToJs({ type: "undefined" }), undefined);
  assert.deepEqual(remoteValueToJs({ type: "array", value: [{ type: "number", value: 1 }] }), [1]);
  assert.deepEqual(
    remoteValueToJs({ type: "object", value: [["a", { type: "string", value: "b" }]] }),
    { a: "b" },
  );
});
