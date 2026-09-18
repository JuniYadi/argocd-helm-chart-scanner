import { join } from "node:path";

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

export interface DriftGroup {
  chart: string;
  repoURL: string;
  members: { key: string; file: string; app: string; current: string }[];
}

export const normalizeRepo = (repoURL: string) =>
  repoURL.trim().replace(/^oci:\/\//, "").replace(/\/+$/, "");

export async function scanManifests(dir: string): Promise<{ sources: ChartSource[]; warnings: string[] }> {
  const sources: ChartSource[] = [];
  const warnings: string[] = [];
  const glob = new Bun.Glob("**/*.{yml,yaml}");
  const files = Array.from(glob.scanSync({ cwd: dir, onlyFiles: true })).sort();

  for (const rel of files) {
    const file = join(dir, rel);
    const text = await Bun.file(file).text();
    if (!/kind:\s*["']?Application["']?\s*$/m.test(text)) continue;

    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(text);
    } catch (err) {
      warnings.push(`${file}: ${(err as Error).message}`);
      continue;
    }

    for (const doc of Array.isArray(parsed) ? parsed : [parsed]) {
      if (doc?.kind !== "Application" || !String(doc.apiVersion ?? "").startsWith("argoproj.io/") || !doc.spec) continue;
      const candidates = [doc.spec.source, ...(Array.isArray(doc.spec.sources) ? doc.spec.sources : [])];
      for (const s of candidates) {
        if (!s?.chart || !s.repoURL || s.targetRevision === undefined) continue;
        const app = String(doc.metadata?.name ?? s.chart);
        sources.push({
          key: makeKey(file, app, s.chart),
          file,
          app,
          chart: String(s.chart),
          repoURL: String(s.repoURL),
          current: String(s.targetRevision),
        });
      }
    }
  }
  return { sources, warnings };
}

export function findDrift(sources: ChartSource[]): DriftGroup[] {
  const groups = new Map<string, DriftGroup>();
  for (const s of sources) {
    const id = `${normalizeRepo(s.repoURL)}|${s.chart}`;
    if (!groups.has(id)) groups.set(id, { chart: s.chart, repoURL: normalizeRepo(s.repoURL), members: [] });
    groups.get(id)!.members.push({ key: s.key, file: s.file, app: s.app, current: s.current });
  }
  return [...groups.values()].filter((g) => new Set(g.members.map((m) => m.current)).size > 1);
}
