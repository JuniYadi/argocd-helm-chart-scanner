import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChartResult } from "./charts";
import {
  applyOps,
  listTrackers,
  marker,
  planTrackers,
  PR_PERMISSION_HINT,
  run,
  type ApplyContext,
  type Exec,
  type Planned,
  type Tracker,
} from "./trackers";

const result = (over: Partial<ChartResult> = {}): ChartResult => ({
  key: "tools/reloader/helm.yml#reloader/reloader",
  file: "tools/reloader/helm.yml",
  app: "reloader",
  chart: "reloader",
  repoURL: "https://stakater.github.io/stakater-charts",
  current: "2.2.5",
  latest: "2.2.17",
  type: "patch",
  deprecated: false,
  sources: ["https://github.com/stakater/Reloader"],
  ...over,
});

/** Fake exec: answers by matching the joined args against [pattern, output] rules; records every call. */
function fakeExec(rules: [RegExp, string | false][] = []) {
  const calls: { args: string[]; input?: string }[] = [];
  const exec: Exec = (args, opts) => {
    calls.push({ args, input: opts?.input });
    const hit = rules.find(([re]) => re.test(args.join(" ")));
    if (!hit || hit[1] === false) return { ok: !hit, out: "", err: hit ? "boom" : "" };
    return { ok: true, out: hit[1], err: "" };
  };
  return { exec, calls };
}

describe("listTrackers", () => {
  test("keeps only marked issues and PRs", () => {
    const issues = [{ number: 1, title: "a", body: marker("k1"), url: "u1" }, { number: 2, title: "b", body: "manual issue", url: "u2" }];
    const prs = [{ number: 3, title: "c", body: marker("k2"), url: "u3" }];
    const { exec } = fakeExec([
      [/^issue list/, JSON.stringify(issues)],
      [/^pr list/, JSON.stringify(prs)],
    ]);
    expect(listTrackers(exec, "helm-update").map((t) => [t.kind, t.number, t.key])).toEqual([
      ["issue", 1, "k1"],
      ["pr", 3, "k2"],
    ]);
  });

  test("throws when gh cannot list", () => {
    const { exec } = fakeExec([[/list/, false]]);
    expect(() => listTrackers(exec, "helm-update")).toThrow(/gh issue list failed/);
  });
});

const tracker = (over: Partial<Tracker>): Tracker => ({ kind: "issue", number: 1, key: "k", title: "t", body: "b", url: "u", ...over });
const planned = (r: ChartResult, action: Planned["action"], title = "T", body = "B"): Planned => ({ result: r, action, title, body, newText: "new" });

describe("planTrackers", () => {
  test("closes resolved and vanished trackers but never errored ones", () => {
    const ok = result({ key: "ok", type: "none" });
    const err = result({ key: "err", type: "unknown", error: "HTTP 500" });
    const ops = planTrackers([], [tracker({ key: "ok" }), tracker({ key: "err", number: 2 }), tracker({ key: "gone", number: 3 })], [ok, err]);
    expect(ops.map((o) => [o.kind, o.key, o.kind === "close" && o.resolved])).toEqual([
      ["close", "ok", true],
      ["close", "gone", false],
    ]);
  });

  test("issue: create, keep, update", () => {
    const r = result({ key: "k" });
    expect(planTrackers([planned(r, "issue")], [], [r])[0].kind).toBe("create-issue");
    expect(planTrackers([planned(r, "issue", "t", "b")], [tracker({})], [r])[0].kind).toBe("keep");
    expect(planTrackers([planned(r, "issue", "t2", "b")], [tracker({})], [r])[0].kind).toBe("update-issue");
    expect(planTrackers([planned(r, "manual", "t", "b\r\n")], [tracker({})], [r])[0].kind).toBe("keep");
  });

  test("pr: new PR pushes, same title only edits, identical keeps", () => {
    const r = result({ key: "k" });
    const pr = tracker({ kind: "pr", number: 9 });
    const fresh = planTrackers([planned(r, "pr")], [], [r])[0];
    expect(fresh).toMatchObject({ kind: "upsert-pr", push: true, message: "chore(helm): bump reloader to 2.2.17 in tools/reloader/helm.yml" });
    expect(planTrackers([planned(r, "pr", "t", "changed")], [pr], [r])[0]).toMatchObject({ kind: "upsert-pr", push: false });
    expect(planTrackers([planned(r, "pr", "newer", "b")], [pr], [r])[0]).toMatchObject({ kind: "upsert-pr", push: true });
    expect(planTrackers([planned(r, "pr", "t", "b")], [pr], [r])[0].kind).toBe("keep");
  });

  test("one tracker per key: the other kind is superseded", () => {
    const r = result({ key: "k" });
    const issue = tracker({});
    const pr = tracker({ kind: "pr", number: 9 });
    expect(planTrackers([planned(r, "pr")], [issue], [r])[0]).toMatchObject({ kind: "upsert-pr", supersede: issue });
    expect(planTrackers([planned(r, "issue")], [pr], [r])[0]).toMatchObject({ kind: "create-issue", supersede: pr });
  });
});

