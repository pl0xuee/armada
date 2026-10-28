import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * Content-Security-Policy for the production build (the dev server needs its
 * HMR client and websocket). Everything is inlined into one HTML file, so the
 * policy pins the exact inline script and stylesheet by SHA-256 instead of
 * allowing 'unsafe-inline': injected markup can't execute, and
 * `connect-src 'self'` / no remote images keep data from leaving the device.
 * React's `style={{…}}` props go through CSSOM, which style-src doesn't gate.
 * The desktop server should also send this policy as a header (headers can
 * additionally set `frame-ancestors 'none'`).
 */
function cspMeta(): Plugin {
  const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
  return {
    name: "armada-remote-csp",
    apply: "build",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const html = bundle["index.html"];
        if (!html || html.type !== "asset" || typeof html.source !== "string") {
          this.error("index.html missing from bundle");
          return;
        }
        const source = html.source;
        const grab = (tag: string) =>
          [...source.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => hash(m[1]));
        const scripts = grab("script");
        const styles = grab("style");
        if (!scripts.length) this.error("expected an inline script to hash");
        const policy = [
          "default-src 'none'",
          `script-src ${scripts.join(" ")}`,
          `style-src ${styles.join(" ") || "'none'"}`,
          "connect-src 'self'",
          "img-src 'self' data:",
          "manifest-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; ");
        html.source = source.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

/** Dev only: the desktop server provides these in production. */
function devPwaStubs(): Plugin {
  return {
    name: "armada-remote-dev-pwa-stubs",
    apply: "serve",
    configureServer(server) {
      if (process.env.ARMADA_REMOTE_URL) return; // proxied to the real server
      server.middlewares.use("/manifest.webmanifest", (_req, res) => {
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(JSON.stringify({ name: "Armada", short_name: "Armada", display: "standalone", background_color: "#0B0D10", theme_color: "#0B0D10", start_url: "/" }));
      });
      server.middlewares.use("/icon.png", (_req, res) => {
        res.statusCode = 204;
        res.end();
      });
    },
  };
}

/**
 * `ARMADA_REMOTE_URL=http://127.0.0.1:47821 npm run dev` proxies the API to a
 * running desktop app so the UI can be developed against real agents.
 */
const remote = process.env.ARMADA_REMOTE_URL;
const proxied = ["/api", "/manifest.webmanifest", "/icon.png"];

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile({ removeViteModuleLoader: true }), cspMeta(), devPwaStubs()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../desktop/src/lib", import.meta.url)),
    },
  },
  server: {
    port: 5180,
    host: true,
    proxy: remote ? Object.fromEntries(proxied.map((p) => [p, { target: remote, changeOrigin: true }])) : undefined,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Tailwind v4's baseline (color-mix, @property, cascade layers).
    target: ["es2022", "safari16.4", "chrome111", "firefox128"],
    cssTarget: ["safari16.4", "chrome111", "firefox128"],
    reportCompressedSize: true,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 1024,
  },
});
