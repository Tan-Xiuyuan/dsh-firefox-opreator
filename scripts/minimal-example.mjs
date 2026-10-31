#!/usr/bin/env node
/**
 * Minimal command-line example: launch Firefox, open a URL, print its title.
 *
 * Run this outside the dsh workspace-write sandbox (it launches Firefox):
 *   node scripts/minimal-example.mjs https://example.com/
 *
 * The same result through the dsh agent tools is documented in README.md.
 */

import { FirefoxOperator } from "../lib/firefox.js";

const url = process.argv[2] ?? "https://example.com/";
const operator = new FirefoxOperator({ headless: true });

try {
  const launch = await operator.launch({ headless: true });
  console.log(`Firefox connected on port ${launch.port} (pid ${launch.firefoxPid ?? "external"})`);

  const navigation = await operator.navigate(url, { waitUntil: "complete" });
  console.log(`Navigated to ${navigation.url}`);

  const page = await operator.read({ maxChars: 500 });
  console.log(`TITLE: ${page.title}`);
  console.log(`TEXT: ${page.text.slice(0, 200).replace(/\s+/g, " ")}`);
} finally {
  try {
    await operator.close({ target: "browser" });
  } catch (error) {
    console.error(`cleanup failed: ${error.message}`);
  }
  await operator.dispose();
}
