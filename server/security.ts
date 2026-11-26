// The API runs on your machine and spends your API credits, so it only answers your own browser:
// it listens on 127.0.0.1, and every request must come from a local page. This blocks other
// websites from calling it (cross-site requests) and DNS-rebinding tricks that point a public
// name at 127.0.0.1.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader: string): string {
  // "localhost:5173" -> "localhost", "[::1]:8787" -> "[::1]"
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : (hostHeader.split(":")[0] ?? "");
}

/** Returns why a request is refused, or null if it's from this machine. */
export function refuseNonLocal(headers: Headers): string | null {
  const host = headers.get("host");
  if (!host || !LOCAL_HOSTS.has(hostnameOf(host).toLowerCase())) return "This server only accepts requests addressed to localhost.";
  const origin = headers.get("origin");
  if (origin) {
    let hostname = "";
    try {
      hostname = new URL(origin).hostname;
    } catch {
      // treated as non-local below
    }
    if (!LOCAL_HOSTS.has(hostname) && !LOCAL_HOSTS.has(`[${hostname}]`)) return "Requests from other websites are not allowed.";
  }
  return null;
}

// Things that look like API keys or bearer tokens, so they can be scrubbed from anything logged.
const SECRET = /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/** Removes anything that looks like a key from a string before it is logged or shown. */
export function redact(text: string): string {
  return text.replace(SECRET, "[redacted]");
}
