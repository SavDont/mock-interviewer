// HTTP API for the browser app. Routes are thin: each one validates input and calls a module.

import { config } from "./config";
import { writeDebrief } from "./grading/grader";
import { getCall, listCalls, recurringWeakSpots, removeCall } from "./history";
import { commit, createSession, type TickInput, tick } from "./interview/flow";
import { DEFAULT_RECRUITER_PERSONA } from "./interview/prompts-recruiter";
import { DEFAULT_PERSONA } from "./interview/prompts-system-design";
import { boardPath, getSession } from "./interview/session";
import type { Pushback, RecruiterContext } from "./interview/types";
import { chooseProvider, clearAppKey, getProvider, MissingKeyError, ProviderError, providerStatus, setAppKey } from "./llm";
import { drillSetup, drillsFor } from "./memory/drills";
import { writeBrief } from "./research";
import { redact, refuseNonLocal } from "./security";
import { transcribe, whisperUp } from "./stt";

const json = (data: unknown, status = 200) => Response.json(data, { status });

function apiError(e: unknown): Response {
  if (e instanceof MissingKeyError) return json({ error: e.message, code: "no_key" }, 401);
  if (e instanceof ProviderError) return json({ error: e.message }, e.status);
  const message = redact((e as Error)?.message ?? String(e));
  console.error(`error: ${message}`);
  return json({ error: message }, 500);
}

let keyCheck: { for: string; at: number; error: string | null } | null = null;

/** Whether the active provider's credentials work. Checked at most once a minute. */
async function credentialProblem(): Promise<string | null> {
  const status = JSON.stringify(providerStatus());
  if (keyCheck && keyCheck.for === status && Date.now() - keyCheck.at < 60_000) return keyCheck.error;
  let error: string | null;
  try {
    error = await getProvider().check();
  } catch (e) {
    error = (e as Error).message;
  }
  keyCheck = { for: status, at: Date.now(), error };
  return error;
}

function capabilities() {
  try {
    return getProvider().capabilities;
  } catch {
    return { fast: false, webResearch: false };
  }
}

/** The :id path parameter. */
const idOf = (req: Bun.BunRequest<string>) => (req.params as { id?: string }).id ?? "";

const pushbackOf = (v: unknown): Pushback => (v === "gentle" || v === "tough" ? v : "realistic");

type Handler = (req: Bun.BunRequest<string>) => Response | Promise<Response>;
type Route = Handler | Partial<Record<"GET" | "POST" | "DELETE", Handler>>;

/** Every route refuses requests that don't come from this machine. */
function guarded(routes: Record<string, Route>) {
  const wrap =
    (h: Handler): Handler =>
    (req) => {
      const refused = refuseNonLocal(req.headers);
      return refused ? json({ error: refused }, 403) : h(req);
    };
  return Object.fromEntries(
    Object.entries(routes).map(([path, r]) => [
      path,
      typeof r === "function" ? wrap(r) : Object.fromEntries(Object.entries(r).map(([m, h]) => [m, wrap(h as Handler)])),
    ]),
  );
}

