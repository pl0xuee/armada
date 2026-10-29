// Bundles preview-agent/agent.js (+ html-to-image) into the static asset the Rust proxy serves.
import { build } from "rolldown";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
await build({
  input: here("./agent.js"),
  output: { file: here("../src-tauri/assets/preview-agent.js"), format: "iife", minify: true },
  platform: "browser",
});
