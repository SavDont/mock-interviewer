// Past calls: every saved session (server/.sessions), with its transcript and debrief.

import { useEffect, useState } from "react";
import type { Mode } from "./loop";
import { renderMarkdown } from "./markdown";

interface CallSummary {
  id: string;
  mode: Mode;
  startedAt: string;
  title: string;
  durationSec: number;
  answers: number;
  verdict: string;
  hasFeedback: boolean;
  costUsd: number;
}
interface CallDetail extends CallSummary {
  log: string[];
  notes: string[];
  feedback: string;
  hasBoard: boolean;
  drill?: { from: string; title: string; why: string };
}

interface WeakSpots {
  mode: Mode;
  calls: number;
  areas: { area: string; average: number; calls: number }[];
}

export interface DrillPlan {
  title: string;
  why: string;
  minutes: number;
  scenario: string;
  opening: string;
  checklist: string[];
  probes: string[];
}
/** What the app needs to set up a drill session. */
export interface DrillChoice {
  from: string; // the call the drill is based on
  index: number;
  mode: Mode;
  title: string;
  why: string;
  minutes: number;
}

/** Proposes drills on a call's weak spots (from its debrief) and lets the candidate pick one. */
export function DrillPicker({ sessionId, mode, onPick }: { sessionId: string; mode: Mode; onPick: (d: DrillChoice) => void }) {
  const [state, setState] = useState<{ busy: boolean; drills?: DrillPlan[]; error?: string }>({ busy: false });
  const load = async () => {
    setState({ busy: true });
    try {
      const r = await fetch(`/api/calls/${sessionId}/drills`, { method: "POST" });
      const d = (await r.json()) as { drills?: DrillPlan[]; error?: string };
      if (!r.ok || !d.drills) throw new Error(d.error || `HTTP ${r.status}`);
      setState({ busy: false, drills: d.drills });
    } catch (e) {
      setState({ busy: false, error: (e as Error).message });
    }
  };
  if (!state.drills) {
    return (
      <div className="drill-cta">
        <button onClick={load} disabled={state.busy}>
          {state.busy ? "Picking your weak spots…" : "Practice a weak spot"}
        </button>
        <span className="muted small">
          {state.busy
            ? "Reading the debrief (about 20 seconds)."
            : "A 10-minute drill that starts right at something this debrief flagged."}
        </span>
        {state.error && <span className="small warn">{state.error}</span>}
      </div>
    );
  }
  return (
    <div className="drill-list">
      <b>Pick a drill</b>
      {state.drills.map((d, i) => (
        <div key={i} className="drill-card">
          <div className="drill-card-main">
            <div>
              <b>{d.title}</b> <span className="muted small">· about {d.minutes} min</span>
            </div>
            <div className="small">{d.why}</div>
          </div>
          <button
            className="primary"
            onClick={() => onPick({ from: sessionId, index: i, mode, title: d.title, why: d.why, minutes: d.minutes })}
          >
            Start
          </button>
        </div>
      ))}
    </div>
  );
}