const routes: Record<string, Route> = {
  "/api/health": async () =>
    json({ ...providerStatus(), keyError: await credentialProblem(), capabilities: capabilities(), whisper: await whisperUp() }),

  // API keys entered in the app. Kept in memory only, never written to disk or logged.
  "/api/settings/key": {
    POST: async (req) => {
      const { provider, key } = (await req.json()) as { provider?: string; key?: string };
      const invalid = setAppKey(provider, key);
      if (invalid) return json({ error: invalid }, 400);
      keyCheck = null;
      return json({ ...providerStatus(), keyError: await credentialProblem(), capabilities: capabilities() });
    },
    DELETE: async (req) => {
      const { provider } = (await req.json()) as { provider?: string };
      clearAppKey(provider);
      keyCheck = null;
      return json({ ...providerStatus(), keyError: await credentialProblem(), capabilities: capabilities() });
    },
  },
  "/api/settings/provider": {
    POST: async (req) => {
      try {
        chooseProvider(((await req.json()) as { provider?: string }).provider);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json({ ...providerStatus(), keyError: await credentialProblem(), capabilities: capabilities() });
    },
  },

  // Body: 16kHz mono WAV. Returns { text }.
  "/api/transcribe": {
    POST: async (req) => {
      try {
        const context = decodeURIComponent(req.headers.get("x-context") ?? "");
        return json({ text: await transcribe(await req.arrayBuffer(), context) });
      } catch {
        return json({ error: "Local Whisper isn't running. Start the app with `bun run dev`." }, 503);
      }
    },
  },

  // Body: { source, company, role }. Researches the company and role on the web. Returns { brief }.
  "/api/brief": {
    POST: async (req) => {
      const { source, company, role } = (await req.json()) as { source?: string; company?: string; role?: string };
      if (!company?.trim()) return json({ error: "Enter a company name or website first." }, 400);
      try {
        return json({ brief: await writeBrief({ source: source === "applied" ? "applied" : "outreach", company, role: role ?? "" }) });
      } catch (e) {
        return apiError(e);
      }
    },
  },

  "/api/default-persona": (req) =>
    json({ persona: new URL(req.url).searchParams.get("mode") === "recruiter" ? DEFAULT_RECRUITER_PERSONA : DEFAULT_PERSONA }),

  // Past calls.
  "/api/calls": () => json({ calls: listCalls(), weakSpots: recurringWeakSpots() }),
  "/api/calls/:id": {
    GET: (req) => {
      const call = getCall(idOf(req));
      return call ? json(call) : json({ error: "not found" }, 404);
    },
    DELETE: (req) => (removeCall(idOf(req)) ? json({ ok: true }) : json({ error: "not found" }, 404)),
  },
  "/api/calls/:id/board": (req) => {
    if (!getSession(idOf(req))) return json({ error: "not found" }, 404);
    return new Response(Bun.file(boardPath(idOf(req))), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  },
  // Drills on a call's weak spots: proposes up to three (about 20 seconds the first time, then cached).
  "/api/calls/:id/drills": {
    POST: async (req) => {
      const s = getSession(idOf(req));
      if (!s) return json({ error: "not found" }, 404);
      try {
        return json({ drills: await drillsFor(s) });
      } catch (e) {
        return apiError(e);
      }
    },
  },

  "/api/session": {
    POST: async (req) => {
      const body = (await req.json()) as {
        persona?: string;
        pushback?: string;
        mode?: string;
        background?: string;
        source?: string;
        company?: string;
        role?: string;
        brief?: string;
        drill?: { from: string; index: number };
        fast?: boolean;
      };
      try {
        getProvider(); // fail now, with a clear message, if there's no key
      } catch (e) {
        return apiError(e);
      }
      const pushback = pushbackOf(body.pushback);
      const fast = body.fast !== false && config.fastDefault;
      if (body.drill) {
        // A drill reuses the original call's setup; only the pushback level comes from the form.
        const from = getSession(body.drill.from);
        if (!from) return json({ error: "The call this drill is based on wasn't found." }, 404);
        try {
          return json({ sessionId: createSession({ ...drillSetup(from, body.drill.index), pushback, fast }).id });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
      const mode = body.mode === "recruiter" ? "recruiter" : "system_design";
      const recruiter: RecruiterContext = {
        source: body.source === "outreach" || body.source === "applied" ? body.source : "",
        company: (body.company ?? "").slice(0, 500),
        role: (body.role ?? "").slice(0, 20000),
        brief: (body.brief ?? "").slice(0, 20000),
      };
      const persona = body.persona?.trim() || (mode === "recruiter" ? DEFAULT_RECRUITER_PERSONA : DEFAULT_PERSONA);
      const s = createSession({ persona, pushback, mode, background: (body.background ?? "").slice(0, 20000), recruiter, fast });
      return json({ sessionId: s.id });
    },
  },

  // Streams newline-delimited JSON: {"t":"head"} once speak and urgency are known, {"t":"say"} text
  // pieces as they're generated, then {"t":"done", ...decision} or {"t":"error"}.
  "/api/tick": {
    POST: async (req) => {
      const body = (await req.json()) as { sessionId: string } & TickInput;
      const s = getSession(body.sessionId);
      if (!s) return json({ error: "unknown session" }, 404);
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (o: object) => {
            try {
              controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
            } catch {
              // the page went away
            }
          };
          try {
            send({ t: "done", ...(await tick(s, body, send)) });
          } catch (e) {
            const r = apiError(e);
            send({ t: "error", status: r.status, ...((await r.json()) as object) });
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    },
  },

  "/api/commit": {
    POST: async (req) => {
      const { sessionId, said, interrupted, at } = (await req.json()) as {
        sessionId: string;
        said: string;
        interrupted: boolean;
        at: string;
      };
      const s = getSession(sessionId);
      if (!s) return json({ error: "unknown session" }, 404);
      commit(s, String(said), !!interrupted, String(at));
      return json({ ok: true });
    },
  },

  // Streams the debrief as plain text.
  "/api/feedback": {
    POST: async (req) => {
      const { sessionId, scene, image } = (await req.json()) as { sessionId: string; scene: string; image?: string };
      const s = getSession(sessionId);
      if (!s) return json({ error: "unknown session" }, 404);
      const enc = new TextEncoder();
      // If the page goes away mid-stream (reload, closed tab), stop the model call.
      const abort = new AbortController();
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (t: string) => {
            if (closed) return;
            try {
              controller.enqueue(enc.encode(t));
            } catch {
              closed = true;
              abort.abort();
            }
          };
          try {
            await writeDebrief(s, scene, image, send, abort.signal);
          } catch (e) {
            if (!abort.signal.aborted)
              send(`\n\n**Error generating feedback:** ${((await apiError(e).json()) as { error: string }).error}`);
          }
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        },
        cancel() {
          closed = true;
          abort.abort();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },
  },
};

Bun.serve({
  hostname: "127.0.0.1", // never reachable from other machines
  port: config.port,
  idleTimeout: 255,
  routes: guarded(routes),
  fetch: () => json({ error: "not found" }, 404),
});

const { active, model } = providerStatus();
console.log(`interviewer server on http://localhost:${config.port} (${active}, ${model})`);
credentialProblem().then((err) => console.log(err ? `⚠️  ${err}` : "✓ API credentials OK"));
