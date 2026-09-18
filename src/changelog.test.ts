import { describe, expect, test } from "bun:test";
import { diffState, HEADER, readState, renderChange, stateLine, updateChangelog } from "./changelog";

const K = (file: string, chart: string) => `${file}#${chart}/${chart}`;
const RELOADER = K("tools/reloader/helm.yml", "reloader");
const DNS = K("tools/external-dns/helm.yml", "external-dns");
const REDIS = K("tools-preview/redis/helm.yaml", "redis");

describe("state", () => {
  test("stateLine sorts keys and readState round-trips", () => {
    const line = stateLine({ b: "2", a: "1" });
    expect(line).toBe('<!-- helm-scanner-state: {"a":"1","b":"2"} -->');
    expect(readState(`# x\n\n${line}\n`)).toEqual({ a: "1", b: "2" });
    expect(readState("# no state")).toBeNull();
    expect(readState("<!-- helm-scanner-state: {broken -->")).toBeNull();
  });
});

describe("diffState", () => {
  test("classifies every kind of change", () => {
    const changes = diffState(
      { [RELOADER]: "2.2.5", [DNS]: "1.22.0", [REDIS]: "22.0.7", gone: "1.0.0", git: "main" },
      { [RELOADER]: "2.2.17", [DNS]: "1.20.0", [REDIS]: "28.0.0", fresh: "0.1.0", git: "HEAD" },
    );
    expect(changes).toEqual([
      { key: "fresh", kind: "added", to: "0.1.0" },
      { key: "git", kind: "changed", from: "main", to: "HEAD" },
      { key: "gone", kind: "removed", from: "1.0.0" },
      { key: REDIS, kind: "upgraded", from: "22.0.7", to: "28.0.0", type: "MAJOR" }, // "tools-" sorts before "tools/"
      { key: DNS, kind: "downgraded", from: "1.22.0", to: "1.20.0" },
      { key: RELOADER, kind: "upgraded", from: "2.2.5", to: "2.2.17", type: "PATCH" },
    ]);
  });

  test("prefix-only change is 'changed', not an upgrade", () => {
    expect(diffState({ a: "1.0.0" }, { a: "v1.0.0" })).toEqual([{ key: "a", kind: "changed", from: "1.0.0", to: "v1.0.0" }]);
  });
});

describe("renderChange", () => {
  test("upgrade with release notes and closes", () => {
    expect(
      renderChange({ key: RELOADER, kind: "upgraded", from: "2.2.5", to: "2.2.17", type: "PATCH" }, { notesUrl: "https://rel", closes: 42 }),
    ).toBe("- **reloader** `2.2.5` → `2.2.17` (PATCH) · `tools/reloader/helm.yml` · [release notes](https://rel) · closes #42");
  });
  test("other kinds", () => {
    expect(renderChange({ key: REDIS, kind: "added", to: "1.0.0" })).toBe("- **redis** added at `1.0.0` · `tools-preview/redis/helm.yaml`");
    expect(renderChange({ key: REDIS, kind: "removed", from: "1.0.0" })).toBe("- **redis** removed (was `1.0.0`) · `tools-preview/redis/helm.yaml`");
    expect(renderChange({ key: REDIS, kind: "downgraded", from: "2.0.0", to: "1.0.0" })).toContain("(DOWNGRADE)");
    expect(renderChange({ key: REDIS, kind: "changed", from: "main", to: "HEAD" })).toContain("(CHANGED)");
  });
});

describe("updateChangelog", () => {
  const s1 = { [RELOADER]: "2.2.5", [DNS]: "1.20.0" };

  test("first run without a file writes the header and a baseline, no entries", () => {
    const out = updateChangelog(null, s1, "2026-09-19");
    expect(out.changed).toBe(true);
    expect(out.text).toBe(`${HEADER}\n\n${stateLine(s1)}\n`);
  });

  test("first run keeps existing user content", () => {
    const out = updateChangelog("# My own title\n\nNotes.\n", s1, "2026-09-19");
    expect(out.text).toBe(`# My own title\n\nNotes.\n\n${stateLine(s1)}\n`);
  });

  test("no change returns the file untouched", () => {
    const text = `${HEADER}\n\n${stateLine(s1)}\n`;
    expect(updateChangelog(text, { ...s1 }, "2026-09-19")).toEqual({ text, changed: false, changes: [] });
  });

  test("new day section goes on top, newest first", () => {
    const day1 = `${HEADER}\n\n## 2026-09-12\n\n- **old** entry\n\n${stateLine(s1)}\n`;
    const out = updateChangelog(day1, { ...s1, [RELOADER]: "2.2.17" }, "2026-09-19", new Map([[RELOADER, { closes: 7 }]]));
    expect(out.text).toBe(
      `${HEADER}\n\n## 2026-09-19\n\n- **reloader** \`2.2.5\` → \`2.2.17\` (PATCH) · \`tools/reloader/helm.yml\` · closes #7\n\n## 2026-09-12\n\n- **old** entry\n\n${stateLine({ ...s1, [RELOADER]: "2.2.17" })}\n`,
    );
  });

  test("same-day entries append to today's section", () => {
    const s2 = { ...s1, [RELOADER]: "2.2.17" };
    const first = updateChangelog(`${HEADER}\n\n${stateLine(s1)}\n`, s2, "2026-09-19").text;
    const second = updateChangelog(first, { ...s2, [DNS]: "1.22.0" }, "2026-09-19").text;
    expect(second).toBe(
      `${HEADER}\n\n## 2026-09-19\n\n- **reloader** \`2.2.5\` → \`2.2.17\` (PATCH) · \`tools/reloader/helm.yml\`\n- **external-dns** \`1.20.0\` → \`1.22.0\` (MINOR) · \`tools/external-dns/helm.yml\`\n\n${stateLine({ ...s2, [DNS]: "1.22.0" })}\n`,
    );
  });

  test("corrupted state is rebuilt as a baseline without duplicate state lines", () => {
    const out = updateChangelog(`${HEADER}\n\n<!-- helm-scanner-state: {oops -->\n`, s1, "2026-09-19");
    expect(out.text).toBe(`${HEADER}\n\n${stateLine(s1)}\n`);
  });
});
