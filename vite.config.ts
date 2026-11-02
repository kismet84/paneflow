import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    vue(),
    {
      name: "codex-pane-csp",
      transformIndexHtml(html) {
        const developmentConnections = command === "serve" ? " http://127.0.0.1:5173 ws://127.0.0.1:5173" : "";
        const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: codex-media:; font-src 'self' data:; connect-src 'self'${developmentConnections}; object-src 'none'; base-uri 'none'; form-action 'none'`;
        return html.replace("__CODEX_PANE_CSP__", csp);
      }
    }
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@protocol": fileURLToPath(new URL("./packages/protocol/src", import.meta.url))
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks: {
          framework: ["vue", "pinia"],
          ui: ["naive-ui", "splitpanes", "@vicons/ionicons5"],
          content: ["marked", "dompurify", "highlight.js/lib/core"]
        }
      }
    }
  }
}));
