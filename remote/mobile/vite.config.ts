import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { "@codex-pane/remote-protocol": fileURLToPath(new URL("../../packages/remote-protocol/src/index.ts", import.meta.url)) } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { output: { format: "iife", name: "CodexPaneMobile", inlineDynamicImports: true, entryFileNames: "assets/mobile.js", assetFileNames: "assets/mobile.[ext]" } }
  },
  server: { port: 5174 }
});
