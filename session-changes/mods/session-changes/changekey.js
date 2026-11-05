import { hashOf } from "./hash.js";
import { DEFAULT_LANGUAGE } from "./languages.js";
import { ownedFiles } from "./model.js";

const SUMMARY_VERSION = 6;

// What the prompt is built from: the session's commit subjects and its files. HEAD is not part of it, so a commit, an amend, a rebase or a pull
// that leaves the owned diff and the subjects alone costs no summary.
const subjectsHash = (subjects) => hashOf(subjects.join("\n"));

export const changeShape = (subjects, paths) => `${subjectsHash(subjects)}|${hashOf([...paths].sort().join(","))}`;

export const changeStats = (files) => Object.fromEntries(files.map((f) => [f.path, [f.added ?? 0, f.deleted ?? 0]]));

// Size, not git's blob id: with autoRefreshIndex off a touched file reports an all-zero blob, so a blob-based key would flip on a touch and pay twice.
const fileSig = (f, stats) => `${f.path}:${f.status}:${f.added ?? "-"}:${f.deleted}:${stats?.get(f.path)?.size ?? ""}`;

// The key follows what the change is (the session's commit subjects, each file's status, line counts and size on disk), never a modification time,
// so a touch, a formatter run or a checkout that leaves the content alone costs no summary. The size catches most edits that keep the line counts.
export const summaryKey = (subjects, files, language = DEFAULT_LANGUAGE, stats = null) =>
  `v${SUMMARY_VERSION}|${hashOf(`${language}\n${subjectsHash(subjects)}\n${files.map((f) => fileSig(f, stats)).sort().join(",")}`)}`;

export const subjectsOf = (state) => state.repo.subjects ?? [];
export const summaryKeyOf = (state, language = DEFAULT_LANGUAGE) => summaryKey(subjectsOf(state), ownedFiles(state.repo.files), language, state.stats);
export const changeShapeOf = (state, owned) => changeShape(subjectsOf(state), owned.map((f) => f.path));
