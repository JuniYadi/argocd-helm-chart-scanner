import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDrift, makeKey, scanManifests, type ChartSource } from "./charts";

describe("scanManifests", () => {
  test("finds Helm sources in single, multi-source and multi-doc files", async () => {
    const { sources, warnings } = await scanManifests("fixtures");
    expect(warnings).toEqual([]);
    expect(sources.map((s) => s.key)).toEqual([
      "fixtures/http-single.yaml#reloader/reloader",
      "fixtures/multi-doc-dockerhub.yaml#redis-cache/redis",
      "fixtures/multi-doc-dockerhub.yaml#redis-queue/redis",
      "fixtures/multi-source.yaml#external-dns/external-dns",
      "fixtures/non-semver.yaml#cert-manager/cert-manager",
      "fixtures/oci-ecr-public.yaml#aws-node-termination-handler/aws-node-termination-handler",
      "fixtures/oci-ghcr.yaml#podinfo/podinfo",
    ]);
    expect(sources[0]).toMatchObject({ current: "1.0.5", repoURL: "https://stakater.github.io/stakater-charts" });
    expect(sources[3]).toMatchObject({ current: "1.14.0" });
  });

  test("warns and skips unparseable Application files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    await Bun.write(`${dir}/broken.yaml`, "kind: Application\nspec: [unclosed\n");
    const { sources, warnings } = await scanManifests(dir);
    expect(sources).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].file).toBe(`${dir}/broken.yaml`);
    expect(warnings[0].message.length).toBeGreaterThan(0);
  });

  test("prefilter tolerates a trailing comment on the kind line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-"));
    await Bun.write(
      `${dir}/app.yaml`,
      [
        "apiVersion: argoproj.io/v1alpha1",
        "kind: Application # argo",
        "metadata:",
        "  name: reloader",
        "spec:",
        "  source:",
        "    chart: reloader",
        "    repoURL: https://stakater.github.io/stakater-charts",
        "    targetRevision: 1.0.5",
        "",
      ].join("\n"),
    );
    const { sources, warnings } = await scanManifests(dir);
    expect(warnings).toEqual([]);
    expect(sources).toHaveLength(1);
  });
});

describe("findDrift", () => {
  test("groups by normalised repo + chart and keeps only differing versions", () => {
    const s = (file: string, repoURL: string, current: string, chart = "redis"): ChartSource => ({
      key: makeKey(file, chart, chart), file, app: chart, chart, repoURL, current,
    });
    const drift = findDrift([
      s("dev/a.yaml", "registry-1.docker.io/bitnamicharts", "18.0.0"),
      s("prod/a.yaml", "oci://registry-1.docker.io/bitnamicharts/", "19.0.0"),
      s("dev/b.yaml", "https://x.example", "1.0.0", "same"),
      s("prod/b.yaml", "https://x.example", "1.0.0", "same"),
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0].members.map((m) => m.current)).toEqual(["18.0.0", "19.0.0"]);
  });
});
