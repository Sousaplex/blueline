import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

// Inline CHANGELOG.md (repo root) into the bundle so the About dialog can render it
// with no runtime file dependency — works identically in dev and the packaged app.
const changelog = readFileSync(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), "utf8");

// The bridge (toolkit: npm run serve) owns /api, /files, /ws. Proxying them here
// makes the live-preview iframe same-origin so inline copy editing can reach
// into its DOM. In M3, Electron serves the renderer and the EngineClient
// switches to IPC — this proxy is browser-mode only.
export default defineConfig({
  // Stamped into the bundle so the UI can prove which build it is.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __CHANGELOG__: JSON.stringify(changelog),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5177,
    proxy: {
      // Bridge port is configurable so a dev renderer can point at a throwaway bridge
      // (e.g. BRIDGE_PORT=7799) instead of the default 7717 the packaged app uses.
      "/api": `http://localhost:${process.env.BRIDGE_PORT ?? "7717"}`,
      "/files": `http://localhost:${process.env.BRIDGE_PORT ?? "7717"}`,
      "/ws": { target: `ws://localhost:${process.env.BRIDGE_PORT ?? "7717"}`, ws: true },
    },
  },
});
