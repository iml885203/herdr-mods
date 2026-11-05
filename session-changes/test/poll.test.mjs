import { test } from "node:test";
import assert from "node:assert/strict";
import { POLL_STEPS, createPacer } from "../mods/session-changes/poll.js";

const run = (pacer, now, grew) => { assert.ok(pacer.due(now)); pacer.started(now); pacer.settle(grew); };

test("the first firing is due, and the pace starts at the fastest step", () => {
  const pacer = createPacer();
  assert.equal(pacer.due(0), true);
  assert.equal(pacer.interval(), POLL_STEPS[0]);
});

test("a firing before the step has passed is not due, one after it is", () => {
  const pacer = createPacer({ steps: [5000, 15000], idleTicks: 1 });
  pacer.started(10000);
  assert.equal(pacer.due(12000), false);
  assert.equal(pacer.due(15000), true);
});

test("ticks with no growth back off through 5, 15 and 30 seconds, three at each step", () => {
  const pacer = createPacer();
  const seen = [];
  for (let i = 0; i < 8; i++) { seen.push(pacer.interval()); pacer.started(i); pacer.settle(false); }
  assert.deepEqual(seen, [5000, 5000, 5000, 15000, 15000, 15000, 30000, 30000]);
  assert.equal(pacer.interval(), 30000);
});

test("growth returns to the fastest step at once, and a manual refresh does too and is due immediately", () => {
  const pacer = createPacer({ idleTicks: 1 });
  for (let t = 0; t < 4; t++) run(pacer, t * 40000, false);
  assert.equal(pacer.interval(), 30000);
  pacer.settle(true);
  assert.equal(pacer.interval(), 5000);
  for (let t = 0; t < 4; t++) run(pacer, 200000 + t * 40000, false);
  pacer.started(400000);
  pacer.reset();
  assert.equal(pacer.interval(), 5000);
  assert.equal(pacer.due(400001), true);
});

test("a slow pace is due only at its own interval", () => {
  const pacer = createPacer({ idleTicks: 1 });
  run(pacer, 0, false);
  run(pacer, 15000, false);
  assert.equal(pacer.interval(), 30000);
  pacer.started(10000);
  assert.equal(pacer.due(25000), false);
  assert.equal(pacer.due(40000), true);
});
