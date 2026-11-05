import { EMPTY_TREE, parseDiffRaw, parseLog, parseStatus } from "./gitparse.js";
import { buildFiles } from "./model.js";
import { addedIdentifiers, submodulesOf } from "./graph.js";
import { capLines, collectDiff, isTooLarge, rowsOfDiff, tooLargeMessage, truncatedMessage, untrackedDiff } from "./diff.js";
import { createGate } from "./gate.js";
import { ROOTS_SCRIPT, parseRootRecords, placeOf } from "./roots.js";
import { lazyScratchDir } from "./scratch.js";

// UTF-8 byte length without Node's Buffer (mods run in QuickJS).
const utf8Bytes = (text) => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
};

const READ_ONLY_GIT = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const CONCURRENCY = 4;
const ROOTS_BATCH = 300;
const DIFF_LIMITS = { lines: 1500, width: 4000 };
const PREVIEW_CHARS = 400000;
// Bytes of a tracked diff read into JS: `head -c` cuts the stream in the shell, so a huge diff never crosses the process boundary whole.
export const DIFF_VIEW_BYTES = 2_000_000;
export const DIFF_TEXT_BYTES = 200_000;
const IDENT_DIFF_CHARS = 300000;
const IDENT_LIMITS = { tracked: 200, fresh: 20, chars: IDENT_DIFF_CHARS, context: 0, bytes: DIFF_TEXT_BYTES };
const FRESH_BATCH = 100;
// Reads the head of each file in one process. Every record starts with a marker made of a per-call nonce, then `+` and the text, or `-` for a symlink or an unreadable file.
const READ_FRESH = 'n=$1; l=$2; shift 2; for f; do printf "\\001%s" "$n"; if [ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ]; then printf "+\\n"; head -c "$l" < "$f"; else printf "-\\n"; fi; done';
const STAT_BATCH = 200;
// `git diff` for some paths, cut to `$1` bytes. Arguments: limit, root, baseline, context, then the paths (all passed as positional parameters, never spliced into the script).
const DIFF_BOUNDED = `l=$1; r=$2; b=$3; c=$4; shift 4; git ${READ_ONLY_GIT.join(" ")} -C "$r" -c core.quotepath=false diff "$b" "-U$c" --no-color --no-ext-diff --no-textconv -- "$@" | head -c "$l"`;
const BASE_VERSION = 'umask 077; f="$5/$4-$(basename -- "$3")" && { git -C "$1" show "$2:$3" > "$f" 2>/dev/null || : > "$f"; } && printf %s "$f"';

const gitTime = (ts) => `${new Date(ts).toISOString().slice(0, 19)}+0000`;
const out = (result) => (result.code === 0 ? result.stdout : "");

