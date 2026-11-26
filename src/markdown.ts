// Tiny markdown renderer for the debrief (headings, lists, bold/italic, code, tables).
// Input is escaped first, so model output can't inject HTML.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();

    if (t.startsWith("|") && lines[i + 1]?.trim().match(/^\|?\s*:?-+/)) {
      closeList();
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => inline(c.trim()));
      const head = cells(t);
      i++;
      const rows: string[][] = [];
      while (lines[i + 1]?.trim().startsWith("|")) rows.push(cells(lines[++i]!));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }

    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const n = Math.min(h[1]!.length + 1, 4);
      out.push(`<h${n}>${inline(h[2]!)}</h${n}>`);
      continue;
    }

    const ul = t.match(/^[-*]\s+(.*)$/);
    const ol = t.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul ?? ol)![1]!)}</li>`);
      continue;
    }

    closeList();
    if (t) out.push(`<p>${inline(t)}</p>`);
  }
  closeList();
  return out.join("\n");
}
