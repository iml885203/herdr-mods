import { test } from "node:test";
import assert from "node:assert/strict";
import { capLines, collectDiff, collectDiffInputs, diffRows, diffWidth, isTooLarge, rowsOfDiff, tooLargeMessage, untrackedDiff, untrackedDiffs } from "../mods/session-changes/diff.js";

test("diffRows numbers old and new lines from each hunk header", () => {
  const rows = diffRows(["@@ -10,3 +20,3 @@", " keep", "-gone", "+new", " tail"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.number]), [["@", undefined], [" ", 20], ["-", 11], ["+", 21], [" ", 22]]);
});

test("an empty content line stays one visible space", () => {
  assert.equal(diffRows(["@@ -1 +1 @@", "+"])[1].text, " ");
});

test("capLines caps count and line length and marks truncation", () => {
  const out = capLines(["a", "b".repeat(10), "c"], { lines: 2, width: 4 });
  assert.deepEqual(out, ["a", "bbbb… (line truncated)"]);
});

test("untrackedDiff turns a whole file into an all-added diff with a git header", () => {
  const text = untrackedDiff("dir/a b.cs", "one\ntwo\n");
  assert.ok(text.startsWith("diff --git a/dir/a b.cs b/dir/a b.cs\n"));
  assert.ok(text.includes("+++ b/dir/a b.cs\n@@ -0,0 +1,2 @@\n+one\n+two"));
  assert.deepEqual(rowsOfDiff(text, { binary: false }), ["@@ -0,0 +1,2 @@", "+one", "+two"]);
});

test("rowsOfDiff drops the header before the first hunk, or explains an empty diff", () => {
  const text = "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  assert.deepEqual(rowsOfDiff(text, { binary: false }), ["@@ -1 +1 @@", "-a", "+b"]);
  assert.deepEqual(rowsOfDiff("", { binary: true }), ["Binary file changed"]);
  assert.deepEqual(rowsOfDiff("", { binary: false }), ["No text diff available"]);
});

test("diffWidth grows with the longest line", () => {
  assert.equal(diffWidth(["a"]), 300);
  assert.equal(diffWidth(["x".repeat(100)]), 750);
});

test("collectDiffInputs picks the tracked and the untracked files separately, skipping secrets, within each limit", () => {
  const files = [
    { path: "a.cs", fresh: false }, { path: "b.cs", fresh: false }, { path: ".env", fresh: false, secret: true },
    { path: "n1.txt", fresh: true }, { path: "n2.txt", fresh: true }, { path: "key.pem", fresh: true, secret: true },
  ];
  assert.deepEqual(collectDiffInputs(files, { tracked: 1, fresh: 5 }), { tracked: ["a.cs"], fresh: [files[3], files[4]] });
  assert.deepEqual(collectDiffInputs(files, { tracked: 5, fresh: 1 }).fresh, [files[3]]);
});

test("untrackedDiffs reads the files in one call within the character and line limits and skips what cannot be read", async () => {
  const texts = { "n1.txt": "l1\nl2\nl3\nl4\n", "n2.txt": null };
  const reads = [];
  const readMany = async (root, paths, chars) => { reads.push([root, paths, chars]); return paths.map((path) => texts[path]); };
  const out = await untrackedDiffs(readMany, "/r", [{ path: "n1.txt" }, { path: "n2.txt" }], { chars: 100, lines: 2 });
  assert.equal(out.length, 1);
  assert.ok(out[0].includes("+l1\n+l2") && !out[0].includes("l3"));
  assert.deepEqual(reads, [["/r", ["n1.txt", "n2.txt"], 100]]);
  const unlimited = await untrackedDiffs(readMany, "/r", [{ path: "n1.txt" }], { chars: 100 });
  assert.ok(unlimited[0].includes("+l4"));
  assert.deepEqual(await untrackedDiffs(async () => { throw new Error("no call"); }, "/r", [], { chars: 1 }), []);
});

test("collectDiff reads the tracked files in one git call and the untracked ones in one read, skipping secrets, within the limits", async () => {
  const calls = [];
  const source = {
    diffText: async (root, baseline, paths, context) => { calls.push(["diff", root, baseline, paths, context]); return "TRACKED"; },
    readFreshMany: async (root, paths, chars) => { calls.push(["read", root, paths, chars]); return paths.map(() => "x\n"); },
  };
  const files = [{ path: "a" }, { path: "s", secret: true }, { path: "n", fresh: true }, { path: "m", fresh: true }, { path: "b" }];
  const out = await collectDiff(source, { root: "/r", baseline: "base", files }, { tracked: 1, fresh: 1, chars: 50, context: 0 });
  assert.equal(out.tracked, "TRACKED");
  assert.equal(out.untracked.length, 1);
  assert.deepEqual(calls.sort(), [["diff", "/r", "base", ["a"], 0], ["read", "/r", ["n"], 50]].sort());
  const none = await collectDiff({ diffText: async () => assert.fail("no tracked file"), readFreshMany: async () => assert.fail("no untracked file") }, { root: "/r", baseline: "b", files: [] }, { tracked: 1, fresh: 1, chars: 1 });
  assert.deepEqual(none, { tracked: "", untracked: [] });
});

test("a tracked diff of more than twenty thousand changed lines is too large to read into the panel, a binary or untracked file never is", () => {
  assert.equal(isTooLarge({ added: 15000, deleted: 6000 }), true);
  assert.equal(isTooLarge({ added: 100, deleted: 100 }), false);
  assert.equal(isTooLarge({ added: 99999, deleted: 0, binary: true }), false);
  assert.equal(isTooLarge({ added: null, deleted: 0, fresh: true }), false);
  assert.equal(isTooLarge({ added: 1, deleted: 1 }, 5_000_000), false);
  assert.ok(tooLargeMessage({ added: 15000, deleted: 6000 }).includes("+15000 −6000"));
});

test("an empty untracked file has no hunk, so the view says there is no text diff", () => {
  const text = untrackedDiff(".gitkeep", "");
  assert.ok(!text.includes("@@"));
  assert.deepEqual(rowsOfDiff(text, { binary: false }), ["No text diff available"]);
});
