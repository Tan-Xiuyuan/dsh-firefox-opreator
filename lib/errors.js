/**
 * Errors raised by the Firefox Operator plugin.
 *
 * The dsh tool registry renders a thrown Error's message to the model, so every
 * message must contain the machine code, what failed, and one actionable next
 * step. `details` is kept for local diagnostics and is appended when present.
 */

export class FirefoxOperatorError extends Error {
  /**
   * @param {string} code stable machine-readable code (e.g. NO_SUCH_TAB)
   * @param {string} message one-line human-readable summary
   * @param {{hint?: string, details?: unknown, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    const hint = options.hint ? ` Hint: ${options.hint}` : "";
    super(`${code}: ${message}${hint}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FirefoxOperatorError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

/**
 * Convert anything thrown while talking to Firefox into a plugin error.
 * BiDi protocol errors have `error` (a WebDriver error code) and `message`;
 * transport failures are wrapped as DISCONNECTED by BidiClient itself.
 *
 * @param {string} method BiDi command that failed
 * @param {unknown} error thrown value
 * @returns {FirefoxOperatorError}
 */
export function fromBidiError(method, error) {
  if (error instanceof FirefoxOperatorError) return error;

  if (error && typeof error === "object" && typeof error.error === "string") {
    const code = String(error.error).toUpperCase().replaceAll(" ", "_");
    const raw = String(error.message ?? "unknown WebDriver BiDi error");
    return new FirefoxOperatorError(
      `FIREFOX_${code}`,
      `${raw} (during ${method})`,
      {
        hint: hintForBidiCode(error.error),
        details: { method, bidiError: error.error, stacktrace: error.stacktrace },
      },
    );
  }

  if (error && typeof error === "object" && error.name === "AbortError") {
    return new FirefoxOperatorError("ABORTED", `${method} was cancelled by the caller`);
  }

  return new FirefoxOperatorError(
    "FIREFOX_COMMAND_FAILED",
    `${error instanceof Error ? error.message : String(error)} (during ${method})`,
    { cause: error },
  );
}

/** @param {string} code */
export function hintForBidiCode(code) {
  switch (code) {
    case "no such frame":
    case "no such node":
    case "no such window":
      return "The tab or document is gone; call firefox_tabs, then retry with a live tab_id.";
    case "no such element":
      return "The selector did not match; call firefox_read or use a more specific selector.";
    case "invalid argument":
      return "Check the argument types and the selector syntax.";
    case "unsupported operation":
      return "This Firefox build does not implement that BiDi operation; use the DOM fallback or a different tool.";
    case "javascript error":
      return "The page script threw; inspect the expression or read the page state with firefox_read.";
    case "timeout":
      return "Increase timeout_ms or wait for the page to become interactive.";
    default:
      return undefined;
  }
}
