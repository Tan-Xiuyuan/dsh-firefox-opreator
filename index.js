/**
 * dsh host plugin entry for Firefox Operator.
 *
 * dsh 0.2.1-rc.5 exposes a Cordis plugin interface: a host bundle declares
 * `dsh.bundle.patch` in package.json and exports `apply(ctx, config)`; tools are
 * registered with `ctx.tools.register(toolDefinition)`, as documented by the
 * installed `@deepseek-ai/dsh-tools` ToolRuntime and the shipped tool plugins.
 * This is a host-only plugin; no Client/UI part is required.
 */

import { FirefoxOperator } from "./lib/firefox.js";
import { createFirefoxTools } from "./lib/tools.js";

/** Unique plugin name used by the Cordis loader and logs. */
export const name = "dsh-firefox-operator";

/** The tool registry must exist before apply() is called. */
export const inject = ["tools"];

/**
 * Mount the browser controller and its agent tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const operator = new FirefoxOperator(config);
  const tools = createFirefoxTools(operator);

  ctx.effect(() => {
    const disposers = tools.map((toolDefinition) => ctx.tools.register(toolDefinition));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "dsh-firefox-operator: tools");

  ctx.effect(() => () => {
    return operator.dispose();
  }, "dsh-firefox-operator: browser lifetime");
}

export { FirefoxOperator };
