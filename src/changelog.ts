import { classify, compareVersions, parseKey, parseSemver } from "./charts";

export type State = Record<string, string>;

export interface Change {
  key: string;
  kind: "upgraded" | "downgraded" | "added" | "removed" | "changed";
  from?: string;
  to?: string;
  type?: string; // MAJOR | MINOR | PATCH, upgrades only
}

export interface ChangeLinks {
  notesUrl?: string;
  closes?: number;
}

export const HEADER =
  "# Helm Chart Changelog\n\nAutomatically maintained by [ArgoCD Helm Chart Scanner](https://github.com/juniyadi/argocd-helm-chart-scanner).";

const STATE_LINE = /^<!-- helm-scanner-state: (.*) -->[ \t]*$/m;
const STATE_LINES = /^<!-- helm-scanner-state: .* -->[ \t]*$/gm;

export function readState(text: string): State | null {
  const m = text.match(STATE_LINE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as State;
  } catch {
    return null; // corrupted state: treated as a first run
  }
}

export const stateLine = (s: State) =>
  `<!-- helm-scanner-state: ${JSON.stringify(Object.fromEntries(Object.keys(s).sort().map((k) => [k, s[k]])))} -->`;

export function diffState(prev: State, cur: State): Change[] {
  const changes: Change[] = [];
  for (const key of [...new Set([...Object.keys(prev), ...Object.keys(cur)])].sort()) {
    const from = prev[key];
    const to = cur[key];
    if (from === to) continue;
    if (from === undefined) changes.push({ key, kind: "added", to });
    else if (to === undefined) changes.push({ key, kind: "removed", from });
    else if (parseSemver(from) && parseSemver(to) && compareVersions(to, from) !== 0) {
      changes.push(
        compareVersions(to, from) > 0
          ? { key, kind: "upgraded", from, to, type: classify(from, to).toUpperCase() }
          : { key, kind: "downgraded", from, to },
      );
    } else changes.push({ key, kind: "changed", from, to });
  }
  return changes;
}

export function renderChange(c: Change, links: ChangeLinks = {}): string {
  const { file, chart } = parseKey(c.key);
  const head = {
    upgraded: `\`${c.from}\` → \`${c.to}\` (${c.type})`,
    downgraded: `\`${c.from}\` → \`${c.to}\` (DOWNGRADE)`,
    changed: `\`${c.from}\` → \`${c.to}\` (CHANGED)`,
    added: `added at \`${c.to}\``,
    removed: `removed (was \`${c.from}\`)`,
  }[c.kind];
  let line = `- **${chart}** ${head} · \`${file}\``;
  if (links.notesUrl) line += ` · [release notes](${links.notesUrl})`;
  if (links.closes) line += ` · closes #${links.closes}`;
  return line;
}

export function updateChangelog(
  existing: string | null,
  cur: State,
  today: string,
  links: Map<string, ChangeLinks> = new Map(),
): { text: string; changed: boolean; changes: Change[] } {
  const prev = existing === null ? null : readState(existing);
  const content = (existing ?? "").replace(STATE_LINES, "").trimEnd();

  if (prev === null) {
    return { text: `${content || HEADER}\n\n${stateLine(cur)}\n`, changed: true, changes: [] };
  }

  const changes = diffState(prev, cur);
  if (changes.length === 0) return { text: existing!, changed: false, changes };

  const entries = changes.map((c) => renderChange(c, links.get(c.key)));
  const lines = content.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  if (first !== -1 && lines[first].trim() === `## ${today}`) {
    let end = lines.findIndex((l, i) => i > first && l.startsWith("## "));
    if (end === -1) end = lines.length;
    while (end > first + 1 && lines[end - 1].trim() === "") end--;
    lines.splice(end, 0, ...entries);
  } else if (first === -1) {
    lines.push("", `## ${today}`, "", ...entries);
  } else {
    lines.splice(first, 0, `## ${today}`, "", ...entries, "");
  }
  return { text: `${lines.join("\n").trimEnd()}\n\n${stateLine(cur)}\n`, changed: true, changes };
}
