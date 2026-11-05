const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)/;

export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const hunk = HUNK.exec(line);
    if (hunk) { old = +hunk[1]; next = +hunk[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    const text = line.slice(1) || " ";
    if (kind === "-") return { kind, number: old++, text };
    if (kind === "+") return { kind, number: next++, text };
    if (kind === " ") { old++; return { kind, number: next++, text }; }
    return { kind: "", text: line };
  });
}

export function capLines(lines, { lines: maxLines, width }) {
  return lines.slice(0, maxLines).map((line) => (line.length > width ? `${line.slice(0, width)}… (line truncated)` : line));
}

export function untrackedDiff(path, text) {
  const head = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  if (text === "") return head;
  const body = text.replace(/\n$/, "").split("\n");
  return `${head}@@ -0,0 +1,${body.length} @@\n${body.map((line) => `+${line}`).join("\n")}\n`;
}

export function rowsOfDiff(text, { binary }) {
  const all = text.replace(/\n$/, "").split("\n");
  const first = all.findIndex((line) => line.startsWith("@@"));
  if (first >= 0) return all.slice(first);
  return [binary ? "Binary file changed" : "No text diff available"];
}

export const diffWidth = (lines) => Math.max(300, ...lines.map((line) => line.length * 7 + 50));

export function collectDiffInputs(files, limits) {
  const plain = files.filter((f) => !f.secret);
  return {
    tracked: plain.filter((f) => !f.fresh).slice(0, limits.tracked).map((f) => f.path),
    fresh: plain.filter((f) => f.fresh).slice(0, limits.fresh),
  };
}

// `readMany(root, paths, chars)` answers one text (or null) per path, in order.
export async function untrackedDiffs(readMany, root, files, { chars, lines = Infinity }) {
  if (!files.length) return [];
  const texts = await readMany(root, files.map((f) => f.path), chars);
  return files.flatMap((f, i) => (texts[i] === null ? [] : [untrackedDiff(f.path, texts[i].split("\n").slice(0, lines).join("\n"))]));
}

// The diff text of a set of files, read the same way for the summary prompt and for the cross-repo identifiers:
// tracked files in one git call, untracked ones in one shell call. `source` is the git object (diffText, readFreshMany).
export async function collectDiff(source, { root, baseline, files }, limits) {
  const { tracked, fresh } = collectDiffInputs(files, limits);
  const [trackedText, untracked] = await Promise.all([
    tracked.length ? source.diffText(root, baseline, tracked, limits.context, limits.bytes) : "",
    untrackedDiffs(source.readFreshMany, root, fresh, limits),
  ]);
  return { tracked: trackedText, untracked };
}

export const DIFF_TOO_LARGE_CHANGES = 20000;

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// `size` is the file's size on disk, as a number or the string the probe read, or null when unknown.
const sizeOf = (size) => (size === null || size === undefined || size === "" || !Number.isFinite(Number(size)) ? null : Number(size));

export const tooLargeMessage = ({ added, deleted }, size = null) => {
  const bytes = sizeOf(size);
  return `Diff too large to show (+${added ?? 0} \u2212${deleted ?? 0} lines${bytes === null ? "" : `, ${megabytes(bytes)}`}). Use Diff in VS Code (d).`;
};

// Only the changed-line count refuses up front: a big file with a small edit is read, bounded by the byte cap, and shows the truncation notice if it hits it.
export const isTooLarge = (file) => !file.fresh && !file.binary && (file.added ?? 0) + (file.deleted ?? 0) > DIFF_TOO_LARGE_CHANGES;

export const truncatedMessage = (bytes) => `Diff truncated after ${megabytes(bytes)}. Use Diff in VS Code (d).`;
