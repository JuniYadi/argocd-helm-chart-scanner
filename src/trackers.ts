import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChartResult, DriftGroup, UpdateType } from "./charts";

export interface ExecOptions {
  input?: string;
  env?: Record<string, string>;
}
export type Exec = (args: string[], opts?: ExecOptions) => { ok: boolean; out: string; err: string };

export const run =
  (cmd: string, cwd?: string, timeoutMs = 60_000): Exec =>
  (args, opts = {}) => {
    let p: ReturnType<typeof Bun.spawnSync>;
    try {
      p = Bun.spawnSync([cmd, ...args], {
        cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      });
    } catch (err) {
      return { ok: false, out: "", err: `${cmd}: ${(err as Error).message}` };
    }
    const err = p.exitCode === null ? `${cmd} timed out after ${timeoutMs} ms` : p.stderr.toString().trim();
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err };
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
  return [
    `v${v}`,
    v,
    `${chart}-${v}`,
    `${chart}-v${v}`,
    `helm-v${v}`,
    `helm-${chart}-${v}`,
    `${chart}-helm-chart-${v}`,
    `v${chart}-${v}`,
    `chart-v${v}`,
    `chart-${v}`,
  ];
}

const NOTES_LIMIT = 4000;

interface Release {
  tag_name: string;
  html_url: string;
  body?: string;
}

// One `gh api` call per repo per run: cached per `gh` instance, so fresh fakes in tests get fresh caches.
const releaseCache = new WeakMap<Exec, Map<string, Release[]>>();

function listReleases(gh: Exec, repo: string): Release[] {
  let cache = releaseCache.get(gh);
  if (!cache) {
    cache = new Map();
    releaseCache.set(gh, cache);
  }
  if (!cache.has(repo)) {
    const r = gh(["api", `repos/${repo}/releases?per_page=100`]);
    let releases: Release[] = [];
    if (r.ok) {
      try {
        releases = JSON.parse(r.out);
      } catch {
        releases = []; // gh exited 0 but printed something unexpected
      }
    }
    cache.set(repo, releases);
  }
  return cache.get(repo)!;
}

