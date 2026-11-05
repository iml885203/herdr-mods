import { test } from "node:test";
import assert from "node:assert/strict";
import { STABLE_MS, createScheduler, isTinyChange } from "../mods/session-changes/scheduler.js";

const cand = (root, over = {}) => ({ root, probe: `p-${root}`, key: `k-${root}`, shape: `s-${root}`, stats: { f: [6, 4] }, previous: null, ...over });
const cached = (c, over = {}) => ({ ...c, previous: { key: c.key, shape: c.shape, stats: c.stats, ...over } });
const stale = (c) => ({ ...c, previous: { key: "old", shape: "other-shape", stats: { f: [60, 39] } } });
// A clock the tests move by hand: `at(ms)` is the time since the first tick.
const T0 = 1_000_000_000_000;
const at = (ms) => T0 + ms;
const roots = (result) => result.start.map((s) => s.root);

const S = STABLE_MS;
// The first tick after the window opens, then the repos have been unchanged for a full STABLE_MS.
const settled = (scheduler, list) => { scheduler.tick(list, at(0)); return scheduler.tick(list, at(S)); };

test("the first tick marks nothing settled: a repo with no cache waits STABLE_MS, in order, and a stale one too", () => {
  const scheduler = createScheduler();
  const list = [cand("a"), stale(cand("b"))];
  assert.deepEqual(roots(scheduler.tick(list, at(0))), []);
  assert.deepEqual(roots(scheduler.tick(list, at(S - 1))), []);
  assert.deepEqual(roots(scheduler.tick(list, at(S))), ["a", "b"]);
});

test("stability is time, not ticks: many ticks inside the window start nothing, one tick after it does", () => {
  const scheduler = createScheduler();
  for (let t = 0; t < S; t += 1000) assert.deepEqual(roots(scheduler.tick([cand("a")], at(t))), []);
  assert.deepEqual(roots(scheduler.tick([cand("a")], at(S))), ["a"]);
});

test("a session that has not touched the repo for STABLE_MS counts as settled at once, a recent touch does not", () => {
  const idle = createScheduler();
  assert.deepEqual(roots(idle.tick([cand("a", { lastTs: at(-S) })], at(0))), ["a"]);
  const busy = createScheduler();
  assert.deepEqual(roots(busy.tick([cand("a", { lastTs: at(-S + 1) })], at(0))), []);
  assert.deepEqual(roots(busy.tick([cand("a", { lastTs: at(-S + 1) })], at(1))), ["a"]);
});

test("when the window opens, repos whose cache still matches are not called, however long they stay", () => {
  const scheduler = createScheduler();
  const list = [cached(cand("a")), cached(cand("b"))];
  assert.deepEqual(roots(scheduler.tick(list, at(0))), []);
  assert.deepEqual(roots(scheduler.tick(list, at(S * 3))), []);
});

test("at most two run at once, and a freed slot is filled from the queue in repo order", () => {
  const scheduler = createScheduler();
  const list = [cand("a"), cand("b"), cand("c"), cand("d")];
  assert.deepEqual(roots(settled(scheduler, list)), ["a", "b"]);
  assert.deepEqual(roots(scheduler.tick(list, at(S + 1))), []);
  assert.deepEqual(roots(scheduler.done("b")), ["c"]);
  assert.deepEqual(roots(scheduler.done("a")), ["d"]);
});

test("a repo that appears later waits its own STABLE_MS from when it was first seen", () => {
  const scheduler = createScheduler();
  scheduler.tick([cached(cand("a"))], at(0));
  assert.deepEqual(roots(scheduler.tick([cached(cand("a")), cand("c")], at(S))), []);
  assert.deepEqual(roots(scheduler.tick([cached(cand("a")), cand("c")], at(S + S - 1))), []);
  assert.deepEqual(roots(scheduler.tick([cached(cand("a")), cand("c")], at(S + S))), ["c"]);
});

test("a change restarts the wait, and constant editing never starts", () => {
  const scheduler = createScheduler();
  scheduler.tick([cached(cand("a"))], at(0));
  for (let i = 1; i <= 6; i++) assert.deepEqual(roots(scheduler.tick([cand("a", { probe: `p${i}`, key: `k${i}` })], at(i * 10000))), [], `edit ${i}`);
  const last = { probe: "p6", key: "k6" };
  assert.deepEqual(roots(scheduler.tick([cand("a", last)], at(60000 + S - 1))), []);
  assert.deepEqual(roots(scheduler.tick([cand("a", last)], at(60000 + S))), ["a"]);
});

test("a repeated tick with the same probe does not move the clock, so extra ticks (a language switch) do not settle a repo early", () => {
  const scheduler = createScheduler();
  const list = [cand("a")];
  for (let t = 0; t < 10; t++) scheduler.tick(list, at(t));
  assert.deepEqual(roots(scheduler.tick(list, at(10))), []);
});

test("a newer change supersedes a queued repo that has not started yet", () => {
  const scheduler = createScheduler({ concurrency: 1 });
  assert.deepEqual(roots(settled(scheduler, [cand("a"), cand("b")])), ["a"]);
  assert.deepEqual(roots(scheduler.tick([cand("a"), cand("b", { probe: "p2", key: "k2" })], at(S + 1))), []);
  assert.deepEqual(roots(scheduler.done("a")), []);
  assert.deepEqual(roots(scheduler.tick([cand("a"), cand("b", { probe: "p2", key: "k2" })], at(S + 1 + S))), ["b"]);
});

