import { isNoise, isSecret, layerOf, layerRank, relate, relationsOf } from "./graph.js";
import { baseName, compare } from "./paths.js";

const FILE_LIMIT = 1500;

export const isOwned = (file) => file.owner === "session";
export const ownedFiles = (files) => files.filter(isOwned);

function letterOf(letter, xy) {
  const conflict = xy !== undefined && (xy.includes("U") || xy === "AA" || xy === "DD");
  return conflict ? "U" : letter;
}

export function buildFiles({ nameStatus, numstat, status, blobs = new Map() }) {
  const files = [];
  for (const [path, letter] of nameStatus) {
    const stat = numstat.get(path) ?? { added: 0, deleted: 0, binary: false };
    files.push({ path, status: letterOf(letter, status.get(path)), fresh: false, dirty: status.has(path), ...stat, ...(blobs.has(path) ? { blob: blobs.get(path) } : {}) });
  }
  for (const [path, xy] of status) {
    if (xy === "??") files.push({ path, status: "A", fresh: true, dirty: true, added: null, deleted: 0, binary: false });
  }
  return files;
}

// A repo with no upstream (`ahead` is null) is never "pushed", whatever the commit window saw: the session commits are counted inside a time window,
// and a commit made after it (or before the first recorded edit) is missing from that count while the files it holds are still shown.
export function pushState({ files, ahead }) {
  if (files.some((f) => isOwned(f) && f.dirty)) return "dirty";
  if (ahead === null) return "no-upstream";
  return ahead > 0 ? "unpushed" : "pushed";
}

export function buildRepo({ root, branch, ahead, commits, edited, files, limit = FILE_LIMIT }) {
  const committed = new Set(commits.flatMap((c) => c.files));
  const classified = files
    .map((f) => ({ ...f, owner: edited.has(f.path) || committed.has(f.path) ? "session" : "other", secret: isSecret(f.path) }))
    .filter((f) => !isNoise(f.path, { owned: isOwned(f) }))
    .sort((a, b) => compare(a.path, b.path));
  const ours = ownedFiles(classified);
  const kept = [...ours.slice(0, limit), ...classified.filter((f) => !isOwned(f)).slice(0, Math.max(0, limit - ours.length))].sort((a, b) => compare(a.path, b.path));
  const subjects = commits.map((c) => c.subject);
  return {
    root,
    label: baseName(root),
    branch,
    ahead,
    files: kept,
    truncated: classified.length - kept.length,
    owned: ours.length,
    noise: files.length - classified.length,
    added: ours.reduce((n, f) => n + (f.added ?? 0), 0),
    deleted: ours.reduce((n, f) => n + f.deleted, 0),
    subjects,
    state: pushState({ files: classified, ahead }),
    layer: layerOf(baseName(root), (ours.length ? ours : classified).map((f) => f.path)),
  };
}

export function repoLabels(roots) {
  const clash = (root) => roots.filter((other) => baseName(other) === baseName(root)).length > 1;
  return new Map(roots.map((root) => [root, clash(root) ? root.split("/").slice(-2).join("/") : baseName(root)]));
}

export const orderRepos = (repos) =>
  [...repos].sort((a, b) => layerRank(a.layer) - layerRank(b.layer) || compare(a.label, b.label));

export const sessionTotals = (repos) => ({
  repos: repos.length,
  files: repos.reduce((n, r) => n + r.owned, 0),
  added: repos.reduce((n, r) => n + r.added, 0),
  deleted: repos.reduce((n, r) => n + r.deleted, 0),
  unpushed: repos.reduce((n, r) => n + (r.ahead ?? 0), 0),
});

export function buildSession(states) {
  const shown = states.filter((s) => s.repo?.owned > 0);
  const labels = repoLabels(shown.map((s) => s.root));
  const byRoot = new Map(shown.map((s) => [s.root, s]));
  const views = orderRepos(shown.map((s) => ({ ...s.repo, label: labels.get(s.root) })));
  const layers = new Map(views.map((r) => [r.root, r.layer]));
  const edges = relate(
    views.map((r) => {
      const state = byRoot.get(r.root);
      return { name: r.root, files: r.files, subjects: [...r.subjects, r.branch], idents: state.idents ?? [], submodules: state.submodules };
    }),
    (root) => layers.get(root) ?? "other",
  );
  const labelOf = (root) => labels.get(root) ?? root;
  const relations = Object.fromEntries(views.map((r) => [r.root, relationsOf(edges, r.root).map((rel) => ({ ...rel, targets: rel.targets.map(labelOf) }))]));
  return { views, relations, totals: sessionTotals(views) };
}

// What the open diff depends on: the file's own status, line counts and size/mtime, not the repo's version, which moves with any other file.
export function diffStamp(open, state, file) {
  if (!open || !state || !file) return "";
  const stat = state.stats?.get(open.path);
  return `${open.root}|${open.path}|${file.status}:${file.added ?? "-"}:${file.deleted}:${file.dirty ? 1 : 0}|${stat ? `${stat.mtime}:${stat.size}` : ""}`;
}

export function emptyMessage({ starting, session, error, loaded, pending }) {
  if (starting) return "Looking for a Claude session…";
  if (!session) return "No Claude session. Focus a terminal running claude, or press p.";
  if (error) return error;
  return loaded && !pending ? "No changes this session" : "Reading the session…";
}
