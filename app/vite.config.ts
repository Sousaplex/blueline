import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The bridge (toolkit: npm run serve) owns /api, /files, /ws. Proxying them here
// makes the live-preview iframe same-origin so inline copy editing can reach
// into its DOM. In M3, Electron serves the renderer and the EngineClient
// switches to IPC — this proxy is browser-mode only.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5177,
    proxy: {
      "/api": "http://localhost:7717",
      "/files": "http://localhost:7717",
      "/ws": { target: "ws://localhost:7717", ws: true },
    },
  },
});
