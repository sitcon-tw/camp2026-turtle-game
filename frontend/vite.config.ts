import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["blockly", "blockly/core"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: apiProxyTarget,
        ws: true,
      },
      "/healthz": apiProxyTarget,
      "/readyz": apiProxyTarget,
    },
  },
})
