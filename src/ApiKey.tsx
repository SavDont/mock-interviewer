// Bring your own key: pick a provider and paste an API key. The key goes only to the local server
// (which keeps it in memory and sends it only to that provider). "Remember" also keeps it in this
// browser's localStorage so you don't have to paste it again after a restart.

import { useState } from "react";

export type ProviderId = "anthropic" | "openai";
export type KeySource = "app" | "env" | "cli-login" | "none";

export interface ProviderStatus {
  active: ProviderId;
  model: string;
  providers: { id: ProviderId; label: string; env: string; model: string; keySource: KeySource }[];
  keyError: string | null;
  capabilities: { fast: boolean; webResearch: boolean };
}

const REMEMBERED = "apiKeys";

function remembered(): Partial<Record<ProviderId, string>> {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED) ?? "{}") as Partial<Record<ProviderId, string>>;
  } catch {
    return {};
  }
}

function remember(p: ProviderId, key: string | null) {
  const all = remembered();
  if (key) all[p] = key;
  else delete all[p];
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(all));
  } catch {
    // storage unavailable: the key still works until the server restarts
  }
}

async function post(path: string, body: unknown, method = "POST"): Promise<ProviderStatus> {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = (await r.json()) as ProviderStatus & { error?: string };
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

/** After a server restart, hand it back any keys this browser remembers. */
export async function restoreRememberedKeys(status: ProviderStatus): Promise<ProviderStatus> {
  let next = status;
  for (const [p, key] of Object.entries(remembered()) as [ProviderId, string][]) {
    if (key && next.providers.find((x) => x.id === p)?.keySource === "none") {
      try {
        next = await post("/api/settings/key", { provider: p, key });
      } catch {
        // a stale key: leave it for the user to fix in the form
      }
    }
  }
  // Restoring a key switches to that provider; switch back to the one that was active.
  if (next.active !== status.active && status.providers.find((x) => x.id === status.active)?.keySource !== "none") {
    next = await post("/api/settings/provider", { provider: status.active });
  }
  return next;
}

const SOURCE_LABEL: Record<KeySource, string> = {
  app: "key entered here",
  env: "key from .env",
  "cli-login": "signed in with `ant auth login`",
  none: "no key",
};

export function ApiKeyPanel({ status, onChange }: { status: ProviderStatus; onChange: (s: ProviderStatus) => void }) {
  const [provider, setProvider] = useState<ProviderId>(status.active);
  const [key, setKey] = useState("");
  const [keep, setKeep] = useState(() => !!remembered()[status.active]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = status.providers.find((p) => p.id === provider);

  const run = async (f: () => Promise<ProviderStatus>) => {
    setBusy(true);
    setError("");
    try {
      onChange(await f());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const s = await post("/api/settings/key", { provider, key: key.trim() });
      remember(provider, keep ? key.trim() : null);
      setKey("");
      return s;
    });

  const use = (p: ProviderId) => {
    setProvider(p);
    setKeep(!!remembered()[p]);
    if (status.providers.find((x) => x.id === p)?.keySource !== "none") void run(() => post("/api/settings/provider", { provider: p }));
  };

  return (
    <div className="key-panel">
      <div className="field">
        <span>Model provider</span>
        <div className="seg">
          {status.providers.map((p) => (
            <button key={p.id} className={provider === p.id ? "on" : ""} onClick={() => use(p.id)} disabled={busy}>
              {p.label}
            </button>
          ))}
        </div>
        {current && (
          <span className="muted small">
            {current.model} · {SOURCE_LABEL[current.keySource]}
            {status.active === provider && status.keyError ? "" : current.keySource !== "none" ? " ✓" : ""}
          </span>
        )}
      </div>
      <label className="field">
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={provider === "openai" ? "sk-..." : "sk-ant-..."}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && void save()}
        />
        <span className="muted small">
          Or set {current?.env} in .env. The key is sent only to the local server, which uses it to call{" "}
          {provider === "openai" ? "OpenAI" : "Anthropic"}. It is never written to disk or logged.
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        Remember it in this browser (stored in localStorage on this computer)
      </label>
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={busy || !key.trim()}>
          {busy ? "Checking…" : "Save key"}
        </button>
        {current?.keySource === "app" && (
          <button
            onClick={() => {
              remember(provider, null);
              void run(() => post("/api/settings/key", { provider }, "DELETE"));
            }}
            disabled={busy}
          >
            Forget key
          </button>
        )}
      </div>
      {(error || (status.active === provider && status.keyError)) && <div className="error">{error || status.keyError}</div>}
    </div>
  );
}
