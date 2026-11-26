import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Model and WebAssembly files for the in-browser models, served straight from node_modules so
// nothing comes from a CDN at runtime. (Not via /public: Vite won't let code import .mjs from there.)
const ASSETS: Record<string, string> = {
  // Silero voice activity detection (src/vad.ts) and the ONNX runtime it uses.
  "/vad/silero_vad_v5.onnx": "@ricky0123/vad-web/dist/silero_vad_v5.onnx",
  "/vad/ort-wasm-simd-threaded.wasm": "onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  "/vad/ort-wasm-simd-threaded.mjs": "onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
  // Kokoro text-to-speech (src/tts.worker.ts) bundles its own, different ONNX runtime version.
  "/kokoro/ort-wasm-simd-threaded.jsep.wasm": "@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm",
  "/kokoro/ort-wasm-simd-threaded.jsep.mjs": "@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs",
};
const TYPES: Record<string, string> = { wasm: "application/wasm", mjs: "text/javascript", onnx: "application/octet-stream" };

function modelAssets(): Plugin {
  return {
    name: "model-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        const file = ASSETS[path] && fileURLToPath(new URL(`node_modules/${ASSETS[path]}`, import.meta.url));
        if (!file || !existsSync(file)) return next();
        res.setHeader("Content-Type", TYPES[path.split(".").pop()!] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), modelAssets()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  resolve: {
    // kokoro-js only declares a Node entry in its exports map; this is its browser build.
    alias: { "kokoro-web": fileURLToPath(new URL("node_modules/kokoro-js/dist/kokoro.web.js", import.meta.url)) },
  },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
