import { test } from "node:test";
import assert from "node:assert/strict";
import { commandDirs, createTouches, foldEvents, groupTouches, parseToolUses } from "../mods/session-changes/transcript.js";

const HOME = "/Users/me";
const line = (content, extra = {}) =>
  JSON.stringify({ type: "assistant", timestamp: "2026-11-04T10:00:00.000Z", cwd: "/w/proj", message: { content }, ...extra });
const use = (name, input) => ({ type: "tool_use", id: "t", name, input });
const dirsOf = (command, cwd = "/w/proj") => commandDirs(command, cwd, HOME).dirs;

test("commandDirs reads cd and git -C with or without quotes, including paths with spaces", () => {
  assert.deepEqual(dirsOf("git -C /a/b status"), ["/w/proj", "/a/b"]);
  assert.deepEqual(dirsOf("cd '/a/b' && ls"), ["/w/proj", "/a/b"]);
  assert.deepEqual(dirsOf('cd "/a b/c"; make'), ["/w/proj", "/a b/c"]);
  assert.deepEqual(dirsOf('git -C "/a b" log'), ["/w/proj", "/a b"]);
  assert.deepEqual(dirsOf("ls /a/b"), ["/w/proj"]);
});

test("commandDirs follows a cd that comes after && or ;, and chains relative cds", () => {
  assert.deepEqual(dirsOf("git status && cd /x && ls"), ["/w/proj", "/x"]);
  assert.deepEqual(dirsOf("echo hi; cd sub; cd ../other"), ["/w/proj", "/w/proj/sub", "/w/proj/other"]);
  assert.deepEqual(dirsOf("cd /x && git -C y status"), ["/w/proj", "/x", "/x/y"]);
});

test("commandDirs expands ~ and $HOME, and ignores a bare cd or cd -", () => {
  assert.deepEqual(dirsOf("cd ~/dev/repo && ls"), ["/w/proj", "/Users/me/dev/repo"]);
  assert.deepEqual(dirsOf("cd $HOME/dev"), ["/w/proj", "/Users/me/dev"]);
  assert.deepEqual(dirsOf("cd && ls"), ["/w/proj"]);
  assert.deepEqual(dirsOf("cd - && ls"), ["/w/proj"]);
});

test("a cd inside quotes or an echo is not a directory change", () => {
  assert.deepEqual(dirsOf('echo "cd /a && ls"'), ["/w/proj"]);
  assert.deepEqual(dirsOf("echo cd /a && ls"), ["/w/proj"]);
});

test("absolute paths in a command are only hints, never directories", () => {
  const { dirs, hints } = commandDirs('cat /a/b.txt "/c d" --out=/e/f (/g/h) ~/z https://x.com/y/z', "/w/proj", HOME);
  assert.deepEqual(dirs, ["/w/proj"]);
  assert.deepEqual(hints, ["/a/b.txt", "/c d", "/e/f", "/g/h", "/Users/me/z"]);
});

test("parseToolUses turns edits into files and Bash into dirs and hints, stamped with the line time", () => {
  const text = [
    line([use("Edit", { file_path: "/r/a.cs", old_string: "x", new_string: "y" })]),
    line([use("Write", { file_path: "rel/b.cs", content: "z" })]),
    line([use("MultiEdit", { file_path: "/r/c.cs", edits: [] })]),
    line([use("NotebookEdit", { notebook_path: "/r/n.ipynb" })]),
    line([use("Bash", { command: "cd /r2 && cat /r3/x" })]),
    line([use("Read", { file_path: "/r/read.cs" })]),
    line([use("Edit", { file_path: "~/n/e.cs" })]),
  ].join("\n");
  const events = parseToolUses(text, HOME);
  assert.deepEqual(events.map((e) => e.files), [["/r/a.cs"], ["/w/proj/rel/b.cs"], ["/r/c.cs"], ["/r/n.ipynb"], [], ["/Users/me/n/e.cs"]]);
  assert.deepEqual(events[4].dirs, ["/w/proj", "/r2"]);
  assert.deepEqual(events[4].hints, ["/r3/x"]);
  assert.equal(events[0].ts, Date.parse("2026-11-04T10:00:00.000Z"));
});

