import { describe, expect, test } from "bun:test";
import { classify, makeKey, parseKey, parseSemver, pickLatest } from "./charts";

describe("semver", () => {
  test("parseSemver accepts v/V prefix, prerelease and build", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: undefined });
    expect(parseSemver("V1.2.3-rc.1+build.5")).toEqual({ major: 1, minor: 2, patch: 3, pre: "rc.1" });
    expect(parseSemver("1.14.*")).toBeNull();
    expect(parseSemver("HEAD")).toBeNull();
  });

  test("pickLatest orders numerically and skips prereleases unless allowed", () => {
    const versions = ["1.0.0-rc.9", "1.0.0-rc.10", "0.9.1", "V0.9.5", "latest", "sha256-abc.sig"];
    expect(pickLatest(versions, false)).toBe("V0.9.5");
    expect(pickLatest(versions, true)).toBe("1.0.0-rc.10");
    expect(pickLatest(["latest"], false)).toBeNull();
  });

  test("classify covers every branch", () => {
    expect(classify("1.2.3", "2.0.0")).toBe("major");
    expect(classify("1.2.3", "1.3.0")).toBe("minor");
    expect(classify("1.2.3", "1.2.4")).toBe("patch");
    expect(classify("0.3.0-dev", "0.3.0")).toBe("patch"); // original script returned "none"
    expect(classify("0.3.0-dev", "0.3.1-dev")).toBe("patch");
    expect(classify("1.2.3", "1.2.3")).toBe("none");
    expect(classify("2.0.0", "1.9.0")).toBe("none"); // current ahead of a pruned index
    expect(classify("1.2.3+a", "1.2.3+b")).toBe("none");
    expect(classify("1.14.*", "1.15.0")).toBe("unknown");
  });
});

describe("keys", () => {
  test("makeKey and parseKey round-trip", () => {
    const key = makeKey("tools/redis/helm.yaml", "redis-cache", "redis");
    expect(key).toBe("tools/redis/helm.yaml#redis-cache/redis");
    expect(parseKey(key)).toEqual({ file: "tools/redis/helm.yaml", app: "redis-cache", chart: "redis" });
  });
});
