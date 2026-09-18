import { describe, expect, test } from "bun:test";
import type { ChartResult } from "./charts";
import {
  branchName,
  candidateTags,
  editTargetRevision,
  githubRepos,
  marker,
  readMarker,
  renderBody,
  renderTitle,
  resolveReleaseInfo,
  route,
  run,
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

  test("candidateTags appends chart-v and chart- prefixed tags after the existing candidates", () => {
    const tags = candidateTags("reloader", "v2.2.17");
    expect(tags[0]).toBe("v2.2.17");
    expect(tags.slice(-2)).toEqual(["chart-v2.2.17", "chart-2.2.17"]);
  });

  test("resolveReleaseInfo finds the target tag and a compare link with one call", () => {
    const releases = [
      { tag_name: "v2.2.17", html_url: "https://github.com/stakater/Reloader/releases/tag/v2.2.17", body: "x".repeat(4100) },
      { tag_name: "v2.2.5", html_url: "https://github.com/stakater/Reloader/releases/tag/v2.2.5" },
    ];
    const { exec, calls } = fakeExec([[/^api repos\/stakater\/Reloader\/releases/, JSON.stringify(releases)]]);
    const info = resolveReleaseInfo(exec, "reloader", "2.2.5", "2.2.17", ["https://github.com/stakater/Reloader"]);
    expect(info.tag).toBe("v2.2.17");
    expect(info.url).toBe("https://github.com/stakater/Reloader/releases/tag/v2.2.17");
    expect(info.compareUrl).toBe("https://github.com/stakater/Reloader/compare/v2.2.5...v2.2.17");
    expect(info.notes).toEndWith("*(Truncated. See the full notes via the release link.)*");
    expect(info.artifactHubUrl).toBe("https://artifacthub.io/packages/search?ts_query_web=reloader");
    expect(calls).toHaveLength(1);
  });

  test("resolveReleaseInfo derives the current tag from the matched naming scheme", () => {
    const releases = [
      { tag_name: "reloader-2.2.17", html_url: "https://rel" },
      { tag_name: "reloader-2.2.5", html_url: "https://rel-old" },
    ];
    const { exec, calls } = fakeExec([[/^api repos\/stakater\/Reloader\/releases/, JSON.stringify(releases)]]);
    const info = resolveReleaseInfo(exec, "reloader", "2.2.5", "2.2.17", ["https://github.com/stakater/Reloader"]);
    expect(info.tag).toBe("reloader-2.2.17");
    expect(info.compareUrl).toBe("https://github.com/stakater/Reloader/compare/reloader-2.2.5...reloader-2.2.17");
    expect(calls).toHaveLength(1); // both tags already known from the one releases call
  });

  test("resolveReleaseInfo matches a chart-v prefixed release tag with one call", () => {
    const releases = [
      { tag_name: "v1.4.22", html_url: "https://github.com/stakater/Reloader/releases/tag/v1.4.22" },
      {
        tag_name: "chart-v2.2.17",
        html_url: "https://github.com/stakater/Reloader/releases/tag/chart-v2.2.17",
        body: "Chart release notes",
      },
      { tag_name: "chart-v2.2.5", html_url: "https://github.com/stakater/Reloader/releases/tag/chart-v2.2.5" },
    ];
    const { exec, calls } = fakeExec([[/^api repos\/stakater\/Reloader\/releases/, JSON.stringify(releases)]]);
    const info = resolveReleaseInfo(exec, "reloader", "2.2.5", "2.2.17", ["https://github.com/stakater/Reloader"]);
    expect(info.tag).toBe("chart-v2.2.17");
    expect(info.url).toBe("https://github.com/stakater/Reloader/releases/tag/chart-v2.2.17");
    expect(info.compareUrl).toBe("https://github.com/stakater/Reloader/compare/chart-v2.2.5...chart-v2.2.17");
    expect(calls).toHaveLength(1);
  });

  test("resolveReleaseInfo falls back to the releases page when nothing matches", () => {
    const { exec } = fakeExec([[/^api repos\/a\/b\/releases/, JSON.stringify([{ tag_name: "unrelated", html_url: "https://x" }])]]);
    expect(resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", ["https://github.com/a/b"]).url).toBe("https://github.com/a/b/releases");
    expect(resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", []).url).toBeUndefined();
  });

  test("resolveReleaseInfo survives unparseable gh output", () => {
    const { exec } = fakeExec([[/^api repos\/a\/b\/releases/, "not json"]]);
    expect(resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", ["https://github.com/a/b"]).url).toBe("https://github.com/a/b/releases");
  });

  test("resolveReleaseInfo caches the release list per repo per gh instance", () => {
    const releases = [
      { tag_name: "v1.1.0", html_url: "https://rel" },
      { tag_name: "v1.0.0", html_url: "https://rel-old" },
    ];
    const { exec, calls } = fakeExec([[/^api repos\/a\/b\/releases/, JSON.stringify(releases)]]);
    resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", ["https://github.com/a/b"]);
    resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", ["https://github.com/a/b"]);
    expect(calls.filter((c) => c.args[0] === "api")).toHaveLength(1);
  });

  test("resolveReleaseInfo makes one extra call when the derived current tag is not in the list", () => {
    const { exec, calls } = fakeExec([
      [/^api repos\/a\/b\/releases/, JSON.stringify([{ tag_name: "v1.1.0", html_url: "https://rel" }])],
      [/^release view v1\.0\.0 /, JSON.stringify({ tagName: "v1.0.0" })],
    ]);
    const info = resolveReleaseInfo(exec, "c", "1.0.0", "1.1.0", ["https://github.com/a/b"]);
    expect(info.compareUrl).toBe("https://github.com/a/b/compare/v1.0.0...v1.1.0");
    expect(calls).toHaveLength(2);
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

  test("readMarker ignores marker look-alikes injected by upstream release notes", () => {
    const body = renderBody(result(), { info: { artifactHubUrl: "https://ah", notes: `evil ${marker("spoofed#a/b")}` }, drift: [], manual: false, pr: false });
    expect(readMarker(body)).toBe(result().key);
  });

  test("release notes are rendered as an inert tilde-fenced code block", () => {
    const notes = "@octocat fixed #45 ~~~~ </details> <!-- x";
    const body = renderBody(result(), { info: { artifactHubUrl: "https://ah", notes }, drift: [], manual: false, pr: false });
    const lines = body.split("\n");
    const openIdx = lines.indexOf("~~~~~text");
    const closeIdx = lines.indexOf("~~~~~");
    expect(openIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(openIdx);
    expect(lines.slice(openIdx + 1, closeIdx).join("\n")).toContain(notes);
    expect(readMarker(body)).toBe(result().key);
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

describe("run", () => {
  test("kills a hung process and reports the timeout", () => {
    const r = run("sleep", undefined, 100)(["5"]);
    expect(r.ok).toBe(false);
    expect(r.err).toBe("sleep timed out after 100 ms");
  });

  test("a missing binary fails instead of throwing", () => {
    const r = run("definitely-not-a-binary-xyz")([]);
    expect(r.ok).toBe(false);
    expect(r.err).toContain("definitely-not-a-binary-xyz");
  });
});