test("parseToolUses skips lines without tool_use, broken JSON and results", () => {
  const text = [
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "tool_use mentioned in text" }] } }),
    '{not json but has "tool_use" in it',
    line([{ type: "text", text: "no tools" }]),
    "",
  ].join("\n");
  assert.deepEqual(parseToolUses(text, HOME), []);
});

test("one line may carry several tool uses", () => {
  const events = parseToolUses(line([use("Edit", { file_path: "/r/a" }), use("Edit", { file_path: "/r/b" })]), HOME);
  assert.deepEqual(events.flatMap((e) => e.files), ["/r/a", "/r/b"]);
});

const ev = (ts, files = [], dirs = [], hints = []) => ({ ts, files, dirs, hints });

test("foldEvents keeps the earliest and latest time per path", () => {
  const touches = createTouches();
  foldEvents(touches, [ev(50, ["/r/a"], ["/r"])]);
  foldEvents(touches, [ev(50, ["/r/a"], ["/r"])]);
  foldEvents(touches, [ev(90, ["/r/a"])]);
  foldEvents(touches, [ev(10, ["/r/a"])]);
  assert.deepEqual(touches.files.get("/r/a"), { first: 10, last: 90 });
  assert.deepEqual(touches.dirs.get("/r"), { first: 50, last: 50 });
});

const rootsOf = (map) => (dir) => map[dir] ?? null;

test("groupTouches assigns files to the repo of their folder, with its prefix, and takes the earliest time", () => {
  const touches = createTouches();
  foldEvents(touches, [ev(30, ["/r/src/a.cs"]), ev(20, [], ["/r"]), ev(40, ["/x/loose.txt", "/s/b.cs"], ["/x"])]);
  const grouped = groupTouches(touches, rootsOf({ "/r/src": { root: "/r", prefix: "src/" }, "/r": { root: "/r", prefix: "" }, "/s": { root: "/s", prefix: "" } }));
  assert.deepEqual([...grouped.keys()].sort(), ["/r", "/s"]);
  assert.equal(grouped.get("/r").firstTs, 20);
  assert.equal(grouped.get("/r").lastTs, 30);
  assert.deepEqual([...grouped.get("/r").files], ["src/a.cs"]);
  assert.deepEqual([...grouped.get("/s").files], ["b.cs"]);
});

test("a symlinked path keeps its file because the prefix comes from git, not from string matching", () => {
  const touches = createTouches();
  foldEvents(touches, [ev(1, ["/tmp/link/sub/a.cs"])]);
  const grouped = groupTouches(touches, rootsOf({ "/tmp/link/sub": { root: "/private/tmp/link", prefix: "sub/" } }));
  assert.deepEqual([...grouped.get("/private/tmp/link").files], ["sub/a.cs"]);
});

test("a read-only Bash hint never moves the baseline when the repo was also edited later", () => {
  const touches = createTouches();
  foldEvents(touches, [ev(5, [], [], ["/r/readme.md"]), ev(100, ["/r/a.cs"])]);
  const grouped = groupTouches(touches, rootsOf({ "/r": { root: "/r", prefix: "" } }));
  assert.equal(grouped.get("/r").firstTs, 100);
});

test("a repo only ever hinted at keeps the hint time and owns no files", () => {
  const touches = createTouches();
  foldEvents(touches, [ev(5, [], [], ["/r/readme.md"])]);
  const grouped = groupTouches(touches, rootsOf({ "/r": { root: "/r", prefix: "" } }));
  assert.equal(grouped.get("/r").firstTs, 5);
  assert.equal(grouped.get("/r").files.size, 0);
});

test("each repo gets its own window end", () => {
  const touches = createTouches();
  foldEvents(touches, [ev(10, ["/a/x"]), ev(900, ["/b/y"]), ev(20, ["/a/z"])]);
  const grouped = groupTouches(touches, rootsOf({ "/a": { root: "/a", prefix: "" }, "/b": { root: "/b", prefix: "" } }));
  assert.equal(grouped.get("/a").lastTs, 20);
  assert.equal(grouped.get("/b").lastTs, 900);
});
