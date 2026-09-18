import { describe, expect, test } from "bun:test";
import type { ChartResult } from "./charts";
import {
  branchName,
  editTargetRevision,
  githubRepos,
  marker,
  readMarker,
  renderBody,
  renderTitle,
  resolveReleaseInfo,
  route,
  type Exec,
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

describe("release info", () => {
  test("githubRepos understands github.com and github.io URLs", () => {
    expect(
      githubRepos([
        "https://github.com/stakater/Reloader.git",
        "https://kubernetes-sigs.github.io/external-dns",
        "https://example.org",
      ]),
    ).toEqual(["stakater/Reloader", "kubernetes-sigs/external-dns"]);
  });

  test("resolveReleaseInfo finds the target tag and a compare link", () => {
    const { exec } = fakeExec([
      [/release view v2\.2\.17 /, JSON.stringify({ tagName: "v2.2.17", url: "https://github.com/stakater/Reloader/releases/tag/v2.2.17", body: "x".repeat(4100) })],
      [/release view v2\.2\.5 /, JSON.stringify({ tagName: "v2.2.5" })],
      [/release view/, false],
    ]);
    const info = resolveReleaseInfo(exec, "reloader", "2.2.5", "2.2.17", ["https://github.com/stakater/Reloader"]);
    expect(info.tag).toBe("v2.2.17");
    expect(info.compareUrl).toBe("https://github.com/stakater/Reloader/compare/v2.2.5...v2.2.17");
    expect(info.notes).toEndWith("*(Truncated. See the full notes via the release link.)*");
    expect(info.artifactHubUrl).toBe("https://artifacthub.io/packages/search?ts_query_web=reloader");
  });

  test("resolveReleaseInfo falls back to the releases page", () => {
    const { exec } = fakeExec([[/release view/, false]]);
    expect(resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", ["https://github.com/a/b"]).url).toBe("https://github.com/a/b/releases");
    expect(resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", []).url).toBeUndefined();
  });
});

describe("route", () => {
  test("PR wins over issue, otherwise report", () => {
    const issue = new Set(["major", "minor", "patch"]);
    const pr = new Set(["patch"]);
    expect(route("patch", issue, pr)).toBe("pr");
    expect(route("minor", issue, pr)).toBe("issue");
    expect(route("minor", new Set(), new Set())).toBe("report");
  });
});

describe("editTargetRevision", () => {
  test("plain value", () => {
    expect(editTargetRevision("  targetRevision: 1.0.5\n", "1.0.5", "1.1.0")).toBe("  targetRevision: 1.1.0\n");
  });
  test("quoted value and trailing comment are preserved", () => {
    expect(editTargetRevision(`    targetRevision: "1.0.5" # keep me\n`, "1.0.5", "1.1.0")).toBe(`    targetRevision: "1.1.0" # keep me\n`);
    expect(editTargetRevision(`targetRevision: '1.0.5'`, "1.0.5", "1.1.0")).toBe(`targetRevision: '1.1.0'`);
  });
  test("list-item form and CRLF", () => {
    expect(editTargetRevision("  - targetRevision: 1.0.5\r\n", "1.0.5", "1.1.0")).toBe("  - targetRevision: 1.1.0\r\n");
  });
  test("does not touch other keys or partial versions", () => {
    const text = "version: 1.0.5\ntargetRevision: 1.0.50\ntargetRevision: 1.0.5\n";
    expect(editTargetRevision(text, "1.0.5", "1.1.0")).toBe("version: 1.0.5\ntargetRevision: 1.0.50\ntargetRevision: 1.1.0\n");
  });
  test("zero or several matches are ambiguous", () => {
    expect(editTargetRevision("targetRevision: 2.0.0\n", "1.0.5", "1.1.0")).toBeNull();
    expect(editTargetRevision("targetRevision: 1.0.5\n---\ntargetRevision: 1.0.5\n", "1.0.5", "1.1.0")).toBeNull();
  });
});

describe("markers and rendering", () => {
  test("marker round-trip and branch names", () => {
    const key = "tools/reloader/helm.yml#reloader/reloader";
    expect(readMarker(`text\n${marker(key)}`)).toBe(key);
    expect(readMarker("no marker")).toBeNull();
    expect(branchName(key)).toBe("helm-scanner/tools-reloader-helm.yml-reloader-reloader");
    expect(branchName("/abs/../x.yaml#a/b")).toBe("helm-scanner/abs-.-x.yaml-a-b");
  });

  test("title", () => {
    expect(renderTitle(result())).toBe("[Helm Update] reloader 2.2.5 → 2.2.17 (PATCH) in tools/reloader/helm.yml");
  });

  test("body carries deprecated banner, drift note, manual note and marker", () => {
    const r = result({ deprecated: true });
    const drift = [{ chart: "reloader", repoURL: "x", members: [{ key: r.key, file: r.file, app: "reloader", current: "2.2.5" }, { key: "prod#reloader/reloader", file: "prod/r.yml", app: "reloader", current: "2.1.0" }] }];
    const body = renderBody(r, { info: { artifactHubUrl: "https://ah", url: "https://rel", tag: "v2.2.17" }, drift, manual: true, pr: false });
    expect(body).toContain("is marked **deprecated** upstream");
    expect(body).toContain("could not safely edit");
    expect(body).toContain("**Also deployed in:** `prod/r.yml` (reloader) at `2.1.0`");
    expect(body).toContain("- [ ] Update `targetRevision` in `tools/reloader/helm.yml`");
    expect(body).toEndWith(marker(r.key));
    const prBody = renderBody(result(), { info: { artifactHubUrl: "https://ah" }, drift: [], manual: false, pr: true });
    expect(prBody).not.toContain("Update `targetRevision`");
    expect(prBody).not.toContain("[!WARNING]");
  });
});