export function resolveReleaseInfo(gh: Exec, chart: string, current: string, latest: string, sources: string[]): ReleaseInfo {
  const artifactHubUrl = `https://artifacthub.io/packages/search?ts_query_web=${encodeURIComponent(chart)}`;
  const repos = githubRepos(sources);
  for (const repo of repos) {
    const releases = listReleases(gh, repo);
    const byTag = new Map(releases.map((r) => [r.tag_name, r]));
    for (const tag of candidateTags(chart, latest)) {
      const rel = byTag.get(tag);
      if (!rel) continue;
      let notes = rel.body?.trim() || undefined;
      if (notes && notes.length > NOTES_LIMIT) {
        notes = `${notes.slice(0, NOTES_LIMIT)}\n\n*(Truncated. See the full notes via the release link.)*`;
      }
      const latestClean = latest.replace(/^v/i, "");
      const guess = rel.tag_name.includes(latestClean) ? rel.tag_name.replace(latestClean, current.replace(/^v/i, "")) : undefined;
      const curTag = guess && (byTag.has(guess) || gh(["release", "view", guess, "--repo", repo, "--json", "tagName"]).ok) ? guess : undefined;
      return {
        repo,
        tag: rel.tag_name,
        url: rel.html_url,
        compareUrl: curTag ? `https://github.com/${repo}/compare/${curTag}...${rel.tag_name}` : undefined,
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
// The marker is always the last line we write; the last match ignores look-alikes in upstream release notes.
export const readMarker = (body: string) => [...body.matchAll(/<!-- helm-scanner:key=(.+?) -->/g)].pop()?.[1] ?? null;
export const branchName = (key: string) =>
  "helm-scanner/" +
  key
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");

export const renderTitle = (r: ChartResult) =>
  `[Helm Update] ${r.chart} ${r.current} → ${r.latest} (${r.type.toUpperCase()}) in ${r.file}`;

/** Length of the longest run of consecutive "~" in `text`, so a code fence can always outrun it. */
export const longestTildeRun = (text: string) => Math.max(0, ...[...text.matchAll(/~+/g)].map((m) => m[0].length));

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
    const fence = "~".repeat(Math.max(3, longestTildeRun(info.notes) + 1));
    out.push(`<details>`, `<summary>📋 Upstream release notes</summary>`, ``, `${fence}text`, info.notes, fence, `</details>`, ``);
  }

  out.push(`### 📝 Checklist`, `- [ ] Review the upstream release notes`, `- [ ] Check breaking changes and deprecated \`values.yaml\` fields`);
  if (!ctx.pr) out.push(`- [ ] Update \`targetRevision\` in \`${r.file}\``);
  out.push(`- [ ] Verify the ArgoCD sync after merge`, ``);
  out.push(`*Managed by [ArgoCD Helm Chart Scanner](https://github.com/juniyadi/argocd-helm-chart-scanner).*`, marker(r.key));
  return out.join("\n");
}

// ---------- trackers ----------

export interface Tracker {
  kind: "issue" | "pr";
  number: number;
  key: string;
  title: string;
  body: string;
  url: string;
}

export function listTrackers(gh: Exec, label: string): Tracker[] {
  const out: Tracker[] = [];
  for (const kind of ["issue", "pr"] as const) {
    const r = gh([kind, "list", "--state", "open", "--label", label, "--limit", "500", "--json", "number,title,body,url"]);
    if (!r.ok) throw new Error(`gh ${kind} list failed: ${r.err} (tracker modes need issues and pull-requests read access)`);
    for (const t of JSON.parse(r.out || "[]") as { number: number; title: string; body?: string; url: string }[]) {
      const key = readMarker(t.body ?? "");
      if (key) out.push({ kind, key, number: t.number, title: t.title, body: t.body ?? "", url: t.url });
    }
  }
  return out;
}

/** Creates missing labels; returns failures other than "already exists" as warnings. */
export function ensureLabels(gh: Exec, labels: string[]): string[] {
  const warnings: string[] = [];
  for (const l of labels) {
    const r = gh(["label", "create", l, "--color", "0E8A16", "--description", "Managed by ArgoCD Helm Chart Scanner"]);
    if (!r.ok && !/already exists/i.test(r.err)) warnings.push(`label "${l}": ${r.err}`);
  }
  return warnings;
}

export interface Planned {
  result: ChartResult;
  action: "issue" | "pr" | "manual";
  title: string;
  body: string;
  newText?: string;
}

export type Op =
  | { kind: "create-issue"; key: string; title: string; body: string; supersede?: Tracker }
  | { kind: "update-issue"; key: string; tracker: Tracker; title: string; body: string; supersede?: Tracker }
  | { kind: "keep"; key: string; tracker: Tracker; supersede?: Tracker }
  | {
      kind: "upsert-pr";
      key: string;
      file: string;
      newText: string;
      message: string;
      title: string;
      body: string;
      existing?: Tracker;
      push: boolean;
      supersede?: Tracker;
    }
  | { kind: "close"; key: string; tracker: Tracker; comment: string; resolved: boolean };

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();

export function planTrackers(items: Planned[], open: Tracker[], results: ChartResult[], inScope: (key: string) => boolean = () => true): Op[] {
  const ops: Op[] = [];
  const byKey = new Map(results.map((r) => [r.key, r]));
  const find = (key: string, kind: Tracker["kind"]) => open.find((t) => t.key === key && t.kind === kind);

  for (const t of open) {
    const r = byKey.get(t.key);
    if (!r) {
      // Only close a vanished source within the scanned scope; a run over one path must not touch another path's trackers.
      if (inScope(t.key)) ops.push({ kind: "close", key: t.key, tracker: t, comment: "Chart source no longer found in the scanned manifests.", resolved: false });
    } else if (r.type === "none") ops.push({ kind: "close", key: t.key, tracker: t, comment: `Upgraded to \`${r.current}\`.`, resolved: true });
    // ponytail: errors/unknown leave trackers alone, so a flaky registry never closes an issue.
  }

  for (const it of items) {
    const key = it.result.key;
    const issue = find(key, "issue");
    const pr = find(key, "pr");
    if (it.action === "pr") {
      const push = !pr || pr.title !== it.title;
      if (pr && !push && sameText(pr.body, it.body)) {
        ops.push({ kind: "keep", key, tracker: pr, supersede: issue });
      } else {
        ops.push({
          kind: "upsert-pr",
          key,
          file: it.result.file,
          newText: it.newText!,
          message: `chore(helm): bump ${it.result.chart} to ${it.result.latest} in ${it.result.file}`,
          title: it.title,
          body: it.body,
          existing: pr,
          push,
          supersede: issue,
        });
      }
    } else if (issue && issue.title === it.title && sameText(issue.body, it.body)) {
      ops.push({ kind: "keep", key, tracker: issue, supersede: pr });
    } else if (issue) {
      ops.push({ kind: "update-issue", key, tracker: issue, title: it.title, body: it.body, supersede: pr });
    } else {
      ops.push({ kind: "create-issue", key, title: it.title, body: it.body, supersede: pr });
    }
  }
  return ops;
}

export const PR_PERMISSION_HINT =
  'Enable "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General), or pass a PAT / GitHub App token via the `token` input.';

export interface ApplyContext {
  gh: Exec;
  git: Exec;
  labels: string[];
  token: string;
  serverUrl: string;
  baseBranch: () => string;
}

export interface ApplyResult {
  urls: Map<string, string>;
  resolved: Map<string, number>;
  errors: string[];
}

/** Commits `text` as `file` on top of HEAD into `branch` without touching the working tree or index. */
export function pushBranch(ctx: ApplyContext, branch: string, file: string, text: string, message: string) {
  const git = (what: string, args: string[], opts?: ExecOptions) => {
    const r = ctx.git(args, opts);
    if (!r.ok) throw new Error(`git ${what}: ${r.err}`);
    return r.out;
  };
  const index = join(tmpdir(), `helm-scanner-${process.pid}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const mode = git("ls-files", ["ls-files", "-s", "--", file]).split(" ")[0] || "100644";
    const blob = git("hash-object", ["hash-object", "-w", "--stdin"], { input: text });
    git("read-tree", ["read-tree", "HEAD"], { env });
    git("update-index", ["update-index", "--cacheinfo", `${mode},${blob},${file}`], { env });
    const tree = git("write-tree", ["write-tree"], { env });
    const commit = git("commit-tree", [
      "-c", "user.name=github-actions[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit-tree", tree, "-p", "HEAD", "-m", message,
    ]);
    const header = `http.${ctx.serverUrl}/.extraheader`;
    const auth = Buffer.from(`x-access-token:${ctx.token}`).toString("base64");
    console.log(`::add-mask::${auth}`);
    // The empty value resets headers inherited from actions/checkout before adding ours.
    git("push", ["-c", `${header}=`, "-c", `${header}=AUTHORIZATION: basic ${auth}`, "push", "-q", "--force", "origin", `${commit}:refs/heads/${branch}`]);
  } finally {
    rmSync(index, { force: true });
  }
}

export function applyOps(ops: Op[], ctx: ApplyContext): ApplyResult {
  const res: ApplyResult = { urls: new Map(), resolved: new Map(), errors: [] };
  const lastLine = (s: string) => s.split("\n").pop()!;
  const close = (t: Tracker, comment: string) => {
    const args =
      t.kind === "pr"
        ? ["pr", "close", String(t.number), "--comment", comment, "--delete-branch"]
        : ["issue", "close", String(t.number), "--comment", comment];
    const r = ctx.gh(args);
    if (!r.ok) res.errors.push(`close ${t.kind} #${t.number}: ${r.err}`);
    return r.ok;
  };

  for (const op of ops) {
    try {
      let number: number;
      let url: string;
      if (op.kind === "close") {
        if (close(op.tracker, op.comment) && op.resolved) res.resolved.set(op.key, op.tracker.number);
        continue;
      } else if (op.kind === "keep") {
        ({ number, url } = op.tracker);
      } else if (op.kind === "update-issue") {
        const r = ctx.gh(["issue", "edit", String(op.tracker.number), "--title", op.title, "--body-file", "-"], { input: op.body });
        if (!r.ok) throw new Error(`gh issue edit #${op.tracker.number}: ${r.err}`);
        ({ number, url } = op.tracker);
      } else if (op.kind === "create-issue") {
        const r = ctx.gh(["issue", "create", "--title", op.title, "--body-file", "-", "--label", ctx.labels.join(",")], { input: op.body });
        if (!r.ok) throw new Error(`gh issue create: ${r.err}`);
        url = lastLine(r.out);
        number = Number(url.split("/").pop());
        if (Number.isNaN(number)) throw new Error(`could not read the issue number from gh output: ${r.out}`);
      } else {
        const branch = branchName(op.key);
        if (op.push) pushBranch(ctx, branch, op.file, op.newText, op.message);
        if (op.existing) {
          const r = ctx.gh(["pr", "edit", String(op.existing.number), "--title", op.title, "--body-file", "-"], { input: op.body });
          if (!r.ok) throw new Error(`gh pr edit #${op.existing.number}: ${r.err}`);
          ({ number, url } = op.existing);
        } else {
          const r = ctx.gh(
            ["pr", "create", "--base", ctx.baseBranch(), "--head", branch, "--title", op.title, "--body-file", "-", "--label", ctx.labels.join(",")],
            { input: op.body },
          );
          if (!r.ok) {
            throw new Error(
              /not permitted to create or approve pull requests/i.test(r.err)
                ? `GitHub Actions cannot create pull requests in this repository. ${PR_PERMISSION_HINT}`
                : `gh pr create: ${r.err}`,
            );
          }
          url = lastLine(r.out);
          number = Number(url.split("/").pop());
          if (Number.isNaN(number)) throw new Error(`could not read the pr number from gh output: ${r.out}`);
        }
      }
      res.urls.set(op.key, url);
      if (op.supersede) close(op.supersede, `Superseded by #${number}.`);
    } catch (err) {
      res.errors.push(`${op.key}: ${(err as Error).message}`);
    }
  }
  return res;
}
