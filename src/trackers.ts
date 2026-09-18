import type { ChartResult, DriftGroup, UpdateType } from "./charts";

export interface ExecOptions {
  input?: string;
  env?: Record<string, string>;
}
export type Exec = (args: string[], opts?: ExecOptions) => { ok: boolean; out: string; err: string };

export const run =
  (cmd: string, cwd?: string): Exec =>
  (args, opts = {}) => {
    const p = Bun.spawnSync([cmd, ...args], {
      cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  };

// ---------- release notes ----------

export interface ReleaseInfo {
  repo?: string;
  tag?: string;
  url?: string;
  compareUrl?: string;
  notes?: string;
  artifactHubUrl: string;
}

export function githubRepos(urls: string[]): string[] {
  const repos = new Set<string>();
  for (const url of urls) {
    const gh = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
    if (gh) repos.add(`${gh[1]}/${gh[2].replace(/\.git$/, "")}`);
    const pages = url.match(/^https?:\/\/([\w-]+)\.github\.io\/([\w.-]+)/);
    if (pages) repos.add(`${pages[1]}/${pages[2]}`);
  }
  return [...repos];
}

export function candidateTags(chart: string, version: string): string[] {
  const v = version.replace(/^v/i, "");
  return [`v${v}`, v, `${chart}-${v}`, `${chart}-v${v}`, `helm-v${v}`, `helm-${chart}-${v}`, `${chart}-helm-chart-${v}`, `v${chart}-${v}`];
}

const NOTES_LIMIT = 4000;

export function resolveReleaseInfo(gh: Exec, chart: string, current: string, latest: string, sources: string[]): ReleaseInfo {
  const artifactHubUrl = `https://artifacthub.io/packages/search?ts_query_web=${encodeURIComponent(chart)}`;
  const repos = githubRepos(sources);
  for (const repo of repos) {
    for (const tag of candidateTags(chart, latest)) {
      const r = gh(["release", "view", tag, "--repo", repo, "--json", "tagName,url,body"]);
      if (!r.ok) continue;
      const data = JSON.parse(r.out) as { tagName: string; url: string; body?: string };
      let notes = data.body?.trim() || undefined;
      if (notes && notes.length > NOTES_LIMIT) {
        notes = `${notes.slice(0, NOTES_LIMIT)}\n\n*(Truncated. See the full notes via the release link.)*`;
      }
      const curTag = candidateTags(chart, current).find((t) => gh(["release", "view", t, "--repo", repo, "--json", "tagName"]).ok);
      return {
        repo,
        tag: data.tagName,
        url: data.url,
        compareUrl: curTag ? `https://github.com/${repo}/compare/${curTag}...${data.tagName}` : undefined,
        notes,
        artifactHubUrl,
      };
    }
  }
  return repos.length ? { repo: repos[0], url: `https://github.com/${repos[0]}/releases`, artifactHubUrl } : { artifactHubUrl };
}

// ---------- routing and in-place edit ----------

export type Action = "report" | "issue" | "pr" | "manual";

export function route(type: UpdateType, issueTypes: Set<string>, prTypes: Set<string>): "report" | "issue" | "pr" {
  if (prTypes.has(type)) return "pr";
  if (issueTypes.has(type)) return "issue";
  return "report";
}

/** Rewrites exactly one `targetRevision: <current>` line; returns null when zero or several lines match. */
export function editTargetRevision(text: string, current: string, latest: string): string | null {
  const esc = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^([ \\t]*(?:-[ \\t]+)?targetRevision:[ \\t]*)(["']?)${esc}\\2([ \\t]*(?:#.*)?)$`, "gm");
  if ((text.match(re) ?? []).length !== 1) return null;
  return text.replace(re, (_m, pre: string, q: string, post: string) => `${pre}${q}${latest}${q}${post}`);
}

// ---------- markers, titles, bodies ----------

export const marker = (key: string) => `<!-- helm-scanner:key=${key} -->`;
export const readMarker = (body: string) => body.match(/<!-- helm-scanner:key=(.+?) -->/)?.[1] ?? null;
export const branchName = (key: string) =>
  "helm-scanner/" +
  key
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");

export const renderTitle = (r: ChartResult) =>
  `[Helm Update] ${r.chart} ${r.current} → ${r.latest} (${r.type.toUpperCase()}) in ${r.file}`;

export interface BodyContext {
  info: ReleaseInfo;
  drift: DriftGroup[];
  manual: boolean;
  pr: boolean;
}

export function renderBody(r: ChartResult, ctx: BodyContext): string {
  const { info } = ctx;
  const out: string[] = [];
  if (r.deprecated) {
    out.push(`> [!WARNING]`, `> \`${r.chart}\` ${r.latest} is marked **deprecated** upstream. Plan a replacement.`, ``);
  }
  if (ctx.manual) {
    out.push(
      `> [!NOTE]`,
      `> The scanner could not safely edit \`targetRevision\` in \`${r.file}\` (zero or several matching lines). Update it manually.`,
      ``,
    );
  }
  out.push(
    `### 📦 Helm chart update`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Chart | \`${r.chart}\` |`,
    `| Application | \`${r.app}\` |`,
    `| Manifest | \`${r.file}\` |`,
    `| Repository | \`${r.repoURL}\` |`,
    `| Current | \`${r.current}\` |`,
    `| Latest | \`${r.latest}\` |`,
    `| Update type | **${r.type.toUpperCase()}** |`,
    ``,
  );

  const others = ctx.drift.find((g) => g.members.some((m) => m.key === r.key))?.members.filter((m) => m.key !== r.key) ?? [];
  if (others.length) out.push(`**Also deployed in:** ${others.map((m) => `\`${m.file}\` (${m.app}) at \`${m.current}\``).join(", ")}`, ``);

  out.push(`### 🔗 Links`);
  if (info.url) out.push(`- 🚀 Release notes: [${info.tag ?? r.latest}](${info.url})`);
  if (info.compareUrl) out.push(`- 🔀 Compare: [\`${r.current}...${r.latest}\`](${info.compareUrl})`);
  out.push(`- 📦 Artifact Hub: [${r.chart}](${info.artifactHubUrl})`);
  if (info.repo) out.push(`- 📂 Upstream: https://github.com/${info.repo}`);
  out.push(``);

  if (info.notes) {
    out.push(`<details>`, `<summary>📋 Upstream release notes</summary>`, ``, info.notes, ``, `</details>`, ``);
  }

  out.push(`### 📝 Checklist`, `- [ ] Review the upstream release notes`, `- [ ] Check breaking changes and deprecated \`values.yaml\` fields`);
  if (!ctx.pr) out.push(`- [ ] Update \`targetRevision\` in \`${r.file}\``);
  out.push(`- [ ] Verify the ArgoCD sync after merge`, ``);
  out.push(`*Managed by [ArgoCD Helm Chart Scanner](https://github.com/juniyadi/argocd-helm-chart-scanner).*`, marker(r.key));
  return out.join("\n");
}
