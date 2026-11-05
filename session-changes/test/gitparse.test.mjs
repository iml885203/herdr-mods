import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffRaw, parseLog, parseProbeStats, parseStatus, EMPTY_TREE } from "../mods/session-changes/gitparse.js";

test("parseStatus maps paths to XY and skips the origin of a rename", () => {
  const z = " M src/a.cs\0?? new.txt\0R  moved.cs\0old.cs\0A  added.cs\0";
  assert.deepEqual([...parseStatus(z)], [["src/a.cs", " M"], ["new.txt", "??"], ["moved.cs", "R "], ["added.cs", "A "]]);
});

const raw = (letter, path) => `:100644 100644 1234567 89abcde ${letter}\0${path}\0`;

test("parseDiffRaw pairs letters with paths and folds type changes into M, and reads the numstat records after them", () => {
  const z = raw("M", "a.cs") + raw("A", "dir/b.cs") + raw("D", "c.cs") + raw("T", "d.cs") + raw("U", "e.cs")
    + "3\t1\ta.cs\0" + "-\t-\timg.png\0" + "2\t0\twith\ttab.txt\0";
  const { nameStatus, numstat } = parseDiffRaw(z);
  assert.deepEqual([...nameStatus], [["a.cs", "M"], ["dir/b.cs", "A"], ["c.cs", "D"], ["d.cs", "M"], ["e.cs", "U"]]);
  assert.deepEqual(numstat.get("a.cs"), { added: 3, deleted: 1, binary: false });
  assert.deepEqual(numstat.get("img.png"), { added: 0, deleted: 0, binary: true });
  assert.deepEqual(numstat.get("with\ttab.txt"), { added: 2, deleted: 0, binary: false });
});

test("parseDiffRaw never mistakes a path that looks like a record for one, and an empty diff is empty", () => {
  const z = raw("M", ":100644 100644 aaa bbb M") + raw("A", "1\t2\tfake") + "1\t0\t:100644 100644 aaa bbb M\0";
  const { nameStatus, numstat } = parseDiffRaw(z);
  assert.deepEqual([...nameStatus.keys()], [":100644 100644 aaa bbb M", "1\t2\tfake"]);
  assert.deepEqual([...numstat.keys()], [":100644 100644 aaa bbb M"]);
  const none = parseDiffRaw("");
  assert.equal(none.nameStatus.size + none.numstat.size, 0);
});

test("parseLog gives each commit its subject, committer time and files, and null for a line without a time", () => {
  const text = "\x011762250000 feat: one SHOP-1\n\na.cs\nb/c.cs\n\x01 fix: two\n\nd.cs\n\x011762250100 12 empty commit\n";
  assert.deepEqual(parseLog(text), [
    { subject: "feat: one SHOP-1", ts: 1762250000, files: ["a.cs", "b/c.cs"] },
    { subject: " fix: two", ts: null, files: ["d.cs"] },
    { subject: "12 empty commit", ts: 1762250100, files: [] },
  ]);
  assert.deepEqual(parseLog(""), []);
});

test("parseProbeStats keeps the mtime and size of the files inside the repo, by relative path", () => {
  const probe = "abc|/r/.git/index 100:2000\n/r/src/a b.cs 150:30\n/other/x.cs 1:1\n";
  const stats = parseProbeStats(probe, "/r");
  assert.deepEqual(stats.get("src/a b.cs"), { mtime: "150", size: "30" });
  assert.deepEqual(stats.get(".git/index"), { mtime: "100", size: "2000" });
  assert.equal(stats.size, 2);
  assert.equal(parseProbeStats("h1|s1", "/r").size, 0);
});

test("the empty tree is git's well-known id", () => {
  assert.equal(EMPTY_TREE, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
});

test("parseDiffRaw carries the post-image blob id, and leaves out an all-zero one (a worktree file git has not hashed)", () => {
  const z = `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0a.cs\0:100644 100644 ${"1".repeat(40)} ${"0".repeat(40)} M\0b.cs\0`;
  const { blobs } = parseDiffRaw(z);
  assert.deepEqual([...blobs], [["a.cs", "2".repeat(40)]]);
});
