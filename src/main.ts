import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { checkSource, findDrift, scanManifests, type ChartResult, type ChartSource, type DriftGroup } from "./charts";
import { diffState, readState, updateChangelog, type ChangeLinks, type State } from "./changelog";
import {
  applyOps,
  editTargetRevision,
  ensureLabels,
  listTrackers,
  planTrackers,
  PR_PERMISSION_HINT,
  renderBody,
  renderTitle,
  resolveReleaseInfo,
  route,
  run,
  type Action,
  type Planned,
} from "./trackers";

const TYPES = ["major", "minor", "patch"];
const isOutdated = (r: ChartResult) => TYPES.includes(r.type);

export interface Inputs {
  path: string;
  issueTypes: Set<string>;
  prTypes: Set<string>;
  labels: string[];
  changelogFile: string;
  token: string;
}

export function readInputs(env: Record<string, string | undefined>): Inputs {
  const list = (name: string) =>
    (env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const types = (name: string, input: string) => {
    const values = list(name).map((v) => v.toLowerCase());
    const bad = values.filter((v) => !TYPES.includes(v));
    if (bad.length) throw new Error(`${input}: unknown update type "${bad.join(", ")}". Use a comma list of major, minor, patch.`);
    return new Set(values);
  };

  const path = (env.INPUT_PATH ?? "").trim() || ".";
  if (!existsSync(path)) throw new Error(`path: "${path}" does not exist.`);
  const issueTypes = types("INPUT_ISSUE_TYPES", "issue-types");
  const prTypes = types("INPUT_PR_TYPES", "pr-types");
  const token = env.GH_TOKEN ?? "";
  if ((issueTypes.size || prTypes.size) && !token) throw new Error("token: required when issue-types or pr-types is set.");
  const labels = list("INPUT_LABELS");
  return {
    path,
    issueTypes,
    prTypes,
    labels: labels.length ? labels : ["helm-update"],
    changelogFile: (env.INPUT_CHANGELOG_FILE ?? "").trim(),
    token,
  };
}

/** A run over `dir` only owns tracker keys and changelog entries under that path. */
export const scopeOf = (dir: string): ((key: string) => boolean) =>
  dir === "." ? () => true : (key: string) => key.startsWith(`${dir}/`);

/** Out-of-scope entries survive untouched; in-scope entries are replaced by this run's scan. */
export function nextState(prev: State | null, sources: ChartSource[], inScope: (key: string) => boolean): State {
  const state: State = {};
  for (const [key, current] of Object.entries(prev ?? {})) if (!inScope(key)) state[key] = current;
  for (const s of sources) state[s.key] = s.current;
  return state;
}

/** Escapes a workflow command message per the `::warning::`/`::error::` data escaping rules. */
export const cmdEscape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** Escapes a workflow command property value: `cmdEscape` plus `:` and `,`. */
export const cmdProp = (s: string) => cmdEscape(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderSummary(results: ChartResult[], drift: DriftGroup[], actions: Map<string, Action>, urls: Map<string, string>): string {
  const outdated = results.filter(isOutdated);
  const tracked = outdated.filter((r) => (actions.get(r.key) ?? "report") !== "report");
  const errors = results.filter((r) => r.error);
  const deprecated = results.filter((r) => r.deprecated);
  const out = [
    `## ⎈ ArgoCD Helm Chart Scanner`,
    ``,
    `**Scanned:** ${results.length} · **Outdated:** ${outdated.length} · **Tracked:** ${tracked.length} · **Errors:** ${errors.length}`,
    ``,
  ];

  if (outdated.length) {
    out.push(`### Updates`, ``, `| Chart | File | Current | Latest | Type | Action | Tracker |`, `|---|---|---|---|---|---|---|`);
    for (const r of outdated) {
      const url = urls.get(r.key);
      out.push(
        `| ${r.deprecated ? "⚠️ " : ""}${r.chart} | \`${r.file}\` | ${r.current} | ${r.latest} | ${r.type.toUpperCase()} | ${actions.get(r.key) ?? "report"} | ${url ? `[#${url.split("/").pop()}](${url})` : "–"} |`,
      );
    }
    out.push(``);
  } else {
    out.push(`All Helm charts are up to date. 🎉`, ``);
  }

  if (deprecated.length) {
    out.push(`### ⚠️ Deprecated`, ``);
    for (const r of deprecated) out.push(`- **${r.chart}** ${r.latest} is deprecated upstream · \`${r.file}\``);
    out.push(``);
  }

  if (drift.length) {
    out.push(`### 🔀 Version drift`, ``);
    for (const g of drift) out.push(`- **${g.chart}** (\`${g.repoURL}\`): ${g.members.map((m) => `\`${m.file}\` (${m.app}) → ${m.current}`).join(", ")}`);
    out.push(``);
  }

  if (errors.length) {
    out.push(`### ❌ Errors and skipped`, ``, `| Chart | File | Message |`, `|---|---|---|`);
    for (const r of errors) out.push(`| ${r.chart} | \`${r.file}\` | ${cell(r.error!)} |`);
    out.push(``);
  }
  return out.join("\n");
}

function setOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const inputs = readInputs(process.env);
  const cwd = process.cwd();
  const dir = relative(cwd, resolve(cwd, inputs.path)) || ".";

  const { sources, warnings } = await scanManifests(dir);
  for (const w of warnings) console.log(`::warning file=${cmdProp(w.file)}::${cmdEscape(w.message)}`);
  console.log(`Found ${sources.length} Helm chart source(s) under ${dir}.`);

  const results: ChartResult[] = [];
  for (const s of sources) results.push(await checkSource(s));
  const drift = findDrift(sources);
  console.table(
    results.map((r) => ({ chart: r.chart, file: r.file, current: r.current, latest: r.latest ?? "-", type: r.type, note: r.error ?? (r.deprecated ? "deprecated" : "") })),
  );

  const gh = run("gh");
  const actions = new Map<string, Action>();
  const urls = new Map<string, string>();
  let resolved = new Map<string, number>();
  let failed = false;

  for (const r of results.filter(isOutdated)) actions.set(r.key, route(r.type, inputs.issueTypes, inputs.prTypes));

  if (inputs.issueTypes.size || inputs.prTypes.size) {
    for (const w of ensureLabels(gh, inputs.labels)) console.log(`::warning::${cmdEscape(w)}`);
    const open = listTrackers(gh, inputs.labels[0]);
    const items: Planned[] = [];
    for (const r of results.filter(isOutdated)) {
      let action = actions.get(r.key)!;
      if (action === "report") continue;
      let newText: string | undefined;
      if (action === "pr") {
        newText = editTargetRevision(readFileSync(r.file, "utf8"), r.current, r.latest!) ?? undefined;
        if (newText === undefined) action = "manual";
      }
      actions.set(r.key, action);
      const info = resolveReleaseInfo(gh, r.chart, r.current, r.latest!, r.sources);
      items.push({
        result: r,
        action: action as Planned["action"],
        title: renderTitle(r),
        body: renderBody(r, { info, drift, manual: action === "manual", pr: action === "pr" }),
        newText,
      });
    }

    let base: string | undefined;
    const outcome = applyOps(planTrackers(items, open, results, scopeOf(dir)), {
      gh,
      git: run("git", cwd),
      labels: inputs.labels,
      token: inputs.token,
      serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
      baseBranch: () => {
        if (base === undefined) {
          const r = gh(["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
          if (!r.ok || !r.out) throw new Error(`could not determine the default branch: ${r.err || "empty output from gh repo view"}`);
          base = r.out;
        }
        return base;
      },
    });
    outcome.urls.forEach((u, k) => urls.set(k, u));
    resolved = outcome.resolved;
    for (const e of outcome.errors) {
      if (e.includes(PR_PERMISSION_HINT)) {
        console.log(`::error::${cmdEscape(e)}`);
        failed = true;
      } else console.log(`::warning::${cmdEscape(e)}`);
    }
  }

  let changelogUpdated = false;
  if (inputs.changelogFile) {
    const file = inputs.changelogFile;
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    const prev = existing === null ? null : readState(existing);
    const state = nextState(prev, sources, scopeOf(dir));
    const links = new Map<string, ChangeLinks>();
    for (const c of prev ? diffState(prev, state) : []) {
      const link: ChangeLinks = { closes: resolved.get(c.key) };
      const r = results.find((x) => x.key === c.key);
      if (c.kind === "upgraded" && r) {
        const info = resolveReleaseInfo(gh, r.chart, c.from!, c.to!, r.sources);
        if (info.tag) link.notesUrl = info.url;
      }
      links.set(c.key, link);
    }
    const out = updateChangelog(existing, state, new Date().toISOString().slice(0, 10), links);
    if (out.changed) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, out.text);
      changelogUpdated = true;
      console.log(`Updated ${file} (${out.changes.length} new entr${out.changes.length === 1 ? "y" : "ies"}).`);
    }
  }

  const updates = results.filter(isOutdated).map((r) => ({
    file: r.file,
    app: r.app,
    chart: r.chart,
    repoURL: r.repoURL,
    current: r.current,
    latest: r.latest,
    type: r.type,
    deprecated: r.deprecated,
    action: actions.get(r.key) ?? "report",
    url: urls.get(r.key) ?? null,
  }));
  setOutput("updates", JSON.stringify(updates));
  setOutput("updates-count", String(updates.length));
  setOutput("changelog-updated", String(changelogUpdated));

  const summary = renderSummary(results, drift, actions, urls);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  else console.log(summary);
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    console.log(`::error::${cmdEscape((err as Error).message)}`);
    process.exit(1);
  });
}
