/**
 * The filed brief, split so the console can render one panel per heading.
 *
 * Same rules as the engine's parseBrief — this app cannot import src/.
 */
export interface BriefSection {
  heading: string;
  text: string;
}

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export function parseBrief(body: string): BriefSection[] {
  const trimmed = body.trim();
  if (trimmed === "") return [];
  if (!/^## /m.test(trimmed)) return [{ heading: "Problem", text: trimmed }];
  const sections: BriefSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = (): void => {
    if (heading === "") return;
    sections.push({ heading, text: buf.join("\n").trim() });
  };
  for (const line of trimmed.split("\n")) {
    const match = /^## (.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      heading = match[1];
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

export function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const [headerLine, ...rest] = lines;
  if (headerLine === undefined || rest.length === 0) return null;
  const cells = (line: string): string[] =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
  const headers = cells(headerLine);
  const data = rest.filter((line) => !/^\|[\s-|:]+\|$/.test(line));
  if (headers.length === 0 || data.length === 0) return null;
  return { headers, rows: data.map(cells) };
}

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > cursor) tokens.push({ kind: "text", text: text.slice(cursor, match.index) });
    if (match[1] !== undefined) tokens.push({ kind: "strong", text: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "code", text: match[2] });
    else if (match[3] !== undefined && match[4] !== undefined) {
      tokens.push({ kind: "link", text: match[3], href: match[4] });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", text: text.slice(cursor) });
  return tokens.length === 0 ? [{ kind: "text", text }] : tokens;
}
