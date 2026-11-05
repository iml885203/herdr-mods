import { baseName } from "./paths.js";

const LAYERS = ["db", "service", "sdk", "api", "ui", "tests", "other"];

const NOISE = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|bun\.lockb?|Cargo\.lock|poetry\.lock)$/,
  /\.Designer\.cs$/,
  /\.g\.(cs|ts)$/,
  /\.generated\./,
  /\.(snap|min\.js|min\.css|dacpac|map)$/,
];
const BUILD_DIRS = /(^|\/)(dist|bin|obj|__snapshots__)\//;
const SECRET = new RegExp(
  "(^|/)(" + [
    "\\.env(\\..*)?",
    ".*\\.(pem|key|p12|pfx|jks|tfvars|tfstate)",
    "id_(rsa|ed25519|ecdsa)",
    ".*secrets?\\.(json|ya?ml|txt)",
    "\\.npmrc", "\\.netrc", "\\.pgpass", "\\.git-credentials", "\\.htpasswd", "\\.dockercfg",
    "kubeconfig(\\..*)?",
    "credentials?(\\.(json|ya?ml|txt|ini|xml|csv))?",
    "appsettings(\\..+)?\\.json",
    "service-?account.*\\.json",
  ].join("|") + ")$",
  "i",
);
const TEST_PATH = /(^|\/)(e2e|tests?|__tests__|[^/]*Tests?)\/|\.(spec|test)\.[jt]sx?$|Feature\.cs$/;
const JIRA = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const IDENT = /[A-Za-z_@$][A-Za-z0-9_]*/g;
const IDENT_CAP = 2000;
const EDGE_LABEL_LIMIT = 4;
const STRONG_IDENT_LENGTH = 12;
const STRENGTH = { jira: 3, submodule: 2, ident: 1 };
const KIND_ORDER = { jira: 0, submodule: 1, ident: 2 };

const STOP = new Set([
  "cancellationtoken", "tostring", "firstordefault", "firstordefaultasync", "tolistasync", "configureawait", "iactionresult",
  "actionresult", "jsonpropertyname", "httpclient", "httpcontext", "getrequiredservice", "addscoped", "addsingleton",
  "tolist", "toarray", "isnullorempty", "isnullorwhitespace", "stringcomparison", "datetime", "datetimeoffset", "utcnow",
  "beforeeach", "aftereach", "toequal", "tobe", "tohavebeencalled", "tobedefined", "tocontain", "mockresolvedvalue",
  "nextpage", "setstate", "usestate", "useeffect", "computed", "onmounted", "definemodel", "defineprops", "defineemits",
  "nocount", "begintran", "committran", "rollbacktran", "trycatch", "getvalue", "setvalue", "keyvaluepair",
  "readonly", "innerhtml", "classname", "addeventlistener", "queryselector", "getelementbyid", "datatestid",
]);

export const isNoise = (path, { owned = false } = {}) => NOISE.some((re) => re.test(path)) || (!owned && BUILD_DIRS.test(path));
export const isSecret = (path) => SECRET.test(path);
const isTestPath = (path) => TEST_PATH.test(path);

