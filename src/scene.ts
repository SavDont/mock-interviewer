// Turns the Excalidraw scene into a compact text description the interviewer can "see",
// and diffs consecutive descriptions so it hears about changes like "added box 'Redis'".

interface El {
  id: string;
  type: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  text?: string;
  containerId?: string | null;
  name?: string | null;
  points?: readonly (readonly [number, number])[];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  frameId?: string | null;
  strokeStyle?: string;
}

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "frame", "magicframe", "image", "embeddable", "iframe"]);

export interface SceneSnapshot {
  text: string; // full description, with coarse positions
  items: Map<string, string>; // element id -> position-free description (for diffs)
  version: number;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function sceneVersion(elements: readonly El[]): number {
  let v = 0;
  for (const e of elements) v += e.version * (e.isDeleted ? -1 : 1);
  return v + elements.length * 1e6;
}

export function describeScene(raw: readonly unknown[]): SceneSnapshot {
  const elements = (raw as El[]).filter((e) => !e.isDeleted);
  const byId = new Map(elements.map((e) => [e.id, e]));

  // Label of a container = text bound to it.
  const labelOf = new Map<string, string>();
  for (const e of elements) {
    if (e.type === "text" && e.containerId && e.text) labelOf.set(e.containerId, clean(e.text));
  }
  for (const e of elements) if ((e.type === "frame" || e.type === "magicframe") && e.name) labelOf.set(e.id, clean(e.name));

  const shapes = elements.filter((e) => SHAPES.has(e.type));
  // Unlabeled shapes get a nickname derived from their id, so it never shifts as the scene changes.
  const nameOf = (e: El): string => {
    const l = labelOf.get(e.id);
    return l ? `"${l}"` : `(unlabeled ${e.type === "rectangle" ? "box" : e.type} ${e.id.slice(-4)})`;
  };

  const contains = (s: El, px: number, py: number, pad: number) =>
    px >= s.x - pad && px <= s.x + s.width + pad && py >= s.y - pad && py <= s.y + s.height + pad;

  // Find what an arrow endpoint touches when it isn't formally bound.
  const nearestShape = (px: number, py: number): El | undefined => {
    let best: El | undefined;
    let bestArea = Infinity;
    for (const s of shapes) {
      if (s.type === "frame" || s.type === "magicframe") continue;
      if (contains(s, px, py, 30)) {
        const area = s.width * s.height;
        if (area < bestArea) {
          best = s;
          bestArea = area;
        }
      }
    }
    return best;
  };

  const items = new Map<string, string>();
  const lines: string[] = [];
  const pos = (e: El) => `@(${Math.round(e.x / 10) * 10},${Math.round(e.y / 10) * 10} ${Math.round(e.width)}x${Math.round(e.height)})`;

  const boxLines: string[] = [];
  for (const s of [...shapes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const frame = s.frameId && byId.get(s.frameId) ? ` in frame ${nameOf(byId.get(s.frameId)!)}` : "";
    const kind = s.type === "rectangle" ? "box" : s.type;
    const desc = `${kind} ${nameOf(s)}${frame}`;
    items.set(s.id, desc);
    boxLines.push(`- ${desc} ${pos(s)}`);
  }

  const edgeLines: string[] = [];
  for (const a of elements.filter((e) => e.type === "arrow" || e.type === "line")) {
    const pts = a.points ?? [];
    const first = pts[0] ?? [0, 0];
    const last = pts[pts.length - 1] ?? [0, 0];
    const from = (a.startBinding && byId.get(a.startBinding.elementId)) || nearestShape(a.x + first[0], a.y + first[1]);
    const to = (a.endBinding && byId.get(a.endBinding.elementId)) || nearestShape(a.x + last[0], a.y + last[1]);
    const label = labelOf.get(a.id);
    const arrow = a.type === "arrow" ? "→" : "—";
    const dashed = a.strokeStyle && a.strokeStyle !== "solid" ? " (dashed)" : "";
    const desc = `${from ? nameOf(from) : "(nothing)"} ${arrow} ${to ? nameOf(to) : "(nothing)"}${label ? ` labeled "${label}"` : ""}${dashed}`;
    items.set(a.id, `${a.type} ${desc}`);
    edgeLines.push(`- ${desc}`);
  }

  const textLines: string[] = [];
  for (const t of elements.filter((e) => e.type === "text" && !e.containerId && e.text?.trim())) {
    const desc = `text "${clean(t.text!)}"`;
    items.set(t.id, desc);
    textLines.push(`- ${desc} ${pos(t)}`);
  }

  const sketches = elements.filter((e) => e.type === "freedraw").length;
  if (sketches) items.set("__freedraw", `${sketches} freehand stroke(s)`);

  if (boxLines.length) lines.push("Components:", ...boxLines);
  if (edgeLines.length) lines.push("Connections:", ...edgeLines);
  if (textLines.length) lines.push("Free text / notes:", ...textLines);
  if (sketches) lines.push(`Also ${sketches} freehand pen stroke(s) (not readable as text; see screenshot if attached).`);

  return { text: lines.join("\n"), items, version: sceneVersion(elements) };
}

export function diffScenes(prev: SceneSnapshot | null, next: SceneSnapshot): string[] {
  const before = prev?.items ?? new Map<string, string>();
  const changes: string[] = [];
  for (const [id, desc] of next.items) {
    const old = before.get(id);
    if (old === undefined) changes.push(`added ${desc}`);
    else if (old !== desc) changes.push(describeEdit(old, desc));
  }
  for (const [id, desc] of before) if (!next.items.has(id)) changes.push(`removed ${desc}`);
  return changes;
}

const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * One element changed. Typing into a big box changes it on every keystroke, so instead of the whole
 * text before and after, say only what was added or removed and where (the full current board is
 * sent separately). Saves thousands of tokens per call.
 */
export function describeEdit(old: string, next: string): string {
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let e = 0;
  while (e < old.length - p && e < next.length - p && old[old.length - 1 - e] === next[next.length - 1 - e]) e++;
  const removed = old.slice(p, old.length - e);
  const added = next.slice(p, next.length - e);
  if (old.length + next.length < 160) return `changed ${old} ⇒ ${next}`;
  const where = p > 0 ? ` after "…${next.slice(Math.max(0, p - 30), p)}"` : "";
  const what = [removed && `removed "${short(removed, 120)}"`, added && `added "${short(added, 200)}"`].filter(Boolean).join(" and ");
  return `edited ${short(next, 40)}: ${what}${where}`;
}
