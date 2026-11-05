import { test } from "node:test";
import assert from "node:assert/strict";
import {
  levelOf, nextLevel, tokens, highlight, mergeRuns, lineParts, normTs, seenKey, fmtTime, newLog, restoreLines, resetLog,
  streamsOf, backoff, due, logQuery, mergeFresh, ingest, visibleLines, stepMatch, layout, indexAt,
  pick, pressPick, dragPick, releasePick, chosen, asText, MAX_LINES, LINE_H, errorOf,
} from "../mods/kubernetes/logs.js";

const T = { ansi1: "red", ansi2: "green", ansi3: "yellow", ansi4: "blue", ansi5: "magenta", ansi6: "cyan", dim: "dim", foreground: "fg" };
const COLORS = { err: "red", warn: "yellow", debug: "dim", info: "fg" };
const opts = (o = {}) => ({ t: T, themeKey: "x", q: "", cols: 80, wrap: true, colors: COLORS, ...o });
const stream = (pod, ctr = "app") => ({ pod, ctr, key: `${pod}/${ctr}`, empty: 0, next: 0 });
const ts = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000000000Z`;
const body = (...rows) => rows.map(([n, text]) => `${ts(n)} ${text}`).join("\n");

test("levelOf finds the level of a line", () => {
  assert.equal(levelOf("boom ERROR in x"), "err");
  assert.equal(levelOf("an Exception happened"), "err");
  assert.equal(levelOf('{"level":"warn","msg":"x"}'), "warn");
  assert.equal(levelOf("DEBUG cache miss"), "debug");
  assert.equal(levelOf("hello"), "info");
  assert.equal(nextLevel("all"), "warn");
  assert.equal(nextLevel("warn"), "err");
  assert.equal(nextLevel("err"), "all");
});

test("normTs pads the fraction so timestamps sort as text", () => {
  assert.equal(normTs("2026-01-01T00:00:05.12Z"), "2026-01-01T00:00:05.120000000Z");
  assert.equal(normTs("2026-01-01T00:00:05Z"), "2026-01-01T00:00:05.000000000Z");
  assert.ok(normTs("2026-01-01T00:00:05.9Z") > normTs("2026-01-01T00:00:05.12Z"));
  assert.match(fmtTime(ts(7)), /^\d\d:\d\d:07\.000$/);
  assert.equal(fmtTime("garbage"), "garbage");
});

test("tokens colours JSON, levels, urls and numbers, and keeps every character", () => {
  const text = '{"a": 12, "b": "x"} INFO https://x.io/p true';
  const segs = tokens(text, T);
  assert.equal(segs.map(([s]) => s).join(""), text);
  const colour = (s) => segs.find(([x]) => x === s)?.[1];
  assert.equal(colour('"a"'), "cyan");
  assert.equal(colour('"x"'), "yellow");
  assert.equal(colour("12"), "magenta");
  assert.equal(colour("INFO"), "green");
  assert.equal(colour("https://x.io/p"), "blue");
  assert.equal(colour("true"), "magenta");
});

test("highlight splits at matches and mergeRuns joins equal neighbours", () => {
  const hl = highlight([["foo bar foo", null]], "foo");
  assert.deepEqual(hl, [["foo", null, true], [" bar ", null, false], ["foo", null, true]]);
  assert.deepEqual(highlight([["a", "c"]], ""), [["a", "c", false]]);
  assert.deepEqual(mergeRuns([[":", null, false], [" ", null, false], ["x", "c", false], ["y", "c", true]]), [[": ", null, false], ["x", "c", false], ["y", "c", true]]);
});

test("lineParts caches per width, wrap, query and theme, and wraps long words", () => {
  const l = { text: 'ok "key": value ' + "x".repeat(30), level: "warn" };
  const a = lineParts(l, opts({ cols: 20 }));
  assert.equal(lineParts(l, opts({ cols: 20 })), a, "same key: the same array");
  assert.equal(a.map(([s]) => s).join("").replaceAll("\u00a0", " "), l.text);
  assert.ok(a.every(([s]) => s.replaceAll("\u00a0", " ").length <= 18 || s.trim().length <= 18), "no piece is wider than a line");
  assert.equal(a[0][1], "yellow", "plain text takes the level colour");
  const b = lineParts(l, opts({ cols: 20, q: "key" }));
  assert.notEqual(b, a);
  assert.ok(b.some(([s, , hl]) => hl && s.includes("key")));
  assert.notEqual(lineParts(l, opts({ cols: 40 })), b);
  const nowrap = lineParts(l, opts({ wrap: false }));
  assert.ok(nowrap.length < a.length + 5);
  assert.ok(!a.some(([s]) => s.includes(" ")), "spaces are non-breaking inside a piece");
});

test("newLog carries the toolbar choices and starts empty", () => {
  const L = newLog({ ctx: "c", ns: "n", name: "p", kind: "pods" }, { gen: 4, since: "1h", ts: false, wrap: false }, { level: "err" });
  assert.equal(L.gen, 5);
  assert.equal(L.since, "1h");
  assert.equal(L.ts, false);
  assert.equal(L.level, "err");
  assert.equal(L.lines.length, 0);
  assert.equal(L.picked.size, 0);
  const fresh = newLog({ ctx: "c", ns: "n", name: "p", kind: "pods" }, null, {});
  assert.deepEqual([fresh.since, fresh.ts, fresh.wrap, fresh.level, fresh.follow], ["tail", true, true, "all", true]);
});

test("ingest adds lines in time order, drops duplicates, tracks cursor and pods", () => {
  const L = newLog({ kind: "pods" });
  const s1 = stream("a-1"), s2 = stream("b-2");
  assert.equal(ingest(L, [[s1, body([3, "three"], [1, "one"])], [s2, body([2, "two ERROR"])]]), true);
  assert.deepEqual(L.lines.map((l) => l.text), ["one", "two ERROR", "three"]);
  assert.equal(L.lines[1].level, "err");
  assert.match(L.lines[0].time, /^\d\d:\d\d:01\.000$/);
  assert.equal(L.cursor["a-1/app"], ts(3));
  assert.deepEqual(Object.keys(L.pods), ["a-1", "b-2"]);
  const v = L.version;
  assert.equal(ingest(L, [[s1, body([3, "three"])]]), false, "an overlapping poll adds nothing");
  assert.equal(L.version, v);
  assert.equal(L.pods["a-1"].n, 2);
});

test("ingest strips colour codes before the dedupe key", () => {
  const L = newLog({ kind: "pods" });
  const s = stream("a");
  ingest(L, [[s, body([1, "\x1b[31mred\x1b[0m text"])]]);
  assert.equal(L.lines[0].text, "red text");
  assert.equal(ingest(L, [[s, body([1, "\x1b[31mred\x1b[0m text"])]]), false);
});

test("ingest merges a late line into the middle without disturbing the rest", () => {
  const L = newLog({ kind: "pods" });
  const s1 = stream("a"), s2 = stream("b");
  ingest(L, [[s1, body([1, "a1"], [5, "a5"], [9, "a9"])]]);
  ingest(L, [[s2, body([4, "b4"], [6, "b6"], [10, "b10"])]]);
  assert.deepEqual(L.lines.map((l) => l.text), ["a1", "b4", "a5", "b6", "a9", "b10"]);
  assert.ok(L.lines.every((l, i) => i === 0 || L.lines[i - 1].ts <= l.ts));
});

test("mergeFresh keeps equal timestamps with the existing line first, and appends when all is later", () => {
  const mk = (t, id) => ({ ts: ts(t), id });
  const lines = [mk(1, "x1"), mk(2, "x2"), mk(3, "x3")];
  mergeFresh(lines, [mk(2, "f2"), mk(4, "f4")]);
  assert.deepEqual(lines.map((l) => l.id), ["x1", "x2", "f2", "x3", "f4"]);
  const more = [mk(1, "a")];
  mergeFresh(more, [mk(1, "b"), mk(2, "c")]);
  assert.deepEqual(more.map((l) => l.id), ["a", "b", "c"]);
  const none = [];
  mergeFresh(none, [mk(5, "z")]);
  assert.equal(none.length, 1);
});

test("ingest keeps the newest MAX_LINES and forgets the dropped ones for dedupe (the floor keeps them out); dropped lines get no time/level", () => {
  const L = newLog({ kind: "pods" });
  const s = stream("a");
  const rows = [];
  for (let i = 0; i < MAX_LINES + 50; i++) rows.push(`2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000000000Z m${i}`);
  ingest(L, [[s, rows.join("\n")]]);
  assert.equal(L.lines.length, MAX_LINES);
  assert.equal(L.lines[0].text, "m50");
  assert.equal(L.seen.size, MAX_LINES);
  assert.ok(L.lines.every((l) => l.level && l.time));
  // line 0 was dropped: it is at or before the floor, so it does not come back as new
  assert.equal(ingest(L, [[s, rows[0]]]), false);
  assert.equal(L.lines.length, MAX_LINES);
});

test("streams back off while empty and reset when lines arrive", () => {
  assert.equal(backoff(0), 0);
  assert.ok(backoff(1) >= 1500 && backoff(1) < 2000);
  assert.ok(backoff(2) >= 3500 && backoff(2) < 4000);
  assert.ok(backoff(3) >= 7500 && backoff(3) < 8000);
  assert.equal(backoff(9), backoff(3));
  const L = newLog({ kind: "pods" });
  const s = stream("a");
  const t0 = 1_000_000;
  ingest(L, [[s, body([1, "x"])]], t0);
  assert.equal(s.empty, 0);
  assert.ok(due(s, t0 + 1));
  ingest(L, [[s, ""]], t0);
  assert.equal(s.empty, 1);
  assert.ok(!due(s, t0 + 1000));
  assert.ok(due(s, t0 + 2000));
  ingest(L, [[s, ""]], t0 + 2000);
  ingest(L, [[s, ""]], t0 + 6000);
  ingest(L, [[s, ""]], t0 + 14000);
  assert.equal(s.empty, 4);
  assert.ok(!due(s, t0 + 14000 + 7000));
  assert.ok(due(s, t0 + 14000 + 8000));
  ingest(L, [[s, body([2, "new"])]], t0 + 30000);
  assert.deepEqual([s.empty, s.next], [0, 0]);
});

test("a re-listed pod keeps its stream's backoff", () => {
  const pods = [{ metadata: { name: "p" }, spec: { containers: [{ name: "a" }, { name: "b" }] } }];
  const first = streamsOf(pods);
  assert.deepEqual(first.map((s) => s.key), ["p/a", "p/b"]);
  first[0].empty = 3; first[0].next = 99;
  const again = streamsOf(pods, first);
  assert.equal(again[0], first[0]);
  assert.equal(again[0].empty, 3);
  assert.equal(streamsOf([], first).length, 0);
});

test("logQuery caps the first read at about MAX_LINES / streams", () => {
  const L = newLog({ kind: "deploy", since: "1h" });
  const s = stream("a");
  assert.equal(logQuery(L, s, 1), "container=app&timestamps=true&sinceSeconds=3600&tailLines=3000");
  assert.match(logQuery(L, s, 30), /tailLines=1000$/);
  assert.match(logQuery(L, s, 1000), /tailLines=200$/);
  L.since = "tail";
  assert.match(logQuery(L, s, 1), /tailLines=500$/);
  assert.match(logQuery(L, s, 300), /tailLines=200$/);
  L.cursor[s.key] = ts(5);
  assert.match(logQuery(L, s, 30), /sinceTime=2026-01-01T00%3A00%3A05\.000000000Z$/);
  L.previous = true;
  assert.match(logQuery(L, s, 30), /previous=true/);
});

function logWith(texts) {
  const L = newLog({ kind: "deploy" });
  texts.forEach(([pod, n, text]) => ingest(L, [[stream(pod), body([n, text])]]));
  return L;
}

test("visibleLines filters by pod, level and search, finds matches, and caches", () => {
  const L = logWith([["a", 1, "hello world"], ["b", 2, "WARN careful"], ["a", 3, "ERROR boom hello"], ["b", 4, "bye"]]);
  const all = visibleLines(L);
  assert.equal(all.lines.length, 4);
  assert.equal(visibleLines(L), all, "cached while nothing changed");
  L.hidden.add("a");
  assert.deepEqual(visibleLines(L).lines.map((l) => l.text), ["WARN careful", "bye"]);
  L.hidden.clear();
  L.level = "warn";
  assert.deepEqual(visibleLines(L).lines.map((l) => l.text), ["WARN careful", "ERROR boom hello"]);
  L.level = "err";
  assert.equal(visibleLines(L).lines.length, 1);
  L.level = "all"; L.q = "HELLO";
  const m = visibleLines(L);
  assert.equal(m.lines.length, 4);
  assert.deepEqual(m.matches, [0, 2]);
  L.filterOnly = true;
  const only = visibleLines(L);
  assert.deepEqual(only.lines.map((l) => l.text), ["hello world", "ERROR boom hello"]);
  assert.deepEqual(only.matches, []);
  ingest(L, [[stream("a"), body([9, "hello again"])]]);
  assert.equal(visibleLines(L).lines.length, 3, "new lines invalidate the cache");
});

test("stepMatch walks through the matches and wraps around", () => {
  const L = { match: -1 };
  assert.equal(stepMatch(L, [], 1), -1);
  assert.equal(stepMatch(L, [3, 7, 9], 1), 3);
  assert.equal(stepMatch(L, [3, 7, 9], 1), 7);
  assert.equal(stepMatch(L, [3, 7, 9], -1), 3);
  assert.equal(stepMatch(L, [3, 7, 9], -1), 9);
  L.match = -1;
  assert.equal(stepMatch(L, [3, 7, 9], -1), 9);
});

test("layout and indexAt: heights follow wrap, lookups find the row under y", () => {
  const L = newLog({ kind: "pods" });
  const lines = [{ text: "short" }, { text: "x".repeat(200) }, { text: "" }];
  const flat = layout(L, lines, "k", 50, false, 100);
  assert.deepEqual(flat.heights, [LINE_H + 2, LINE_H + 2, LINE_H + 2]);
  const wrapped = layout(L, lines, "k", 50, true, 100);
  assert.deepEqual(wrapped.heights, [LINE_H + 2, 5 * LINE_H + 2, LINE_H + 2]);
  assert.equal(wrapped.total, wrapped.tops[3]);
  assert.equal(wrapped.maxTop, wrapped.total - 100);
  assert.equal(layout(L, lines, "k", 50, true, 100).tops, wrapped.tops, "kept while key, width and wrap hold");
  assert.equal(layout(L, [], "k2", 50, true, 100).maxTop, 0);
  assert.equal(indexAt(wrapped, 0), 0);
  assert.equal(indexAt(wrapped, 21), 0);
  assert.equal(indexAt(wrapped, 22), 1);
  assert.equal(indexAt(wrapped, 10000), 2);
  assert.equal(indexAt(null, 5), -1);
});

test("pick: click, shift-click ranges, cmd-click adds, a second click unpicks", () => {
  const L = newLog({ kind: "pods" });
  const lines = ["a", "b", "c", "d", "e"].map((text) => ({ text }));
  pick(L, 1, {}, lines);
  assert.deepEqual([...L.picked].map((l) => l.text), ["b"]);
  pick(L, 1, {}, lines);
  assert.equal(L.picked.size, 0);
  pick(L, 1, {}, lines);
  pick(L, 3, { shift: true }, lines);
  assert.deepEqual([...L.picked].map((l) => l.text), ["b", "c", "d"]);
  pick(L, 4, { platform: true }, lines);
  assert.equal(L.picked.size, 4);
  pick(L, 2, { control: true }, lines);
  assert.deepEqual([...L.picked].map((l) => l.text).sort(), ["b", "d", "e"]);
  pick(L, 99, {}, lines);
  assert.equal(L.picked.size, 3, "an index outside the lines does nothing");
});

test("drag picks a range; a plain click on the only picked line unpicks on release", () => {
  const L = newLog({ kind: "pods" });
  const lines = ["a", "b", "c", "d"].map((text) => ({ text }));
  let drag = pressPick(L, 1, lines);
  dragPick(L, drag, 3, lines);
  assert.deepEqual([...L.picked].map((l) => l.text), ["b", "c", "d"]);
  dragPick(L, drag, 0, lines);
  assert.deepEqual([...L.picked].map((l) => l.text), ["a", "b"]);
  releasePick(L, drag);
  assert.equal(L.picked.size, 2);
  L.picked = new Set([lines[2]]);
  drag = pressPick(L, 2, lines);
  releasePick(L, drag);
  assert.equal(L.picked.size, 0);
  drag = pressPick(L, 2, lines);
  releasePick(L, drag);
  assert.equal(L.picked.size, 1, "the first click picks it");
  releasePick(L, null);
});

test("chosen is the picked lines, else all shown; asText is one line each", () => {
  const L = newLog({ kind: "pods" });
  const lines = [{ ts: "t1", pod: "p", ctr: "c", text: "x" }, { ts: "t2", pod: "p", ctr: "c", text: "y" }];
  assert.equal(chosen(L, lines), lines);
  L.picked = new Set([lines[1]]);
  assert.deepEqual(chosen(L, lines), [lines[1]]);
  assert.equal(asText(lines), "t1 p/c x\nt2 p/c y");
});

test("restoreLines shows kept lines, normalises their time stamps and dedupes against them", () => {
  const L = newLog({ kind: "pods" });
  const s = stream("a");
  restoreLines(L, { lines: [{ pod: "a", ctr: "app", key: "a/app", ts: "2026-01-01T00:00:01.5Z", text: "kept", time: "t", level: "info" }], cursor: { "a/app": ts(1) }, pods: { a: { color: "c", n: 1 } } });
  assert.equal(L.lines[0].ts, "2026-01-01T00:00:01.500000000Z");
  assert.equal(L.loaded, true);
  assert.equal(ingest(L, [[s, "2026-01-01T00:00:01.5Z kept"]]), false);
  resetLog(L);
  assert.deepEqual([L.lines.length, L.loaded, L.streams, L.gen], [0, false, null, 2]);
});

test("seenKey tells apart lines of different streams and times", () => {
  const a = { key: "p/a", ts: "t", text: "x" };
  assert.notEqual(seenKey(a), seenKey({ ...a, key: "p/b" }));
  assert.notEqual(seenKey(a), seenKey({ ...a, ts: "u" }));
});

// ------------------------------------------------------------------ eviction floor, pods, errors
const msTs = (i) => new Date(Date.UTC(2026, 0, 1) + i).toISOString().replace("Z", "000000Z");

test("lines evicted by MAX_LINES do not return on the next poll, and a quiet stream keeps backing off", () => {
  const L = newLog({ ctx: "c", ns: "n", name: "x", kind: "deploy", selector: "a=b" });
  const quiet = stream("q"), busy = stream("b");
  assert.equal(ingest(L, [[quiet, `${msTs(0)} boundary`]], 0), true);
  const rows = [];
  for (let i = 1; i <= MAX_LINES + 5; i++) rows.push(`${msTs(i)} b${i}`);
  ingest(L, [[busy, rows.join("\n")]], 0);
  assert.equal(L.lines.length, MAX_LINES);
  assert.ok(L.floor >= msTs(0), "floor covers the evicted quiet line");
  assert.equal(L.lines.some((l) => l.pod === "q"), false);
  const before = L.version;
  quiet.empty = 1;
  assert.equal(ingest(L, [[quiet, `${msTs(0)} boundary`]], 1000), false); // sinceTime is inclusive: same line again
  assert.equal(L.version, before);
  assert.equal(quiet.empty, 2);
  assert.ok(quiet.next > 1000);
  assert.equal(L.pods.q.n, 0);
  assert.equal(L.pods.b.n, MAX_LINES);
});

test("resetLog clears chips, counts and the eviction floor", () => {
  const L = newLog({});
  ingest(L, [[stream("p"), body([1, "a"])]]);
  L.hidden.add("p"); L.floor = "x"; L.errs.set("k", "e");
  resetLog(L);
  assert.deepEqual(L.pods, {});
  assert.equal(L.hidden.size, 0);
  assert.equal(L.floor, "");
  assert.equal(L.errs.size, 0);
});

test("restoreLines counts pods from the lines kept", () => {
  const L = newLog({});
  restoreLines(L, { lines: [{ pod: "p", ctr: "app", key: "p/app", ts: ts(1), text: "a" }], pods: { p: { color: "red", n: 99 }, gone: { color: "x", n: 5 } } });
  assert.deepEqual(L.pods, { p: { color: "red", n: 1 } });
});

test("newLog keeps previous, errorOf summarises stream errors", () => {
  const L = newLog({ previous: true });
  assert.equal(L.previous, true);
  assert.equal(errorOf(L), null);
  L.errs.set("a", "a: boom"); L.errs.set("b", "b: bang");
  assert.equal(errorOf(L), "a: boom  (+1 more)");
  L.errs.clear(); L.streams = [];
  assert.equal(errorOf(L), "no pods match this selector");
});

test("a quiet stream wholly below the eviction floor still gets a cursor, so logQuery uses sinceTime", () => {
  const L = newLog({ ctx: "c", ns: "n", name: "x", kind: "deploy", selector: "a=b", since: "5m" });
  const quiet = stream("q"), busy = stream("b");
  L.floor = msTs(1000);
  assert.equal(ingest(L, [[quiet, `${msTs(1)} old\n${msTs(5)} older`]], 0), false);
  assert.equal(L.cursor[quiet.key], msTs(5));
  assert.match(logQuery(L, quiet, 2), /sinceTime=/);
  assert.doesNotMatch(logQuery(L, quiet, 2), /sinceSeconds|tailLines/);
  assert.match(logQuery(L, busy, 2), /sinceSeconds/); // an unread stream still starts from the range
});
