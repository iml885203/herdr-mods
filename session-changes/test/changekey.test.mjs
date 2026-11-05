import { test } from "node:test";
import assert from "node:assert/strict";
import { changeShape, changeStats, summaryKey, summaryKeyOf } from "../mods/session-changes/changekey.js";

const sizes = (entries) => new Map(Object.entries(entries).map(([path, size]) => [path, { size: String(size), mtime: "1" }]));

test("summaryKey moves when a file's status or counts move, not when file order does", () => {
  const a = { path: "a", status: "M", added: 1, deleted: 0 };
  const b = { path: "b", status: "A", added: null, deleted: 0 };
  assert.equal(summaryKey([], [a, b]), summaryKey([], [b, a]));
  assert.notEqual(summaryKey([], [a]), summaryKey([], [{ ...a, added: 2 }]));
  assert.notEqual(summaryKey([], [a]), summaryKey([], [{ ...a, status: "D" }]));
});

test("summaryKey follows the session's commit subjects, not HEAD: a commit that changes nothing in the prompt is free, a new or amended subject is not", () => {
  const files = [{ path: "a", status: "M", added: 1, deleted: 0 }];
  assert.equal(summaryKey(["feat x"], files), summaryKey(["feat x"], files));
  assert.notEqual(summaryKey(["feat x"], files), summaryKey(["feat x", "fix y"], files));
  assert.notEqual(summaryKey(["feat x"], files), summaryKey(["feat x!"], files));
  assert.notEqual(summaryKey([], files), summaryKey(["feat x"], files));
  assert.ok(summaryKey([], files).startsWith("v6|"));
});

test("summaryKey stays short however many files changed", () => {
  const files = Array.from({ length: 3000 }, (_, i) => ({ path: `src/some/long/folder/name/file${i}.cs`, status: "M", added: i, deleted: 1 }));
  const key = summaryKey(["s"], files);
  assert.ok(key.length < 80, `${key.length} chars`);
  assert.equal(key, summaryKey(["s"], [...files].reverse()));
  assert.notEqual(key, summaryKey(["s"], files.slice(1)));
});

test("summaryKey changes with the language, so another language never shows the old one's text", () => {
  const files = [{ path: "a", status: "M", added: 1, deleted: 0 }];
  assert.notEqual(summaryKey([], files, "zh-TW"), summaryKey([], files, "en"));
  assert.equal(summaryKey([], files, "en"), summaryKey([], files, "en"));
});

test("a file's size moves the key, tracked or untracked, and its modification time never does", () => {
  const fresh = [{ path: "new.txt", status: "A", fresh: true, added: null, deleted: 0 }];
  const tracked = [{ path: "a.cs", status: "M", added: 1, deleted: 1 }];
  const stats = (path, size, mtime) => new Map([[path, { size, mtime }]]);
  assert.notEqual(summaryKey([], fresh, "en", stats("new.txt", "10", "1")), summaryKey([], fresh, "en", stats("new.txt", "11", "1")));
  assert.equal(summaryKey([], fresh, "en", stats("new.txt", "10", "1")), summaryKey([], fresh, "en", stats("new.txt", "10", "2")));
  // same line counts, another line of the same count: only the size tells
  assert.notEqual(summaryKey([], tracked, "en", stats("a.cs", "100", "1")), summaryKey([], tracked, "en", stats("a.cs", "108", "1")));
  assert.equal(summaryKey([], tracked, "en", stats("a.cs", "100", "1")), summaryKey([], tracked, "en", stats("a.cs", "100", "9")));
});

test("a file with no stat (a committed file the session did not edit) is keyed by its counts alone", () => {
  const files = [{ path: "c.cs", status: "M", added: 1, deleted: 0 }];
  assert.equal(summaryKey([], files, "en", sizes({ other: 5 })), summaryKey([], files, "en", null));
});

test("summaryKeyOf reads the owned files, the commit subjects and the stats of a repo state", () => {
  const owned = { path: "a", status: "M", added: 1, deleted: 0, owner: "session" };
  const state = { snap: { head: "h" }, stats: sizes({ a: 7 }), repo: { subjects: ["s"], files: [owned, { path: "b", status: "M", added: 1, deleted: 0, owner: "other" }] } };
  assert.equal(summaryKeyOf(state, "en"), summaryKey(["s"], [{ path: "a", status: "M", added: 1, deleted: 0 }], "en", state.stats));
  assert.notEqual(summaryKeyOf(state, "en"), summaryKeyOf(state, "ja"));
  assert.equal(summaryKeyOf(state, "en"), summaryKeyOf({ ...state, snap: { head: "other" } }, "en"));
});

test("changeShape ignores file order and HEAD, follows the subjects; changeStats lists both sides per file", () => {
  assert.equal(changeShape(["s"], ["b", "a"]), changeShape(["s"], ["a", "b"]));
  assert.notEqual(changeShape(["s"], ["a"]), changeShape(["t"], ["a"]));
  assert.notEqual(changeShape(["s"], ["a"]), changeShape(["s"], ["a", "b"]));
  assert.deepEqual(changeStats([{ path: "a", added: 3, deleted: 1 }, { path: "b", added: null, deleted: 2 }]), { a: [3, 1], b: [0, 2] });
});

test("the key uses size, not git's blob id: a touch that zeroes the blob changes nothing; a size change marks stale", () => {
  const file = (blob) => [{ path: "a.cs", status: "M", added: 1, deleted: 1, ...(blob ? { blob } : {}) }];
  const same = sizes({ "a.cs": 100 });
  // With diff.autoRefreshIndex off a touched file reports an all-zero blob: the key must not flip.
  assert.equal(summaryKey([], file("a".repeat(40)), "en", same), summaryKey([], file(), "en", same));
  assert.equal(summaryKey([], file("a".repeat(40)), "en", same), summaryKey([], file("b".repeat(40)), "en", same));
  assert.notEqual(summaryKey([], file(), "en", sizes({ "a.cs": 100 })), summaryKey([], file(), "en", sizes({ "a.cs": 101 })));
});