const MODE_LABEL: Record<Mode, string> = { recruiter: "Recruiter screen", system_design: "System design" };

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function mins(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`;
}

/** Good verdicts green, bad red, the rest neutral. */
function verdictClass(v: string): string {
  if (/^(strong advance|advance|strong yes|yes|lean yes)$/i.test(v)) return "good";
  if (/^(not advancing|strong no|no|lean no)$/i.test(v)) return "bad";
  return "";
}

type Line = { at: string; who: "candidate" | "interviewer" | "board" | "system"; text: string; cut?: boolean };

function parseLog(log: string[]): Line[] {
  return log.map((l) => {
    const m = /^\[(\d+:\d+)\]\s*(Candidate|Interviewer|Whiteboard):\s*([\s\S]*)$/.exec(l);
    if (!m) return { at: /^\[(\d+:\d+)\]/.exec(l)?.[1] ?? "", who: "system", text: l.replace(/^\[\d+:\d+\]\s*/, "") };
    const who = m[2] === "Candidate" ? "candidate" : m[2] === "Interviewer" ? "interviewer" : "board";
    let text = m[3]!;
    const cut = /\(interrupted\)$/.test(text);
    text = text.replace(/\s*\(interrupted\)$/, "").replace(/^"([\s\S]*)"$/, "$1");
    return { at: m[1]!, who, text, cut };
  });
}

export function History({ onClose, onDrill }: { onClose: () => void; onDrill: (d: DrillChoice) => void }) {
  const [calls, setCalls] = useState<CallSummary[] | null>(null);
  const [weak, setWeak] = useState<WeakSpots[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<CallDetail | null>(null);
  const [writing, setWriting] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [tab, setTab] = useState<"transcript" | "board" | "notes">("transcript");

  const load = () =>
    fetch("/api/calls")
      .then((r) => r.json())
      .then((d: { calls: CallSummary[]; weakSpots: WeakSpots[] }) => {
        setCalls(d.calls);
        setWeak(d.weakSpots ?? []);
      })
      .catch(() => setError("Couldn't load past calls. Is the server running?"));
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once when the list opens
  useEffect(() => {
    void load();
  }, []);

  const openCall = async (id: string) => {
    setError("");
    const r = await fetch(`/api/calls/${id}`);
    if (!r.ok) return setError("Couldn't open that call.");
    setOpen((await r.json()) as CallDetail);
    setTab("transcript");
  };

  /** Writes the debrief for a call that never got one (it's saved with the call). */
  const writeDebrief = async () => {
    if (!open) return;
    setWriting(true);
    setOpen({ ...open, feedback: "" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: open.id, scene: "" }),
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        setOpen((o) => (o ? { ...o, feedback: text } : o));
      }
      await openCall(open.id); // pick up the saved verdict and cost
      void load();
    } finally {
      setWriting(false);
    }
  };

  const remove = async (c: CallSummary) => {
    if (
      !confirm(`Remove "${c.title}" from ${when(c.startedAt)} from your past calls? (The file is moved to .sessions/deleted, not erased.)`)
    )
      return;
    await fetch(`/api/calls/${c.id}`, { method: "DELETE" });
    setOpen(null);
    void load();
  };

  if (open) {
    const lines = parseLog(open.log).filter((l) => showBoard || l.who !== "board");
    return (
      <div className="modal-backdrop">
        <div className="modal wide past">
          <div className="modal-head">
            <div>
              <h2>{open.title}</h2>
              <div className="muted small">
                {MODE_LABEL[open.mode]} · {when(open.startedAt)} · {mins(open.durationSec)} · ${open.costUsd.toFixed(2)}
              </div>
            </div>
            {open.verdict && <span className={`verdict ${verdictClass(open.verdict)}`}>{open.verdict}</span>}
          </div>
          <div className="past-body">
            <div className="past-col">
              <div className="past-col-head">
                <div className="tabs">
                  <button className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}>
                    Transcript
                  </button>
                  {open.mode !== "recruiter" && (
                    <button className={tab === "board" ? "on" : ""} onClick={() => setTab("board")}>
                      Board
                    </button>
                  )}
                  <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
                    Interviewer notes
                  </button>
                </div>
                {tab === "transcript" && open.mode !== "recruiter" && (
                  <label className="small">
                    <input type="checkbox" checked={showBoard} onChange={(e) => setShowBoard(e.target.checked)} /> board events
                  </label>
                )}
              </div>
              {tab === "notes" ? (
                <div className="notes">{open.notes.length ? open.notes.map((n, i) => <div key={i}>• {n}</div>) : <i>No notes.</i>}</div>
              ) : tab === "board" ? (
                <div className="board-view">
                  {open.hasBoard ? (
                    <img src={`/api/calls/${open.id}/board`} alt="The whiteboard at the end of the call" />
                  ) : (
                    <p className="muted">No whiteboard was saved for this call. Boards are saved from now on, when you end a call.</p>
                  )}
                </div>
              ) : (
                <div className="transcript">
                  {lines.map((t, i) => (
                    <div key={i} className={`line ${t.who}`}>
                      <span className="at">{t.at}</span>
                      <span className="who">
                        {t.who === "candidate" ? "You" : t.who === "interviewer" ? "Interviewer" : t.who === "board" ? "Board" : ""}
                      </span>
                      <span className="text">
                        {t.text}
                        {t.cut ? " (cut off)" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="past-col">
              <div className="past-col-head">
                <b>Debrief</b>
              </div>
              <div className="feedback">
                {open.drill && <p className="muted small">Drill from an earlier call: {open.drill.why}</p>}
                {open.feedback && !writing && (
                  <DrillPicker key={open.id} sessionId={open.drill?.from ?? open.id} mode={open.mode} onPick={onDrill} />
                )}
                {open.feedback ? (
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(open.feedback) }} />
                ) : writing ? (
                  <p className="muted">Writing your feedback…</p>
                ) : (
                  <div>
                    <p className="muted">This call doesn't have a saved debrief yet.</p>
                    <button className="primary" onClick={writeDebrief}>
                      Write the debrief
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="row end">
            <button className="link danger-link" onClick={() => remove(open)}>
              Remove
            </button>
            <span className="grow" />
            {open.feedback && !writing && (
              <>
                <button onClick={() => navigator.clipboard.writeText(open.feedback)}>Copy debrief</button>
                <button onClick={writeDebrief}>Rewrite debrief</button>
              </>
            )}
            <button onClick={() => setOpen(null)}>All calls</button>
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <div className="modal-head">
          <h2>Past calls</h2>
          <button className="link" onClick={onClose}>
            Back
          </button>
        </div>
        <p className="muted">Every call is saved on this computer with its transcript and debrief.</p>
        {weak.map((w) => {
          const low = w.areas.filter((a) => a.average < 3).slice(0, 3);
          if (!low.length) return null;
          return (
            <p key={w.mode} className="small weak-spots">
              <b>
                Recurring weak spots ({MODE_LABEL[w.mode].toLowerCase()}, {w.calls} graded {w.calls === 1 ? "call" : "calls"}):
              </b>{" "}
              {low.map((a) => `${a.area} (avg ${a.average.toFixed(1)})`).join(", ")}
            </p>
          );
        })}
        {error && <div className="error">{error}</div>}
        {calls === null ? (
          <p className="muted">Loading…</p>
        ) : calls.length === 0 ? (
          <p className="muted">No calls yet. They'll show up here after your first one.</p>
        ) : (
          <div className="call-list">
            {calls.map((c) => (
              <button key={c.id} className="call-row" onClick={() => void openCall(c.id)}>
                <span className="call-main">
                  <b>{c.title}</b>
                  <span className="muted small">
                    {MODE_LABEL[c.mode]} · {when(c.startedAt)} · {mins(c.durationSec)}
                  </span>
                </span>
                {c.verdict ? (
                  <span className={`verdict ${verdictClass(c.verdict)}`}>{c.verdict}</span>
                ) : (
                  <span className="muted small">{c.hasFeedback ? "Debrief saved" : "No debrief yet"}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