test("a repo that is running is not started again, and its newer key waits for it to finish", () => {
  const scheduler = createScheduler();
  settled(scheduler, [cand("a")]);
  scheduler.tick([cand("a", { probe: "p2", key: "k2" })], at(S + 1));
  assert.deepEqual(roots(scheduler.tick([cand("a", { probe: "p2", key: "k2" })], at(S + 1 + S))), []);
  assert.deepEqual(roots(scheduler.done("a")), ["a"]);
});

test("a tiny change against the previous summary keeps the old headline and starts nothing", () => {
  const base = cand("a");
  const cases = [
    ["two lines more", { f: [7, 5] }, "s-a", []],
    ["two lines fewer", { f: [5, 3] }, "s-a", []],
    ["three lines more", { f: [8, 5] }, "s-a", ["a"]],
    ["another shape", { f: [7, 5] }, "other", ["a"]],
    ["same counts, other content", { f: [6, 4] }, "s-a", ["a"]],
    ["totals equal, but lines moved between files", { f: [10, 4], g: [0, 4] }, "s-a", ["a"]],
    ["no stats stored with the old summary", { f: [7, 5] }, "s-a", ["a"], true],
  ];
  for (const [name, stats, shape, starts, noOld] of cases) {
    const scheduler = createScheduler();
    const c = { ...base, key: "new", stats, shape, previous: { key: "old", shape: "s-a", ...(noOld ? {} : { stats: { f: [6, 4] } }) } };
    assert.deepEqual(roots(settled(scheduler, [c])), starts, name);
  }
});

test("a repo that was tried, ok or not, is not tried again until its key changes and settles", () => {
  const scheduler = createScheduler();
  settled(scheduler, [cand("a")]);
  scheduler.done("a");
  assert.deepEqual(roots(scheduler.tick([cand("a")], at(S * 2))), []);
  assert.deepEqual(roots(scheduler.tick([cand("a", { probe: "p2", key: "k2" })], at(S * 3))), []);
  assert.deepEqual(roots(scheduler.tick([cand("a", { probe: "p2", key: "k2" })], at(S * 4))), ["a"]);
});

test("a manual request skips the cache, the settle rule, the tiny rule and a recorded failure, and goes first", () => {
  const scheduler = createScheduler({ concurrency: 1 });
  const list = [cached(cand("a")), cached(cand("b"))];
  scheduler.tick(list, at(0));
  assert.deepEqual(roots(scheduler.manual("b", list)), ["b"]);
  scheduler.done("b");
  assert.deepEqual(roots(scheduler.manual("b", list)), ["b"]);
});

test("a manual request for a repo that is already running does nothing, and an unknown repo is ignored", () => {
  const scheduler = createScheduler();
  const list = [cand("a")];
  settled(scheduler, list);
  assert.deepEqual(roots(scheduler.manual("a", list)), []);
  assert.deepEqual(roots(scheduler.manual("zzz", list)), []);
});

test("after cancel nothing starts and late results are ignored", () => {
  const scheduler = createScheduler({ concurrency: 1 });
  settled(scheduler, [cand("a"), cand("b")]);
  scheduler.cancel();
  assert.deepEqual(roots(scheduler.done("a")), []);
  assert.deepEqual(roots(scheduler.tick([cand("a"), cand("b")], at(S * 2))), []);
  assert.deepEqual(roots(scheduler.manual("a", [cand("a")])), []);
});

test("the scheduler is idle only when nothing runs, nothing waits and every repo has settled", () => {
  const scheduler = createScheduler();
  scheduler.tick([cached(cand("a"))], at(0));
  assert.equal(scheduler.idle(), false);
  scheduler.tick([cached(cand("a"))], at(S));
  assert.equal(scheduler.idle(), true);
  scheduler.tick([cand("a", { probe: "p2", key: "k2" })], at(S + 1));
  assert.equal(scheduler.idle(), false);
  scheduler.tick([cand("a", { probe: "p2", key: "k2" })], at(S + 1 + S));
  assert.equal(scheduler.idle(), false);
  scheduler.done("a");
  assert.equal(scheduler.idle(), true);
});

test("a repo that disappears is forgotten, and comes back unsettled", () => {
  const scheduler = createScheduler();
  settled(scheduler, [cand("a")]);
  scheduler.done("a");
  scheduler.tick([], at(S + 1));
  assert.deepEqual(roots(scheduler.tick([cand("a")], at(S + 2))), []);
  assert.deepEqual(roots(scheduler.tick([cand("a")], at(S + 2 + S))), ["a"]);
});

test("isTinyChange needs the same shape and a small, non-zero per-file change", () => {
  const old = { shape: "s", stats: { f: [3, 2] } };
  assert.equal(isTinyChange(old, "s", { f: [4, 3] }), true);
  assert.equal(isTinyChange(old, "s", { f: [6, 2] }), false);
  assert.equal(isTinyChange(old, "s", { f: [3, 2] }), false);
  assert.equal(isTinyChange({ shape: "x", stats: old.stats }, "s", { f: [4, 2] }), false);
  assert.equal(isTinyChange(null, "s", { f: [4, 2] }), false);
  assert.equal(isTinyChange({ shape: "s" }, "s", { f: [4, 2] }), false);
});
