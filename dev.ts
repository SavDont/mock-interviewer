// Runs the API server, the Vite dev server, and (if installed) a local Whisper server. Ctrl+C stops all.
import { existsSync } from "node:fs";
import { VOCAB } from "./server/stt";

// Best model that's been downloaded wins; override with WHISPER_MODEL=path.
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  ["models/ggml-large-v3-turbo-q5_0.bin", "models/ggml-small.en.bin", "models/ggml-base.en.bin"].find((m) => existsSync(m)) ||
  "models/ggml-base.en.bin";
const WHISPER_PORT = process.env.WHISPER_PORT || "8178";

const procs: { kill(): void; exited: Promise<number> }[] = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--bun", "vite"], { stdout: "inherit", stderr: "inherit" }),
];

const whisperBin = Bun.which("whisper-server");
if (whisperBin && existsSync(WHISPER_MODEL)) {
  procs.push(
    Bun.spawn(
      [whisperBin, "-m", WHISPER_MODEL, "--port", WHISPER_PORT, "-t", "6", "-nt", "-sns", "-l", "en", "-bs", "5", "--prompt", VOCAB],
      { stdout: "ignore", stderr: "ignore" },
    ),
  );
  console.log(`local whisper on :${WHISPER_PORT} (${WHISPER_MODEL})`);
} else {
  console.log("local whisper not found (brew install whisper-cpp + model in models/); using browser speech recognition");
}

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.slice(0, 2).map((p) => p.exited));
stop();
