import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef, useState } from "react";
import "@excalidraw/excalidraw/index.css";
import { ApiKeyPanel, type ProviderStatus, restoreRememberedKeys } from "./ApiKey";
import { type DrillChoice, DrillPicker, History } from "./History";
import { DEFAULT_KOKORO_VOICE, isKokoroVoice, KOKORO_VOICES, type KokoroStatus, kokoro } from "./kokoro";
import { InterviewLoop, type Mode, type Pushback, type RecruiterSetup, type Status, type TranscriptEntry } from "./loop";
import { renderMarkdown } from "./markdown";
import { pdfToText } from "./resume";
import { speechRecognitionSupported } from "./speech";
import { type Calibration, chooseGate, DEFAULT_GATE, levelToFraction, openMicProbe, SPEAKING_MARK } from "./whisper";

const CAL_SENTENCE = "For the write path, I'd put a load balancer in front of stateless API servers and cache hot links in Redis.";

/** A mic level expressed on the slider's 0..100 scale, so it's comparable to the gate. */
function levelToGateLabel(rms: number): string {
  return String(Math.round(levelToFraction(rms) * 100));
}

function loadGate(): number {
  try {
    const v = Number(localStorage.getItem("noiseGate"));
    return v > 0 && v <= 100 ? v : DEFAULT_GATE;
  } catch {
    return DEFAULT_GATE;
  }
}

/** Live mic level with a marker at the gate; redraws itself so the canvas doesn't re-render. */
function MicMeter({ level, gate }: { level: { current: number }; gate: number }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const f = levelToFraction(level.current);
      if (bar.current) {
        bar.current.style.width = `${f * 100}%`;
        bar.current.classList.toggle("hot", f * 100 >= gate);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [level, gate]);
  return (
    <div className="meter" title="Mic level. Speech has to reach the marker to count.">
      <div ref={bar} className="meter-fill" />
      <div className="meter-mark" style={{ left: `${gate}%` }} />
    </div>
  );
}

const STATUS_LABEL: Record<Status, string> = {
  idle: "Mic off",
  listening: "Listening",
  thinking: "Listening",
  speaking: "Interviewer speaking",
  ended: "Interview ended",
};

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

const MODES: Record<Mode, { title: string; blurb: string; minutes: number }> = {
  recruiter: {
    title: "Recruiter phone screen",
    blurb:
      "A voice call with a recruiter: your pitch, your experience, why you're looking, logistics and compensation, and your questions.",
    minutes: 25,
  },
  system_design: {
    title: "System design interview",
    blurb: "An engineer gives you a design problem. You talk it through and draw on the whiteboard while they probe and push back.",
    minutes: 45,
  },
};

/** Recruiter setup fields, remembered between visits. */
function loadRecruiter(): RecruiterSetup {
  try {
    const r = JSON.parse(localStorage.getItem("recruiter") ?? "{}") as Partial<RecruiterSetup>;
    return { source: r.source === "applied" ? "applied" : "outreach", company: r.company ?? "", role: r.role ?? "", brief: r.brief ?? "" };
  } catch {
    return { source: "outreach", company: "", role: "", brief: "" };
  }
}

function kokoroLabel(s: KokoroStatus): string {
  if (s.state === "loading")
    return `Downloading the voice model (first time only)… ${s.pct ?? 0}%. Until it's ready, a basic stand-in voice is used.`;
  if (s.state === "ready") return s.device === "webgpu" ? "Voice ready (GPU)." : "Voice ready (CPU; may lag a little between sentences).";
  if (s.state === "error") return `Kokoro couldn't load (${s.message}); using a basic stand-in voice.`;
  return "";
}

/** A drill picked from a past call: the page reloads into its setup (see startDrill). */
function takePendingDrill(): DrillChoice | null {
  try {
    const d = sessionStorage.getItem("pendingDrill");
    sessionStorage.removeItem("pendingDrill");
    return d ? (JSON.parse(d) as DrillChoice) : null;
  } catch {
    return null;
  }
}
const PENDING_DRILL = takePendingDrill();

