export type UpdateType = "major" | "minor" | "patch" | "none" | "unknown";

export interface ChartSource {
  key: string; // `${file}#${app}/${chart}`
  file: string;
  app: string;
  chart: string;
  repoURL: string;
  current: string;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/i;

export const makeKey = (file: string, app: string, chart: string) => `${file}#${app}/${chart}`;

export function parseKey(key: string) {
  const i = key.lastIndexOf("#");
  const rest = key.slice(i + 1);
  const j = rest.indexOf("/");
  return { file: key.slice(0, i), app: rest.slice(0, j), chart: rest.slice(j + 1) };
}

export function parseSemver(v: string): { major: number; minor: number; patch: number; pre?: string } | null {
  const m = String(v).trim().match(SEMVER);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] };
}

// ponytail: Bun.semver.order rejects "V1.2.0" and non-semver, so callers must pass parseSemver-valid input.
export const compareVersions = (a: string, b: string) =>
  Bun.semver.order(a.trim().replace(/^v/i, ""), b.trim().replace(/^v/i, ""));

export function pickLatest(versions: string[], allowPrerelease: boolean): string | null {
  const ok = versions.filter((v) => {
    const s = parseSemver(v);
    return s && (allowPrerelease || !s.pre);
  });
  if (ok.length === 0) return null;
  return ok.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}

export function classify(current: string, latest: string): UpdateType {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return "unknown";
  if (compareVersions(latest, current) <= 0) return "none";
  if (l.major !== c.major) return "major";
  if (l.minor !== c.minor) return "minor";
  return "patch"; // patch differs, or same M.m.p with a newer prerelease/release
}
