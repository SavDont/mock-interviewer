// The browser build of kokoro-js (aliased in vite.config.ts); same API as the package.
declare module "kokoro-web" {
  export { KokoroTTS, TextSplitterStream } from "kokoro-js";
  export const env: { wasmPaths: string | Record<string, string> };
}
