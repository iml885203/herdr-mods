import { isOwned, ownedFiles } from "./model.js";

const MAJORITY = 0.6;
const FILE_LIMIT = 300;

const dirsOf = (path) => path.split("/").slice(0, -1);

function commonDir(paths) {
  const first = dirsOf(paths[0]);
  let n = 0;
  while (n < first.length && paths.every((p) => dirsOf(p)[n] === first[n])) n++;
  return n ? `${first.slice(0, n).join("/")}/` : "";
}

export function majorityDir(paths) {
  if (paths.length < 2) return paths.length ? commonDir(paths) : "";
  const counts = new Map();
  for (const path of paths) {
    const parts = dirsOf(path);
    for (let i = 1; i <= parts.length; i++) {
      const dir = `${parts.slice(0, i).join("/")}/`;
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const need = Math.max(2, Math.ceil(paths.length * MAJORITY));
  return [...counts].filter(([, n]) => n >= need).sort((a, b) => b[0].length - a[0].length)[0]?.[0] ?? "";
}

export function groupByDir(files, prefix) {
  const groups = new Map();
  for (const file of files) {
    const rest = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : `/${file.path}`;
    const cut = rest.lastIndexOf("/");
    const dir = cut < 0 ? "" : rest.slice(0, cut + 1);
    const entry = { file, name: rest.slice(cut + 1) };
    const group = groups.get(dir);
    if (group) group.push(entry);
    else groups.set(dir, [entry]);
  }
  const outlier = (dir) => (dir.startsWith("/") ? 1 : 0);
  return [...groups].sort(([a], [b]) => outlier(a) - outlier(b) || a.localeCompare(b)).map(([dir, entries]) => ({ dir, entries }));
}

export function rowKey(row) {
  return row.kind === "repo" ? `repo:${row.root}` : `file:${row.root}:${row.file.path}`;
}

export const rowId = (row, index) => (row.selectable ? rowKey(row) : `row:${index}`);

function fileRows(root, files, budget) {
  const rows = [];
  const prefix = majorityDir(files.map((f) => f.path));
  const groups = groupByDir(files, prefix);
  let left = budget;
  for (const group of groups) {
    if (left <= 0) break;
    const shown = group.entries.slice(0, left);
    const title = group.dir.startsWith("/") ? group.dir.slice(1) : prefix + group.dir;
    rows.push({ kind: "folder", text: title || "." });
    for (const entry of shown) rows.push({ kind: "file", root, file: entry.file, name: entry.name, selectable: true });
    left -= shown.length;
  }
  return { rows, shown: budget - left };
}

function detailRows(repo, expanded, fileLimit) {
  if (!expanded) return [];
  const ours = ownedFiles(repo.files);
  const other = repo.files.filter((f) => !isOwned(f));
  const rows = [];
  let budget = fileLimit;
  for (const [files, divider] of [[ours, false], [other, true]]) {
    if (!files.length) continue;
    if (divider) rows.push({ kind: "divider", text: "other source" });
    const part = fileRows(repo.root, files, budget);
    rows.push(...part.rows);
    budget -= part.shown;
    if (part.shown < files.length) rows.push({ kind: "more", count: files.length - part.shown });
  }
  if (repo.noise) rows.push({ kind: "noise", count: repo.noise });
  if (repo.truncated) rows.push({ kind: "truncated", count: repo.truncated });
  return rows;
}

function headlineRow(repo, summary) {
  if (summary) return { kind: "headline", text: summary.headline, dim: summary.stale, failed: summary.failed, pending: summary.pending };
  return repo.subjects[0] ? { kind: "headline", text: repo.subjects[0], dim: false } : null;
}

function pointRows(summary, relations) {
  const rows = (summary?.points ?? []).map((text) => ({ kind: "point", text, dim: summary.stale }));
  if (relations?.length) rows.push({ kind: "links", relations });
  return rows;
}

export function flattenRows({ repos, expanded, summaries, relations, fileLimit = FILE_LIMIT }) {
  const rows = [];
  let layer = null;
  for (const repo of repos) {
    if (repo.layer !== layer) { layer = repo.layer; rows.push({ kind: "layer", layer }); }
    const open = expanded.has(repo.root);
    rows.push({ kind: "repo", repo, root: repo.root, open, selectable: true });
    const headline = headlineRow(repo, summaries[repo.root]);
    if (headline) rows.push(headline);
    if (open) rows.push(...pointRows(summaries[repo.root], relations[repo.root]));
    rows.push(...detailRows(repo, open, fileLimit));
  }
  return rows;
}

export function moveSelection(rows, key, step) {
  const keys = rows.filter((r) => r.selectable).map(rowKey);
  const at = keys.indexOf(key);
  if (at < 0) return keys[0] ?? null;
  return keys[Math.min(keys.length - 1, Math.max(0, at + step))];
}

export const layerTitle = (layer) => ({ db: "DB", service: "Service", sdk: "SDK", api: "API", ui: "UI", tests: "Tests", other: "Other" })[layer] ?? layer;