const ctx = (gh: Exec, git: Exec = fakeExec().exec): ApplyContext => ({
  gh,
  git,
  labels: ["helm-update", "deps"],
  token: "tkn",
  serverUrl: "https://github.com",
  baseBranch: () => "main",
});

describe("applyOps", () => {
  test("create issue, then close the superseded PR with the new number", () => {
    const { exec, calls } = fakeExec([[/^issue create/, "https://github.com/o/r/issues/42"]]);
    const out = applyOps([{ kind: "create-issue", key: "k", title: "T", body: "B", supersede: tracker({ kind: "pr", number: 9 }) }], ctx(exec));
    expect(out.urls.get("k")).toBe("https://github.com/o/r/issues/42");
    expect(calls[0]).toEqual({ args: ["issue", "create", "--title", "T", "--body-file", "-", "--label", "helm-update,deps"], input: "B" });
    expect(calls[1].args).toEqual(["pr", "close", "9", "--comment", "Superseded by #42.", "--delete-branch"]);
  });

  test("resolved closes are reported for the changelog; failures become errors", () => {
    const { exec } = fakeExec([[/^issue close 2/, false]]);
    const out = applyOps(
      [
        { kind: "close", key: "a", tracker: tracker({ number: 1 }), comment: "Upgraded", resolved: true },
        { kind: "close", key: "b", tracker: tracker({ number: 2 }), comment: "Upgraded", resolved: true },
      ],
      ctx(exec),
    );
    expect([...out.resolved]).toEqual([["a", 1]]);
    expect(out.errors).toEqual(["close issue #2: boom"]);
  });

  test("PR permission failure yields the settings hint", () => {
    const gh: Exec = (args) =>
      args[0] === "pr" && args[1] === "create"
        ? { ok: false, out: "", err: "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)" }
        : { ok: true, out: "", err: "" };
    const out = applyOps(
      [{ kind: "upsert-pr", key: "k", file: "f", newText: "x", message: "m", title: "T", body: "B", push: false }],
      ctx(gh),
    );
    expect(out.errors[0]).toContain(PR_PERMISSION_HINT);
  });

  test("upsert-pr commits to a branch on the remote without touching the working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "pr-"));
    const sh = (cwd: string, ...args: string[]) => {
      const r = run("git", cwd)(["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
      if (!r.ok) throw new Error(r.err);
      return r.out;
    };
    sh(root, "init", "-q", "--bare", "remote.git");
    sh(root, "init", "-q", "-b", "main", "work");
    const work = join(root, "work");
    writeFileSync(join(work, "app.yaml"), "spec:\n  source:\n    targetRevision: 1.0.0 # pinned\n");
    sh(work, "add", ".");
    sh(work, "commit", "-q", "-m", "init");
    sh(work, "remote", "add", "origin", join(root, "remote.git"));
    sh(work, "push", "-q", "origin", "main");

    const { exec: gh, calls } = fakeExec([[/^pr create/, "https://github.com/o/r/pull/7"]]);
    const newText = "spec:\n  source:\n    targetRevision: 1.1.0 # pinned\n";
    const out = applyOps(
      [{ kind: "upsert-pr", key: "app.yaml#a/c", file: "app.yaml", newText, message: "chore(helm): bump c to 1.1.0 in app.yaml", title: "T", body: "B", push: true }],
      ctx(gh, run("git", work)),
    );

    expect(out.errors).toEqual([]);
    expect(out.urls.get("app.yaml#a/c")).toBe("https://github.com/o/r/pull/7");
    const branch = "helm-scanner/app.yaml-a-c";
    expect(sh(root, "--git-dir", "remote.git", "show", `${branch}:app.yaml`)).toBe(newText.trimEnd());
    expect(sh(root, "--git-dir", "remote.git", "log", "-1", "--format=%an|%s", branch)).toBe("github-actions[bot]|chore(helm): bump c to 1.1.0 in app.yaml");
    expect(readFileSync(join(work, "app.yaml"), "utf8")).toContain("1.0.0"); // working tree untouched
    expect(sh(work, "status", "--porcelain")).toBe("");
    expect(calls[0].args).toEqual(["pr", "create", "--base", "main", "--head", branch, "--title", "T", "--body-file", "-", "--label", "helm-update,deps"]);
  });
});