export default function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const loopRef = useRef<InterviewLoop | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  // null until the candidate picks which kind of interview to practice.
  const [mode, setMode] = useState<Mode | null>(PENDING_DRILL?.mode ?? null);
  const [drill, setDrill] = useState<DrillChoice | null>(PENDING_DRILL);
  const [personas, setPersonas] = useState<Record<Mode, string>>({ system_design: "", recruiter: "" });
  const persona = mode ? personas[mode] : "";
  const setPersona = (p: string) => mode && setPersonas((ps) => ({ ...ps, [mode]: p }));
  const [background, setBackground] = useState(() => {
    try {
      return localStorage.getItem("background") ?? "";
    } catch {
      return "";
    }
  });
  const [recruiter, setRecruiterState] = useState<RecruiterSetup>(loadRecruiter);
  const setRecruiter = (patch: Partial<RecruiterSetup>) =>
    setRecruiterState((r) => {
      // Changing the company, role or how the call came about makes the old research stale.
      const stale = "source" in patch || "company" in patch || "role" in patch;
      const next = { ...r, ...(stale ? { brief: "" } : {}), ...patch };
      try {
        localStorage.setItem("recruiter", JSON.stringify(next));
      } catch {}
      return next;
    });
  const [research, setResearch] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [resumeNote, setResumeNote] = useState("");
  const [duration, setDuration] = useState(PENDING_DRILL?.minutes ?? 45);
  const [voice, setVoice] = useState(() => {
    // Older saves may hold a browser voice name or a "kokoro:" prefix.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("voice")?.replace(/^kokoro:/, "") ?? null;
    } catch {}
    return isKokoroVoice(saved) ? saved : DEFAULT_KOKORO_VOICE;
  });
  const [kokoroStatus, setKokoroStatus] = useState<KokoroStatus>(kokoro.status);
  const [headphones, setHeadphones] = useState(() => {
    try {
      return localStorage.getItem("headphones") === "1";
    } catch {
      return false;
    }
  });
  const [snapshots, setSnapshots] = useState(true);
  const [fast, setFast] = useState(() => {
    try {
      return localStorage.getItem("fast") !== "0";
    } catch {
      return true;
    }
  });
  const [pushback, setPushback] = useState<Pushback>(() => {
    try {
      const v = localStorage.getItem("pushback");
      return v === "gentle" || v === "tough" ? v : "realistic";
    } catch {
      return "realistic";
    }
  });
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [whisperUp, setWhisperUp] = useState(false);
  const [stt, setStt] = useState<"whisper" | "browser">("browser");
  const [gate, setGate] = useState(loadGate);
  const micLevel = useRef(0);
  const [cal, setCal] = useState<{ step: "idle" | "quiet" | "speak" | "done"; result?: Calibration }>({ step: "idle" });

  const [phase, setPhase] = useState<"setup" | "live" | "feedback" | "history">("setup");
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interim, setInterim] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [showNotes, setShowNotes] = useState(false);
  const [showBoardEvents, setShowBoardEvents] = useState(false);
  const [cost, setCost] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [typed, setTyped] = useState("");
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [feedback, setFeedback] = useState("");
  const [feedbackDone, setFeedbackDone] = useState(false);

  const activeKey = provider?.providers.find((p) => p.id === provider.active)?.keySource ?? "none";
  const authError = serverDown
    ? "Can't reach the local server. Is `bun run dev` running?"
    : provider && activeKey === "none"
      ? "Add an API key to start: paste one below, or set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env."
      : (provider?.keyError ?? null);
  const caps = provider?.capabilities ?? { fast: false, webResearch: false };

  useEffect(() => {
    for (const m of ["system_design", "recruiter"] as const) {
      fetch(`/api/default-persona?mode=${m}`)
        .then((r) => r.json())
        .then((d) => setPersonas((ps) => ({ ...ps, [m]: ps[m] || d.persona })))
        .catch(() => {});
    }
    fetch("/api/health")
      .then((r) => r.json())
      .then(async (d: ProviderStatus & { whisper: boolean }) => {
        setProvider(await restoreRememberedKeys(d));
        setWhisperUp(!!d.whisper);
        if (d.whisper) setStt("whisper");
      })
      .catch(() => setServerDown(true));
    return kokoro.subscribe(setKokoroStatus);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("voice", voice);
    } catch {}
    kokoro.load(); // start the download now, not when the interview starts
  }, [voice]);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    loopRef.current?.setNoiseGate(gate);
    try {
      localStorage.setItem("noiseGate", String(gate));
    } catch {}
  }, [gate]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll down whenever the transcript grows
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interim]);

  const getScene = () => {
    const api = apiRef.current;
    const elements = api?.getSceneElements() ?? [];
    return {
      elements,
      image: async () => {
        if (!api || elements.length === 0) return undefined;
        try {
          const blob = await exportToBlob({
            elements,
            appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff" },
            files: api.getFiles(),
            mimeType: "image/png",
            maxWidthOrHeight: 1280,
          });
          return await blobToBase64(blob);
        } catch (e) {
          console.warn("snapshot failed", e);
          return undefined;
        }
      },
    };
  };

  const calibrate = async () => {
    setError(null);
    setCal({ step: "quiet" });
    let probe: Awaited<ReturnType<typeof openMicProbe>> | null = null;
    try {
      probe = await openMicProbe((rms) => {
        micLevel.current = rms;
      });
      await probe.record(600); // let the mic and auto-gain settle
      const quiet = await probe.record(3000);
      setCal({ step: "speak" });
      const talking = await probe.record(5500);
      const result = chooseGate(quiet, talking);
      setGate(result.gate);
      setCal({ step: "done", result });
    } catch (e) {
      setCal({ step: "idle" });
      setError(
        (e as DOMException).name === "NotAllowedError"
          ? "Microphone permission was denied."
          : `Mic calibration failed: ${(e as Error).message}`,
      );
    } finally {
      probe?.close();
      micLevel.current = 0;
    }
  };

  /** Research the company and role on the web, so the recruiter can talk like it works there. */
  const runResearch = async (): Promise<string> => {
    setResearch({ busy: true });
    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: recruiter.source, company: recruiter.company, role: recruiter.role }),
      });
      const data = (await res.json()) as { brief?: string; error?: string };
      if (!res.ok || !data.brief) throw new Error(data.error || `HTTP ${res.status}`);
      setRecruiter({ brief: data.brief });
      setResearch({ busy: false });
      return data.brief;
    } catch (e) {
      setResearch({ busy: false, error: (e as Error).message });
      return "";
    }
  };

  const uploadResume = async (file: File | undefined) => {
    if (!file) return;
    setResumeNote(`Reading ${file.name}…`);
    try {
      const text = await pdfToText(file);
      if (!text) throw new Error("no text found (is it a scanned image?)");
      setBackground(text);
      try {
        localStorage.setItem("background", text);
      } catch {}
      setResumeNote(`Read ${text.split(/\s+/).length} words from ${file.name}. Check it below and fix anything that came out garbled.`);
    } catch (e) {
      setResumeNote(`Couldn't read ${file.name}: ${(e as Error).message}. You can paste the text instead.`);
    }
  };

  /** Starts a fresh page set up for a drill (a clean slate, like "New interview"). */
  const startDrill = (d: DrillChoice) => {
    try {
      sessionStorage.setItem("pendingDrill", JSON.stringify(d));
    } catch {}
    location.reload();
  };

  const start = async () => {
    setError(null);
    // Research first if there's a company to look up and it hasn't been done. (A drill reuses its call's setup.)
    let brief = recruiter.brief;
    if (!drill && mode === "recruiter" && caps.webResearch && recruiter.company.trim() && !brief.trim()) brief = await runResearch();
    // Unlock audio + trigger the mic permission prompt from this click.
    speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    const loop = new InterviewLoop(
      {
        mode: mode ?? "system_design",
        persona,
        background: mode === "recruiter" ? background : "",
        recruiter: mode === "recruiter" ? { ...recruiter, brief } : undefined,
        durationMin: duration,
        voiceName: voice,
        headphones,
        snapshots: snapshots && mode !== "recruiter",
        stt,
        noiseGate: gate,
        pushback,
        getScene,
        drill: drill ? { from: drill.from, index: drill.index } : undefined,
        fast: fast && caps.fast,
      },
      {
        onTranscript: (e) => setTranscript((t) => (t.some((x) => x.id === e.id) ? t.map((x) => (x.id === e.id ? e : x)) : [...t, e])),
        onInterim: setInterim,
        onStatus: setStatus,
        onNote: (n) => setNotes((ns) => [...ns, n]),
        onCost: setCost,
        onError: setError,
        onCallEnded: () => void end(),
        onMicLevel: (rms) => {
          micLevel.current = rms;
        },
      },
    );
    loopRef.current = loop;
    try {
      await loop.start();
      setStartedAt(Date.now());
      setPhase("live");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const end = async () => {
    const loop = loopRef.current;
    if (!loop) return;
    setPhase("feedback");
    setFeedback("");
    setFeedbackDone(false);
    const reader = await loop.end();
    if (!reader) return;
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      setFeedback((f) => f + dec.decode(value, { stream: true }));
    }
    setFeedbackDone(true);
  };

  const sendTyped = () => {
    if (!typed.trim()) return;
    loopRef.current?.sendText(typed.trim());
    setTyped("");
  };

  const elapsed = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const overtime = elapsed > duration * 60;
  const visible = transcript.filter((t) => showBoardEvents || t.who !== "board");

  return (
    <div className={`app ${mode === "recruiter" ? "call" : ""}`}>
      {mode !== "recruiter" && (
        <div className="canvas">
          <Excalidraw
            excalidrawAPI={(api) => {
              apiRef.current = api;
            }}
            onChange={(elements) => loopRef.current?.canvasChanged(elements)}
            initialData={{ appState: { currentItemFontFamily: 1 } }}
          />
        </div>
      )}

      <aside className="panel">
        <header className="panel-head">
          <div>
            <div className="title">
              {drill ? `Drill: ${drill.title}` : mode ? `Mock ${MODES[mode].title.toLowerCase()}` : "Mock Interview"}
            </div>
            <div className={`status status-${status}`}>
              <span className="dot" /> {STATUS_LABEL[status]}
            </div>
          </div>
          {phase === "live" && (
            <div className={`clock ${overtime ? "over" : ""}`}>
              {clock} / {duration}:00
            </div>
          )}
        </header>

        {phase === "live" && status !== "ended" && (
          <div className="controls">
            <button
              onClick={() => {
                const m = !muted;
                setMuted(m);
                micLevel.current = 0;
                loopRef.current?.setMuted(m);
              }}
            >
              {muted ? "Unmute mic" : "Mute mic"}
            </button>
            <button className="danger" onClick={end}>
              End & get feedback
            </button>
          </div>
        )}
        {phase === "live" && status === "ended" && (
          <div className="controls">
            <button onClick={() => setPhase("feedback")}>View debrief</button>
            <button className="primary" onClick={() => location.reload()}>
              New interview
            </button>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="transcript">
          {visible.map((t) => (
            <div key={t.id} className={`line ${t.who}`}>
              <span className="at">{t.at}</span>
              <span className="who">
                {t.who === "candidate" ? "You" : t.who === "interviewer" ? "Interviewer" : t.who === "board" ? "Board" : ""}
              </span>
              <span className="text">
                {t.text}
                {t.interrupted ? " (cut off)" : ""}
              </span>
            </div>
          ))}
          {interim && (
            <div className="line candidate interim">
              <span className="at" />
              <span className="who">You</span>
              <span className="text">{interim === SPEAKING_MARK ? "speaking…" : `${interim}…`}</span>
            </div>
          )}
          <div ref={transcriptEnd} />
        </div>

        {phase === "live" && (
          <>
            {stt === "whisper" && (
              <div className="gate">
                <label htmlFor="gate">Noise gate</label>
                <input id="gate" type="range" min={0} max={100} value={gate} onChange={(e) => setGate(Number(e.target.value))} />
                <MicMeter level={micLevel} gate={gate} />
              </div>
            )}
            <div className="type-row">
              <input
                value={typed}
                placeholder="Or type to the interviewer…"
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendTyped()}
              />
              <button onClick={sendTyped}>Send</button>
            </div>
            <div className="footer">
              {mode !== "recruiter" && (
                <label>
                  <input type="checkbox" checked={showBoardEvents} onChange={(e) => setShowBoardEvents(e.target.checked)} /> board events
                </label>
              )}
              <label>
                <input type="checkbox" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} /> interviewer notes
              </label>
              <span className="cost">${cost.toFixed(2)}</span>
            </div>
            {showNotes && (
              <div className="notes">{notes.length ? notes.map((n, i) => <div key={i}>• {n}</div>) : <i>No notes yet.</i>}</div>
            )}
          </>
        )}
      </aside>

      {phase === "setup" && !mode && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h2>What are you practicing?</h2>
              <span>
                <button className="link" onClick={() => setShowKey((v) => !v)}>
                  API key
                </button>
                {" · "}
                <button className="link" onClick={() => setPhase("history")}>
                  Past calls
                </button>
              </span>
            </div>
            <p className="muted">Pick the stage of the process. Each one has its own interviewer, pacing and debrief.</p>
            {authError && !(provider && (showKey || activeKey === "none")) && <div className="error">{authError}</div>}
            {provider && (showKey || activeKey === "none" || provider.keyError) && <ApiKeyPanel status={provider} onChange={setProvider} />}
            <div className="mode-pick">
              {(["recruiter", "system_design"] as const).map((m) => (
                <button
                  key={m}
                  className="mode-card"
                  onClick={() => {
                    setMode(m);
                    setDuration(MODES[m].minutes);
                  }}
                >
                  <b>{MODES[m].title}</b>
                  <span>{MODES[m].blurb}</span>
                  <span className="muted small">About {MODES[m].minutes} minutes</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {phase === "setup" && mode && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h2>{drill ? `Drill: ${drill.title}` : `Mock ${MODES[mode].title.toLowerCase()}`}</h2>
              {drill ? (
                <button
                  className="link"
                  onClick={() => {
                    setDrill(null);
                    setMode(null);
                    setDuration(45);
                  }}
                >
                  Cancel drill
                </button>
              ) : (
                <button className="link" onClick={() => setMode(null)}>
                  Change
                </button>
              )}
            </div>
            {drill ? (
              <div className="drill-banner">
                <span>{drill.why}</span>
                <span className="muted">
                  About {drill.minutes} minutes. The interviewer skips the intro, sets the scene, and goes straight to this, with the same
                  problem{mode === "recruiter" ? ", company and resume" : ""} as the original call.
                </span>
              </div>
            ) : (
              <p className="muted">
                {mode === "recruiter"
                  ? "The recruiter talks with you like a real phone screen and follows up when your answers are vague. There's no whiteboard; just talk."
                  : "The interviewer listens to you, watches the whiteboard, and jumps in when a real interviewer would. Thinking out loud helps it follow along."}
              </p>
            )}
            {authError && (
              <div className="error">
                {authError}{" "}
                <button className="link" onClick={() => setMode(null)}>
                  Set up API key
                </button>
              </div>
            )}
            {stt === "browser" && !speechRecognitionSupported() && (
              <div className="error">
                This browser has no built-in speech recognition. Use local Whisper, Chrome, or Safari (you can still type).
              </div>
            )}
            {drill ? null : mode === "recruiter" ? (
              <>
                <div className="field">
                  <span>How did this call come about?</span>
                  <div className="seg">
                    {(
                      [
                        ["outreach", "A recruiter reached out to me"],
                        ["applied", "I applied to a specific role"],
                      ] as const
                    ).map(([v, label]) => (
                      <button key={v} className={recruiter.source === v ? "on" : ""} onClick={() => setRecruiter({ source: v })}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field">
                  <span>Company (name or website)</span>
                  <input
                    value={recruiter.company}
                    placeholder="e.g. Stripe, or stripe.com"
                    onChange={(e) => setRecruiter({ company: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>
                    {recruiter.source === "outreach"
                      ? "The role you told them you're interested in"
                      : "Job posting (paste the link or the description)"}
                  </span>
                  <textarea
                    rows={3}
                    value={recruiter.role}
                    placeholder={
                      recruiter.source === "outreach"
                        ? "e.g. Senior backend or infrastructure roles, ideally on payments or data platform. Remote or SF."
                        : "e.g. https://jobs.example.com/senior-backend-engineer, or paste the job description"
                    }
                    onChange={(e) => setRecruiter({ role: e.target.value })}
                  />
                </label>
                <div className="field">
                  <div className="field-row">
                    <span>What the recruiter knows about the company and role</span>
                    <button onClick={() => void runResearch()} disabled={research.busy || !recruiter.company.trim() || !caps.webResearch}>
                      {research.busy ? "Researching…" : recruiter.brief ? "Research again" : "Research the company"}
                    </button>
                  </div>
                  {research.busy && (
                    <span className="muted small">Searching the web and reading the posting. This takes up to a minute.</span>
                  )}
                  {research.error && (
                    <span className="small warn">
                      Research failed: {research.error}. The recruiter will still know what you typed above.
                    </span>
                  )}
                  {recruiter.brief ? (
                    <textarea rows={6} value={recruiter.brief} onChange={(e) => setRecruiter({ brief: e.target.value })} />
                  ) : (
                    !research.busy && (
                      <span className="muted small">
                        {recruiter.company.trim()
                          ? "Not researched yet. It runs automatically when you start, or click the button to review it first."
                          : "Add a company to have it researched. Without one, the recruiter plays a large tech company hiring for your background."}
                      </span>
                    )
                  )}
                </div>
                <div className="field">
                  <div className="field-row">
                    <span>Your resume (optional)</span>
                    <label className="file-btn">
                      Upload PDF
                      <input
                        type="file"
                        accept="application/pdf"
                        onChange={(e) => {
                          void uploadResume(e.target.files?.[0]);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {resumeNote && <span className="muted small">{resumeNote}</span>}
                  <textarea
                    rows={5}
                    value={background}
                    placeholder="Upload a PDF or paste your resume. The recruiter reads it like your application: it'll ask about specific roles, gaps and claims, and the debrief rewrites your answers using it."
                    onChange={(e) => {
                      setBackground(e.target.value);
                      try {
                        localStorage.setItem("background", e.target.value);
                      } catch {}
                    }}
                  />
                </div>
                <label className="field">
                  <span>Recruiter style and extra instructions</span>
                  <textarea rows={2} value={persona} onChange={(e) => setPersona(e.target.value)} />
                </label>
              </>
            ) : (
              <label className="field">
                <span>Interviewer setup (system prompt)</span>
                <textarea rows={8} value={persona} onChange={(e) => setPersona(e.target.value)} />
              </label>
            )}
            <div className="row">
              <label className="field">
                <span>Length (min)</span>
                <input type="number" min={10} max={90} value={duration} onChange={(e) => setDuration(Number(e.target.value) || 45)} />
              </label>
              <label className="field">
                <span>Pushback</span>
                <select
                  value={pushback}
                  onChange={(e) => {
                    const v = e.target.value as Pushback;
                    setPushback(v);
                    try {
                      localStorage.setItem("pushback", v);
                    } catch {}
                  }}
                >
                  <option value="gentle">Gentle</option>
                  <option value="realistic">Realistic</option>
                  <option value="tough">Tough</option>
                </select>
              </label>
              <label className="field grow">
                <span>Voice</span>
                <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                  {KOKORO_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <span className="muted small">{kokoroLabel(kokoroStatus)}</span>
              </label>
            </div>
            <label className="field">
              <span>Speech recognition</span>
              <select value={stt} onChange={(e) => setStt(e.target.value as "whisper" | "browser")}>
                <option value="whisper" disabled={!whisperUp}>
                  Local Whisper (private, best with tech terms){whisperUp ? "" : " — not running"}
                </option>
                <option value="browser">Browser built-in (Chrome or Safari only)</option>
              </select>
            </label>
            {stt === "whisper" && (
              <div className="field">
                <span>Noise gate: {gate}</span>
                <div className="cal-row">
                  <input type="range" min={0} max={100} value={gate} onChange={(e) => setGate(Number(e.target.value))} />
                  <button onClick={calibrate} disabled={cal.step === "quiet" || cal.step === "speak"}>
                    {cal.step === "done" ? "Recalibrate" : "Calibrate mic"}
                  </button>
                </div>
                {cal.step === "idle" && (
                  <span className="muted small">
                    Measures your room's background noise and your voice, then sets the gate between them (about 10 seconds).
                  </span>
                )}
                {(cal.step === "quiet" || cal.step === "speak") && (
                  <div className="cal-box">
                    {cal.step === "quiet" ? (
                      <b>Stay quiet for 3 seconds…</b>
                    ) : (
                      <>
                        <b>Now read this aloud at your normal volume:</b>
                        <div className="cal-sentence">"{CAL_SENTENCE}"</div>
                      </>
                    )}
                    <MicMeter level={micLevel} gate={gate} />
                  </div>
                )}
                {cal.step === "done" && cal.result && (
                  <span className={`small ${cal.result.ok ? "muted" : "warn"}`}>
                    {cal.result.ok ? "✓ " : "⚠ "}
                    {cal.result.message} Room noise {levelToGateLabel(cal.result.noise)}
                    {cal.result.speech ? `, your voice ${levelToGateLabel(cal.result.speech)}` : ""}, gate set to {cal.result.gate}.
                  </span>
                )}
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={headphones}
                onChange={(e) => {
                  setHeadphones(e.target.checked);
                  try {
                    localStorage.setItem("headphones", e.target.checked ? "1" : "0");
                  } catch {}
                }}
              />
              I'm wearing headphones (lets you talk over the interviewer to cut it off; turn off if using speakers)
            </label>
            {caps.fast && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={fast}
                  onChange={(e) => {
                    setFast(e.target.checked);
                    try {
                      localStorage.setItem("fast", e.target.checked ? "1" : "0");
                    } catch {}
                  }}
                />
                Faster replies (the interviewer starts talking about half a second sooner, but each call costs twice as much)
              </label>
            )}
            {mode !== "recruiter" && (
              <label className="check">
                <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.target.checked)} />
                Send whiteboard screenshots too (better at reading layout and handwriting, slightly higher cost)
              </label>
            )}
            <button className="primary" onClick={start} disabled={(!drill && !persona.trim()) || research.busy || activeKey === "none"}>
              {research.busy
                ? "Researching the company…"
                : drill
                  ? "Start the drill"
                  : mode === "recruiter"
                    ? "Start the call"
                    : "Start interview"}
            </button>
          </div>
        </div>
      )}

      {phase === "history" && <History onClose={() => setPhase(loopRef.current ? "feedback" : "setup")} onDrill={startDrill} />}

      {phase === "feedback" && (
        <div className="modal-backdrop">
          <div className="modal wide">
            <div className="modal-head">
              <h2>Debrief</h2>
              <span className="muted">Session cost ≈ ${cost.toFixed(2)}</span>
            </div>
            <div className="feedback">
              {feedbackDone && loopRef.current?.id && (
                <DrillPicker sessionId={drill?.from ?? loopRef.current.id} mode={mode ?? "system_design"} onPick={startDrill} />
              )}
              {feedback ? (
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(feedback) }} />
              ) : (
                <p className="muted">Writing your feedback…</p>
              )}
            </div>
            <div className="row end">
              <button className="link" onClick={() => setPhase("history")}>
                Past calls
              </button>
              <span className="grow" />
              <button onClick={() => navigator.clipboard.writeText(feedback)} disabled={!feedbackDone}>
                Copy
              </button>
              <button onClick={() => setPhase("live")}>{mode === "recruiter" ? "Back to call" : "Back to board"}</button>
              <button className="primary" onClick={() => location.reload()}>
                New interview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