function voteOf(path) {
  if (/\.(sql|sqlproj)$/i.test(path)) return "db";
  if (/\.proto$/.test(path) || /(^|\/|\.)(Sdk|Client)(\/|\.)/.test(path)) return "sdk";
  if (/(^|\/)(Controllers|EndPoints|Endpoints)\/|(^|\/|\.)Api(\/|\.)/.test(path)) return "api";
  if (/\.(vue|svelte|tsx|jsx|scss|css)$/.test(path)) return "ui";
  if (/\.cs$/.test(path)) return "service";
  if (/\.ts$/.test(path) && /(^|\/)src\/(components|pages|views|stores|composables)\//.test(path)) return "ui";
  return undefined;
}

function layerFromName(name) {
  if (/(^|[./_-])(sdk|client)([./_-]|$)/i.test(name)) return "sdk";
  if (/(^|[./_-])(api|gateway|server)([./_-]|$)/i.test(name)) return "api";
  if (/(^|[./_-])(web|ui|frontend|app)([./_-]|$)/i.test(name)) return "ui";
  return "other";
}

export function layerOf(name, paths) {
  if (/(^|[./_-])(e2e|tests?|loadtests?)([./_-]|$)/i.test(name)) return "tests";
  if (/(^|[./_-])(db|database|migrations?|schema)([./_-]|$)/i.test(name)) return "db";
  const tally = new Map();
  const meaningful = paths.filter((p) => !isNoise(p));
  for (const path of meaningful.filter((p) => !isTestPath(p))) {
    const layer = voteOf(path);
    if (layer) tally.set(layer, (tally.get(layer) ?? 0) + 1);
  }
  if (tally.size === 0 && meaningful.some(isTestPath)) return "tests";
  const best = [...tally].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : layerFromName(name);
}

export const layerRank = (layer) => LAYERS.indexOf(layer);

export const jiraKeys = (subjects) => [...new Set(subjects.flatMap((s) => s.match(JIRA) ?? []))].sort();

function isDistinctive(word) {
  const bare = word.replace(/^[@$_]+/, "");
  return bare.length >= 6 && (/[a-z][A-Z]/.test(bare) || /[a-zA-Z]_[a-zA-Z]/.test(bare));
}

export function addedIdentifiers(diff) {
  const found = new Set();
  let skip = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { skip = isNoise(line.slice(6)); continue; }
    if (skip || !line.startsWith("+")) continue;
    for (const word of line.slice(1).match(IDENT) ?? []) {
      if (!isDistinctive(word)) continue;
      const key = word.replace(/^[@$_]+/, "").toLowerCase();
      if (!STOP.has(key)) found.add(key);
      if (found.size >= IDENT_CAP) return [...found];
    }
  }
  return [...found];
}

export function relate(repos, layerOfRepo) {
  const rank = (name) => layerRank(layerOfRepo(name));
  const ordered = (a, b) => (rank(a) < rank(b) || (rank(a) === rank(b) && a < b) ? [a, b] : [b, a]);
  const edges = new Map();
  const add = (a, b, kind, labels) => {
    const [from, to] = ordered(a, b);
    const id = `${from}|${to}`;
    const existing = edges.get(id);
    if (!existing || STRENGTH[kind] > STRENGTH[existing.kind]) edges.set(id, { from, to, kind, labels });
  };
  const keys = new Map(repos.map((r) => [r.name, new Set(jiraKeys(r.subjects))]));
  const identRepos = new Map();
  for (const r of repos) for (const i of new Set(r.idents)) identRepos.set(i, (identRepos.get(i) ?? 0) + 1);
  const tooCommon = (ident) => repos.length >= 4 && (identRepos.get(ident) ?? 0) > Math.ceil(repos.length * 0.6);

  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) {
      const a = repos[i], b = repos[j];
      const shared = [...keys.get(a.name)].filter((k) => keys.get(b.name).has(k));
      if (shared.length) add(a.name, b.name, "jira", shared);
      const pointsAt = (x, y) => x.submodules.some((s) => s === baseName(y.name));
      if (pointsAt(a, b) || pointsAt(b, a)) add(a.name, b.name, "submodule", ["submodule"]);
      const bIdents = new Set(b.idents);
      const common = a.idents
        .filter((id) => bIdents.has(id) && !tooCommon(id))
        .sort((x, y) => (identRepos.get(x) ?? 0) - (identRepos.get(y) ?? 0) || y.length - x.length);
      if (common.length >= 2 || (common[0]?.length ?? 0) >= STRONG_IDENT_LENGTH) {
        add(a.name, b.name, "ident", common.slice(0, EDGE_LABEL_LIMIT));
      }
    }
  }
  return [...edges.values()];
}

export function relationsOf(edges, name) {
  const grouped = new Map();
  for (const e of edges) {
    if (e.from !== name) continue;
    const label = e.labels[0] ?? e.kind;
    const id = `${e.kind}|${label}`;
    const rel = grouped.get(id) ?? { kind: e.kind, label, targets: [] };
    rel.targets.push(e.to);
    grouped.set(id, rel);
  }
  return [...grouped.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export function submodulesOf(gitmodules) {
  return [...gitmodules.matchAll(/^\s*url\s*=\s*(.+)$/gm)]
    .map((m) => (m[1] ?? "").trim().replace(/\.git$/, "").split(/[/:]/).pop() ?? "")
    .filter(Boolean);
}
