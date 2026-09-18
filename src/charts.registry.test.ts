import { describe, expect, test } from "bun:test";
import { checkSource, fetchChart, nextLink, normalizeRepo, ociRepoParts, parseBearerChallenge, type ChartSource } from "./charts";

describe("OCI helpers", () => {
  test("normalizeRepo and ociRepoParts", () => {
    expect(normalizeRepo("oci://ghcr.io/org/charts/")).toBe("ghcr.io/org/charts");
    expect(ociRepoParts("docker.io/bitnamicharts", "redis")).toEqual({
      host: "registry-1.docker.io",
      path: "bitnamicharts",
      name: "bitnamicharts/redis",
    });
  });

  test("parseBearerChallenge reads realm, service, scope", () => {
    expect(
      parseBearerChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:bitnamicharts/redis:pull"'),
    ).toEqual({ realm: "https://auth.docker.io/token", service: "registry.docker.io", scope: "repository:bitnamicharts/redis:pull" });
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseBearerChallenge(null)).toBeNull();
  });

  test("nextLink extracts the next page", () => {
    expect(nextLink('</v2/a/b/tags/list?last=9&n=1000>; rel="next"')).toBe("/v2/a/b/tags/list?last=9&n=1000");
    expect(nextLink(null)).toBeNull();
  });
});

// A fake registry: 401 challenge, token endpoint, two pages of tags.
function fakeOci() {
  const calls: string[] = [];
  const f = async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.startsWith("https://auth.example/token")) return Response.json({ token: "t0k" });
    if (!auth) {
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.example/token",service="reg",scope="repository:org/app:pull"' },
      });
    }
    if (url.includes("last=")) return Response.json({ tags: ["1.3.0", "1.3.1_build.1"] });
    return Response.json({ tags: ["1.0.0", "1.2.0"] }, { headers: { link: '</v2/org/app/tags/list?last=1.2.0&n=1000>; rel="next"' } });
  };
  return { f, calls };
}

describe("fetchChart", () => {
  test("OCI: token flow, pagination, underscore conversion", async () => {
    const { f, calls } = fakeOci();
    const idx = await fetchChart("oci://reg.example/org", "app", f);
    expect(idx.versions).toEqual(["1.0.0", "1.2.0", "1.3.0", "1.3.1+build.1"]);
    expect(calls[1]).toBe("https://auth.example/token?service=reg&scope=repository%3Aorg%2Fapp%3Apull");
    expect(calls).toHaveLength(4);
  });

  test("HTTP: versions, deprecated flag and sources", async () => {
    const index = [
      "apiVersion: v1",
      "entries:",
      "  old-chart:",
      "    - version: 2.0.0",
      "      deprecated: true",
      "      home: https://example.org",
      "      sources: [https://github.com/acme/old-chart]",
      "    - version: 1.9.0",
    ].join("\n");
    const f = async () => new Response(index);
    const idx = await fetchChart("https://charts.example/deprecated-test", "old-chart", f);
    expect(idx.versions).toEqual(["2.0.0", "1.9.0"]);
    expect([...idx.deprecated]).toEqual(["2.0.0"]);
    expect(idx.sources).toEqual(["https://github.com/acme/old-chart", "https://example.org", "https://charts.example/deprecated-test"]);
  });

  test("HTTP 404 is reported as unreachable", async () => {
    const f = async () => new Response("", { status: 404 });
    await expect(fetchChart("https://gone.example/charts", "x", f)).rejects.toThrow(/^unreachable: HTTP 404/);
  });

  test("HTTP: a failed index fetch is retried, a successful one is cached", async () => {
    let calls = 0;
    const f = async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response("entries:\n  c:\n    - version: 1.0.0\n"));
    await expect(fetchChart("https://flaky.example/charts", "c", f)).rejects.toThrow("HTTP 503");
    expect((await fetchChart("https://flaky.example/charts", "c", f)).versions).toEqual(["1.0.0"]);
    expect((await fetchChart("https://flaky.example/charts", "c", f)).versions).toEqual(["1.0.0"]);
    expect(calls).toBe(2);
  });
});

describe("checkSource", () => {
  const src: ChartSource = { key: "a#b/c", file: "a", app: "b", chart: "c", repoURL: "https://c.example/1", current: "1.0.0" };

  test("marks deprecated when the latest version is deprecated", async () => {
    const f = async () => new Response("entries:\n  c:\n    - version: 1.1.0\n      deprecated: true\n    - version: 1.0.0\n");
    const r = await checkSource(src, f);
    expect(r).toMatchObject({ latest: "1.1.0", type: "minor", deprecated: true });
  });

  test("non-semver current skips the network", async () => {
    const r = await checkSource({ ...src, current: "1.14.*" }, async () => {
      throw new Error("must not fetch");
    });
    expect(r).toMatchObject({ type: "unknown", error: "non-semver targetRevision" });
  });

  test("registry errors become result errors", async () => {
    const r = await checkSource({ ...src, repoURL: "https://c.example/2" }, async () => new Response("", { status: 500 }));
    expect(r).toMatchObject({ type: "unknown", error: "HTTP 500 from https://c.example/2/index.yaml" });
  });
});
