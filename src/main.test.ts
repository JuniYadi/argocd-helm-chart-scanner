import { describe, expect, test } from "bun:test";
import type { ChartResult, ChartSource } from "./charts";
import { readState, updateChangelog, type State } from "./changelog";
import { cmdEscape, cmdProp, nextState, readInputs, renderSummary, scopeOf } from "./main";

describe("readInputs", () => {
  test("defaults to report-only", () => {
    expect(readInputs({})).toEqual({
      path: ".",
      issueTypes: new Set(),
      prTypes: new Set(),
      labels: ["helm-update"],
      changelogFile: "",
      token: "",
    });
  });

  test("parses lists, trims and lowercases", () => {
    const i = readInputs({
      INPUT_PATH: "fixtures",
      INPUT_ISSUE_TYPES: " Major, minor ",
      INPUT_PR_TYPES: "patch",
      INPUT_LABELS: "helm-update, dependencies",
      INPUT_CHANGELOG_FILE: "HELM_CHANGELOG.md",
      GH_TOKEN: "t",
    });
    expect([...i.issueTypes]).toEqual(["major", "minor"]);
    expect([...i.prTypes]).toEqual(["patch"]);
    expect(i.labels).toEqual(["helm-update", "dependencies"]);
    expect(i.changelogFile).toBe("HELM_CHANGELOG.md");
  });

  test("rejects unknown types, missing path and missing token", () => {
    expect(() => readInputs({ INPUT_ISSUE_TYPES: "major,huge" })).toThrow('issue-types: unknown update type "huge"');
    expect(() => readInputs({ INPUT_PATH: "does-not-exist" })).toThrow('path: "does-not-exist" does not exist.');
    expect(() => readInputs({ INPUT_PR_TYPES: "patch" })).toThrow("token: required");
  });
});

describe("renderSummary", () => {
  const r = (over: Partial<ChartResult>): ChartResult => ({
    key: "k", file: "f.yaml", app: "a", chart: "c", repoURL: "u", current: "1.0.0", latest: "1.1.0",
    type: "minor", deprecated: false, sources: [], ...over,
  });

  test("renders every section when there is something to show", () => {
    const md = renderSummary(
      [
        r({ key: "a", chart: "alpha", deprecated: true }),
        r({ key: "b", chart: "beta", type: "none", latest: "1.0.0" }),
        r({ key: "c", chart: "gamma", type: "unknown", latest: undefined, error: "HTTP 500 | bad" }),
      ],
      [{ chart: "alpha", repoURL: "u", members: [{ key: "a", file: "dev.yaml", app: "alpha", current: "1.0.0" }, { key: "x", file: "prod.yaml", app: "alpha", current: "0.9.0" }] }],
      new Map([["a", "issue"]]),
      new Map([["a", "https://github.com/o/r/issues/5"]]),
    );
    expect(md).toContain("**Scanned:** 3 · **Outdated:** 1 · **Tracked:** 1 · **Errors:** 1");
    expect(md).toContain("| ⚠️ alpha | `f.yaml` | 1.0.0 | 1.1.0 | MINOR | issue | [#5](https://github.com/o/r/issues/5) |");
    expect(md).toContain("### ⚠️ Deprecated");
    expect(md).toContain("- **alpha** (`u`): `dev.yaml` (alpha) → 1.0.0, `prod.yaml` (alpha) → 0.9.0");
    expect(md).toContain("| gamma | `f.yaml` | HTTP 500 \\| bad |");
  });

  test("all up to date", () => {
    const md = renderSummary([r({ type: "none" })], [], new Map(), new Map());
    expect(md).toContain("All Helm charts are up to date.");
    expect(md).not.toContain("### Updates");
    expect(md).not.toContain("Errors and skipped");
  });
});

describe("scopeOf", () => {
  test('"." accepts anything', () => {
    const inScope = scopeOf(".");
    expect(inScope("tools/a.yaml#x/y")).toBe(true);
    expect(inScope("anything#a/b")).toBe(true);
  });

  test("a path accepts its own keys and rejects look-alike siblings", () => {
    const inScope = scopeOf("tools");
    expect(inScope("tools/a.yaml#x/y")).toBe(true);
    expect(inScope("tools-preview/a.yaml#x/y")).toBe(false);
  });
});

describe("nextState", () => {
  const src = (key: string, current: string): ChartSource => {
    const [file, rest] = key.split("#");
    const [app, chart] = rest.split("/");
    return { key, file, app, chart, repoURL: "https://x.example", current };
  };

  test("keeps out-of-scope entries, drops vanished in-scope entries, adds/updates scanned ones", () => {
    const prev: State = {
      "other/a.yaml#a/a": "1.0.0",
      "tools/gone.yaml#g/g": "1.0.0",
      "tools/x.yaml#x/x": "1.0.0",
    };
    const sources = [src("tools/x.yaml#x/x", "2.0.0"), src("tools/y.yaml#y/y", "1.0.0")];
    expect(nextState(prev, sources, scopeOf("tools"))).toEqual({
      "other/a.yaml#a/a": "1.0.0",
      "tools/x.yaml#x/x": "2.0.0",
      "tools/y.yaml#y/y": "1.0.0",
    });
  });

  test("a null prev starts from an empty state", () => {
    const sources = [src("tools/x.yaml#x/x", "1.0.0")];
    expect(nextState(null, sources, scopeOf("tools"))).toEqual({ "tools/x.yaml#x/x": "1.0.0" });
  });

  test("end-to-end: scanning a second path never removes the first path's keys", () => {
    const first = updateChangelog(null, nextState(null, [src("clusters/dev/a.yaml#a/a", "1.0.0")], scopeOf("clusters/dev")), "2026-09-19");
    const state1 = readState(first.text)!;
    const second = updateChangelog(
      first.text,
      nextState(state1, [src("clusters/prod/b.yaml#b/b", "1.0.0")], scopeOf("clusters/prod")),
      "2026-09-19",
    );
    expect(second.changes.some((c) => c.kind === "removed")).toBe(false);
  });
});

describe("cmdEscape / cmdProp", () => {
  test("cmdEscape escapes %, \\r and \\n", () => {
    expect(cmdEscape("50%\nnext")).toBe("50%25%0Anext");
  });

  test("cmdProp additionally escapes : and ,", () => {
    expect(cmdProp("a:b,c")).toBe("a%3Ab%2Cc");
  });
});
