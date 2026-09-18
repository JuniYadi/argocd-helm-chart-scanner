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

export interface ChartIndex {
  versions: string[];
  deprecated: Set<string>;
  sources: string[]; // upstream URLs, used to find GitHub releases
}

export interface ChartResult extends ChartSource {
  latest?: string;
  type: UpdateType;
  deprecated: boolean;
  sources: string[];
  error?: string;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const HEADERS = { "User-Agent": "argocd-helm-chart-scanner" };

const indexCache = new Map<string, Promise<any>>();

async function fetchHttpIndex(repoURL: string, chart: string, f: Fetch): Promise<ChartIndex> {
  const url = repoURL.replace(/\/+$/, "") + "/index.yaml";
  if (!indexCache.has(url)) {
    indexCache.set(
      url,
      (async () => {
        let res: Response;
        try {
          res = await f(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (err) {
          throw new Error(`unreachable: ${url} (${(err as Error).message}); repository moved or removed?`);
        }
        if (res.status === 404 || res.status === 410) {
          throw new Error(`unreachable: HTTP ${res.status} from ${url}; repository moved or removed?`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
        return Bun.YAML.parse(await res.text());
      })().catch((err) => {
        indexCache.delete(url); // a failed fetch must not poison later charts on the same repo
        throw err;
      }),
    );
  }
  const index = await indexCache.get(url)!;
  const entries: any[] = index?.entries?.[chart] ?? [];
  if (entries.length === 0) throw new Error(`chart "${chart}" not found in ${url}`);

  const sources = new Set<string>();
  for (const e of entries) for (const s of e.sources ?? []) sources.add(s);
  const home = entries.find((e) => e.home)?.home;
  if (home) sources.add(home);
  sources.add(repoURL);

  return {
    versions: entries.map((e) => String(e.version)),
    deprecated: new Set(entries.filter((e) => e.deprecated === true).map((e) => String(e.version))),
    sources: [...sources],
  };
}

export function parseBearerChallenge(header: string | null) {
  if (!header || !/^Bearer\s/i.test(header)) return null;
  const params: Record<string, string> = {};
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) params[m[1].toLowerCase()] = m[2];
  return params.realm ? { realm: params.realm, service: params.service, scope: params.scope } : null;
}

export function nextLink(header: string | null): string | null {
  return header?.match(/<([^>]+)>\s*;\s*rel="?next"?/)?.[1] ?? null;
}

export function ociRepoParts(repoURL: string, chart: string) {
  const repo = normalizeRepo(repoURL);
  const slash = repo.indexOf("/");
  let host = slash === -1 ? repo : repo.slice(0, slash);
  const path = slash === -1 ? "" : repo.slice(slash + 1);
  if (host === "docker.io") host = "registry-1.docker.io";
  return { host, path, name: path ? `${path}/${chart}` : chart };
}

async function fetchOciTags(repoURL: string, chart: string, f: Fetch): Promise<ChartIndex> {
  const { host, path, name } = ociRepoParts(repoURL, chart);
  let url: string | null = `https://${host}/v2/${name}/tags/list?n=1000`;
  let token: string | undefined;
  const tags: string[] = [];

  const get = (u: string) =>
    f(u, {
      headers: token ? { ...HEADERS, Authorization: `Bearer ${token}` } : HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  for (let page = 0; url && page < 20; page++) {
    let res: Response;
    try {
      res = await get(url);
      if (res.status === 401 && !token) {
        const challenge = parseBearerChallenge(res.headers.get("www-authenticate"));
        if (!challenge) throw new Error(`HTTP 401 from ${url} without a Bearer challenge`);
        const tokenURL = new URL(challenge.realm);
        if (challenge.service) tokenURL.searchParams.set("service", challenge.service);
        tokenURL.searchParams.set("scope", challenge.scope ?? `repository:${name}:pull`);
        const tr = await f(tokenURL.toString(), { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!tr.ok) throw new Error(`OCI token request failed: HTTP ${tr.status} from ${tokenURL.origin}`);
        const tj = (await tr.json()) as { token?: string; access_token?: string };
        token = tj.token ?? tj.access_token;
        res = await get(url);
      }
    } catch (err) {
      const msg = (err as Error).message;
      throw new Error(msg.startsWith("OCI token") || msg.startsWith("HTTP 401") ? msg : `unreachable: ${host} (${msg})`);
    }
    if (res.status === 404) throw new Error(`unreachable: HTTP 404 from ${url}; chart moved or removed?`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const body = (await res.json()) as { tags?: string[] | null };
    tags.push(...(body.tags ?? []));
    const next = nextLink(res.headers.get("link"));
    url = next ? new URL(next, url).toString() : null;
  }

  if (tags.length === 0) throw new Error(`no tags found for ${host}/${name}`);
  const sources = host === "ghcr.io" && path ? [`https://github.com/${path.split("/").slice(0, 2).join("/")}`] : [];
  return {
    versions: tags.map((t) => t.replace(/_/g, "+")), // Helm stores "+" as "_" in OCI tags
    deprecated: new Set(),
    sources,
  };
}

export function fetchChart(repoURL: string, chart: string, f: Fetch = fetch): Promise<ChartIndex> {
  return /^https?:\/\//.test(repoURL) ? fetchHttpIndex(repoURL, chart, f) : fetchOciTags(repoURL, chart, f);
}

export async function checkSource(s: ChartSource, f: Fetch = fetch): Promise<ChartResult> {
  const cur = parseSemver(s.current);
  if (!cur) return { ...s, type: "unknown", deprecated: false, sources: [], error: "non-semver targetRevision" };
  try {
    const index = await fetchChart(s.repoURL, s.chart, f);
    const latest = pickLatest(index.versions, Boolean(cur.pre));
    if (!latest) return { ...s, type: "unknown", deprecated: false, sources: index.sources, error: "no compatible versions found" };
    return {
      ...s,
      latest,
      type: classify(s.current, latest),
      deprecated: index.deprecated.has(latest),
      sources: index.sources,
    };
  } catch (err) {
    return { ...s, type: "unknown", deprecated: false, sources: [], error: (err as Error).message };
  }
}