export function createGit(io) {
  const gate = createGate(CONCURRENCY);
  const git = (cwd, args) => gate(() => io.exec("git", [...READ_ONLY_GIT, ...args], { cwd }));
  const scratch = lazyScratchDir(io.exec);
  const indexes = new Map();
  const slots = new Map();

  const shell = (script, args) => gate(() => io.exec("sh", ["-c", script, "sh", ...args]));

  async function rootsOf(dirs) {
    const places = new Map();
    for (let i = 0; i < dirs.length; i += ROOTS_BATCH) {
      const answered = await shell(ROOTS_SCRIPT, dirs.slice(i, i + ROOTS_BATCH));
      for (const [dir, record] of parseRootRecords(answered.stdout)) places.set(dir, record && placeOf(dir, record));
    }
    return new Map(dirs.map((dir) => [dir, places.get(dir) ?? null]));
  }

  async function baselineOf(root, ts) {
    const found = await git(root, ["rev-list", "-1", "--first-parent", `--before=${gitTime(ts - 1000)}`, "HEAD"]);
    if (found.code === 0) return found.stdout.trim() || EMPTY_TREE;
    const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (head.code !== 0) return EMPTY_TREE;
    throw new Error(found.stderr.trim() || `git rev-list failed in ${root}`);
  }

  function indexPathOf(root) {
    if (!indexes.has(root)) {
      const pending = git(root, ["rev-parse", "--git-path", "index"]).then((found) => {
        const path = found.stdout.trim();
        return path.startsWith("/") ? path : `${root}/${path || ".git/index"}`;
      });
      indexes.set(root, pending);
      pending.catch(() => indexes.delete(root));
    }
    return indexes.get(root);
  }

  // HEAD, the upstream's commit and the branch name, in one rev-parse. With no upstream `@{u}` fails after HEAD was printed, so the branch is asked again.
  async function refsOf(root) {
    const found = await git(root, ["rev-parse", "HEAD", "@{u}", "--abbrev-ref", "HEAD"]);
    if (found.code === 0) {
      const [head = "", upstream = "", branch = ""] = found.stdout.split("\n");
      return { head: head.trim(), upstream: upstream.trim(), branch: branch.trim() };
    }
    const bare = await git(root, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]);
    const [head = "", branch = ""] = out(bare).split("\n");
    return { head: head.trim(), upstream: "", branch: branch.trim() };
  }

  async function probeOf(root, relFiles) {
    const paths = [await indexPathOf(root), ...relFiles.map((file) => `${root}/${file}`)];
    const stats = [];
    for (let i = 0; i < paths.length; i += STAT_BATCH) {
      stats.push(gate(() => io.exec("stat", ["-f", "%N %m:%z", ...paths.slice(i, i + STAT_BATCH)])).catch((e) => ({ stdout: String(e) })));
    }
    const [refs, ...answers] = await Promise.all([refsOf(root), ...stats]);
    // A branch name can hold `|`, which would end the first field early, so it is not written raw.
    return `${refs.head} ${refs.upstream} ${refs.branch.replaceAll("|", "_")}|${answers.map((a) => a.stdout).join("")}`;
  }

  // The commit log is read again only when HEAD, the baseline or the window start moved: it does not depend on the window end, which is applied here.
  // A snapshot is taken when the probe changed, and the probe holds HEAD, the upstream's commit and the branch name, so a push from another terminal or a
  // checkout that keeps HEAD still reaches here; `ahead` and the branch are therefore read fresh in every snapshot.
  async function snapshotOf(root, baseline, since, until, previous = null) {
    const [status, changes, ahead, refs] = await Promise.all([
      git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
      git(root, ["diff", baseline, "--raw", "--numstat", "-z", "--no-renames"]),
      git(root, ["rev-list", "--count", "@{u}..HEAD"]),
      refsOf(root),
    ]);
    const { head, branch } = refs;
    if (status.code !== 0) throw new Error(status.stderr.trim() || `git status failed in ${root}`);
    if (changes.code !== 0) throw new Error(changes.stderr.trim() || `git diff failed in ${root}`);
    const logKey = `${head}|${baseline}|${since}`;
    const history = previous?.history?.key === logKey ? previous.history : { key: logKey, commits: await commitsSince(root, baseline, since) };
    const untilSec = Math.floor(until / 1000);
    const { nameStatus, numstat, blobs } = parseDiffRaw(out(changes));
    return {
      files: buildFiles({ nameStatus, numstat, blobs, status: parseStatus(status.stdout) }),
      commits: history.commits.filter((c) => c.ts === null || c.ts <= untilSec),
      history,
      branch: branch || "HEAD",
      ahead: ahead.code === 0 ? Number(ahead.stdout.trim()) : null,
      head,
    };
  }

  async function commitsSince(root, baseline, since) {
    const range = baseline === EMPTY_TREE ? ["HEAD"] : [`${baseline}..HEAD`];
    const log = await git(root, ["-c", "core.quotepath=false", "log", "--no-merges", "--no-renames", `--since=${gitTime(since)}`, "--name-only", "--format=%x01%ct %s", ...range]);
    return parseLog(out(log));
  }

  // One process for all the files; a symlink, a missing or unreadable file, or a binary one (a NUL byte) answers null.
  async function readFreshMany(root, paths, limit) {
    const texts = new Map();
    for (let i = 0; i < paths.length; i += FRESH_BATCH) {
      const batch = paths.slice(i, i + FRESH_BATCH);
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const marker = `\x01${nonce}`;
      const result = await shell(READ_FRESH, [nonce, String(limit), ...batch.map((path) => `${root}/${path}`)]).catch(() => null);
      const records = (result?.stdout ?? "").split(marker).slice(1);
      batch.forEach((path, at) => {
        const record = records[at];
        texts.set(path, record?.[0] === "+" && !record.includes("\0") ? record.slice(2) : null);
      });
    }
    return paths.map((path) => texts.get(path) ?? null);
  }

  async function readFresh(root, path, limit) {
    return (await readFreshMany(root, [path], limit))[0];
  }

  async function identsOf(root, baseline, files) {
    const { tracked, untracked } = await collectDiff({ diffText, readFreshMany }, { root, baseline, files }, IDENT_LIMITS);
    return addedIdentifiers([tracked.slice(0, IDENT_DIFF_CHARS), ...untracked].join("\n"));
  }

  async function submodulesIn(root) {
    const text = await io.readTextFile(`${root}/.gitmodules`).catch(() => null);
    return text ? submodulesOf(text) : [];
  }

  const boundedDiff = (root, baseline, context, bytes, paths) => shell(DIFF_BOUNDED, [String(bytes), root, baseline, String(context), ...paths]);

  // `size` is the file's size on disk (from the probe), when known: a minified bundle or a lockfile can be one huge line that numstat counts as a few.
  async function diffLines(root, baseline, file, size = null) {
    if (file.secret) return ["Secret file: diff hidden"];
    if (file.fresh) {
      const text = await readFresh(root, file.path, PREVIEW_CHARS);
      return text === null ? ["Cannot preview this file (binary, symlink, or unreadable)"] : capLines(rowsOfDiff(untrackedDiff(file.path, text), file), DIFF_LIMITS);
    }
    if (isTooLarge(file)) return [tooLargeMessage(file, size)];
    const result = await boundedDiff(root, baseline, 3, DIFF_VIEW_BYTES, [file.path]);
    if (!result.stdout && result.stderr.trim()) throw new Error(result.stderr.trim());
    const rows = capLines(rowsOfDiff(result.stdout, file), DIFF_LIMITS);
    return utf8Bytes(result.stdout) >= DIFF_VIEW_BYTES ? [...rows, truncatedMessage(DIFF_VIEW_BYTES)] : rows;
  }

  // At most `bytes` of the diff are read; the rest never leaves the shell.
  async function diffText(root, baseline, paths, context = 2, bytes = DIFF_TEXT_BYTES) {
    if (!paths.length) return "";
    const result = await boundedDiff(root, baseline, context, bytes, paths);
    if (!result.stdout && result.stderr.trim()) throw new Error(result.stderr.trim());
    return out(result);
  }

  async function baseVersionFile(root, baseline, path) {
    const dir = await scratch.get();
    const key = `${root}\0${path}`;
    if (!slots.has(key)) slots.set(key, slots.size);
    const result = await io.exec("sh", ["-c", BASE_VERSION, "sh", root, baseline, path, String(slots.get(key)), dir]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async function dispose() {
    if (await scratch.dispose()) slots.clear();
  }

  return { rootsOf, baselineOf, probeOf, snapshotOf, identsOf, submodulesIn, diffLines, diffText, readFresh, readFreshMany, baseVersionFile, dispose };
}
