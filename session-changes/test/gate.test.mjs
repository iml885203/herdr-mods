import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate } from "../mods/session-changes/gate.js";

test("a gate never runs more jobs than its limit, however many wait", async () => {
  const gate = createGate(3);
  let running = 0, peak = 0;
  const job = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    return peak;
  };
  await Promise.all(Array.from({ length: 20 }, () => gate(job)));
  assert.equal(peak, 3);
  assert.equal(running, 0);
});

test("a failing job frees its slot", async () => {
  const gate = createGate(1);
  await assert.rejects(gate(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await gate(async () => "ok"), "ok");
});
