// Browser speech: Web Speech API recognition (ears) and speechSynthesis (mouth).

interface SRAlternative {
  transcript: string;
}
interface SRResult {
  isFinal: boolean;
  0: SRAlternative;
  length: number;
}
interface SREvent {
  resultIndex: number;
  results: { length: number; [i: number]: SRResult };
}
interface SRInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SRCtor = new () => SRInstance;

function getRecognitionCtor(): SRCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const speechRecognitionSupported = () => !!getRecognitionCtor();

export interface ListenerCallbacks {
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (msg: string) => void;
}

/** Common shape for the browser recognizer and local Whisper. */
export interface SpeechInput {
  /** How long to wait after a final transcript before asking the interviewer to respond. */
  readonly finalPauseMs: number;
  readonly running: boolean;
  start(): void | Promise<void>;
  stop(): void;
  /** Ignore audio for a while (e.g. while the interviewer talks through speakers). */
  setPaused?(paused: boolean): void;
}

/** Browser speech recognition (Chrome/Safari). Auto-restarts, since Chrome ends sessions after silence. */
export class Listener implements SpeechInput {
  readonly finalPauseMs = 1400;
  private rec: SRInstance | null = null;
  private active = false;

  constructor(private cb: ListenerCallbacks) {}

  start() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return this.cb.onError("Speech recognition isn't supported in this browser. Use Chrome or Edge.");
    this.active = true;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) this.cb.onFinal(text);
        else interim += `${text} `;
      }
      if (interim.trim()) this.cb.onInterim(interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed") {
        this.active = false;
        this.cb.onError("Microphone permission was denied.");
      } else if (e.error === "network") {
        // Chromium browsers other than Google Chrome (Dia, Arc, Brave…) expose the API but
        // can't reach Google's speech service. Retrying just loops on the same error.
        this.active = false;
        this.cb.onError(
          "Voice input isn't available in this browser (its speech service is unreachable). Open this page in Safari or Google Chrome, or type to the interviewer below.",
        );
      } else this.cb.onError(`Speech recognition error: ${e.error}`);
    };
    rec.onend = () => {
      if (this.active) setTimeout(() => this.active && this.safeStart(), 150);
    };
    this.rec = rec;
    this.safeStart();
  }

  private safeStart() {
    try {
      this.rec?.start();
    } catch {
      /* already started */
    }
  }

  stop() {
    this.active = false;
    this.rec?.abort();
    this.rec = null;
  }

  get running() {
    return this.active;
  }
}

const PREFERRED_VOICES = [
  "Google US English",
  "Samantha",
  "Ava (Premium)",
  "Ava (Enhanced)",
  "Zoe (Premium)",
  "Evan (Enhanced)",
  "Microsoft Aria Online (Natural) - English (United States)",
  "Microsoft Guy Online (Natural) - English (United States)",
  "Daniel",
];

export function pickDefaultVoice(voices: SpeechSynthesisVoice[]): string {
  for (const name of PREFERRED_VOICES) if (voices.some((v) => v.name === name)) return name;
  return voices.find((v) => v.lang === "en-US")?.name ?? voices[0]?.name ?? "";
}

export interface SpokenResult {
  spoken: string;
  interrupted: boolean;
}

/** Text-to-speech that can be cut off mid-sentence and reports how much was said. */
export class Speaker {
  voiceName = "";
  rate = 1.05;
  private current: { resolve: (r: SpokenResult) => void; text: string; charIndex: number } | null = null;

  get speaking() {
    return this.current !== null;
  }

  speak(text: string): Promise<SpokenResult> {
    this.cancel();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis.getVoices().find((v) => v.name === this.voiceName);
      if (voice) u.voice = voice;
      u.rate = this.rate;
      const state = { resolve, text, charIndex: 0 };
      this.current = state;
      u.onboundary = (e) => {
        state.charIndex = e.charIndex;
      };
      const done = () => {
        if (this.current !== state) return;
        this.current = null;
        resolve({ spoken: text, interrupted: false });
      };
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  /** Stop talking now (barge-in). Resolves the pending speak() as interrupted. */
  cancel() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    speechSynthesis.cancel();
    const cut = cur.text.slice(0, cur.charIndex).trim();
    cur.resolve({ spoken: cut ? `${cut}…` : "", interrupted: true });
  }
}
