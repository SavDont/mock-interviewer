// Silero VAD v5: a small neural network that gives the probability that a 32ms frame of
// 16kHz audio contains speech. It runs locally in WebAssembly (~1ms a frame). Unlike a
// volume threshold, it ignores keyboard clicks and fans and still catches soft syllables.

import * as ort from "onnxruntime-web/wasm";

export const VAD_FRAME = 512; // samples at 16kHz = 32ms; the only size the model accepts
const CONTEXT = 64; // tail of the previous frame, so an onset across a frame boundary is seen whole

ort.env.wasm.wasmPaths = "/vad/"; // copied there by vite.config.ts
ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, and one frame is tiny anyway

export class SileroVad {
  private state: ort.Tensor;
  private context = new Float32Array(CONTEXT);
  private readonly sr = new ort.Tensor("int64", BigInt64Array.from([16000n]));

  private constructor(private session: ort.InferenceSession) {
    this.state = SileroVad.zeroState();
  }

  private static zeroState() {
    return new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  }

  private static loading: Promise<SileroVad> | null = null;

  /** Loads the model once per page; later calls share it. */
  static load(): Promise<SileroVad> {
    SileroVad.loading ??= (async () => {
      const session = await ort.InferenceSession.create("/vad/silero_vad_v5.onnx", { executionProviders: ["wasm"] });
      return new SileroVad(session);
    })();
    SileroVad.loading.catch(() => {
      SileroVad.loading = null;
    });
    return SileroVad.loading;
  }

  reset() {
    this.state = SileroVad.zeroState();
    this.context = new Float32Array(CONTEXT);
  }

  /** Speech probability (0..1) for one 512-sample frame. */
  async process(frame: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);
    this.context = frame.slice(-CONTEXT);
    const out = await this.session.run({
      input: new ort.Tensor("float32", input, [1, input.length]),
      state: this.state,
      sr: this.sr,
    });
    this.state = out.stateN as ort.Tensor;
    return (out.output as ort.Tensor).data[0] as number;
  }
}
