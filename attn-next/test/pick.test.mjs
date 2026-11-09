import assert from "node:assert/strict";
import { sortAgents, initialIndex, move } from "../mods/attn-next/pick.js";
const a = (address, status, seq, focused = false) => ({ address, status, seq, focused });
const ids = (l) => sortAgents(l).map((x) => x.address);
// need order: blocked, done, working, idle; agents() order inside a group (not seq)
assert.deepEqual(ids([a("i", "idle", 1), a("w", "working", 2), a("d2", "done", 5), a("b2", "blocked", 7), a("d1", "done", 3), a("b1", "blocked", 4)]),
  ["b2", "b1", "d2", "d1", "w", "i"]);
// nothing needs me: agents() order as is (the sidebar's, what cmd-] walks), idle before working too
assert.deepEqual(ids([a("x", "working", 9), a("y", "idle", 1), a("z", "idle", 2)]), ["x", "y", "z"]);
assert.deepEqual(ids([a("i", "idle", 1), a("w", "working", 2)]), ["i", "w"]);
assert.deepEqual(ids([a("u", "unknown", 1), a("i", "idle", 2)]), ["u", "i"]);
// input not mutated
const src = [a("i", "idle", 1), a("b", "blocked", 2)];
sortAgents(src);
assert.equal(src[0].address, "i");
// something needs me: first row
assert.equal(initialIndex([a("w", "working", 1), a("b", "blocked", 2), a("d", "done", 3)]), 0);
// ...unless the first row is the focused one: second
assert.equal(initialIndex([a("w", "working", 1), a("b", "blocked", 2, true), a("d", "done", 3)]), 1);
// focus elsewhere: still first
assert.equal(initialIndex([a("w", "working", 1, true), a("b", "blocked", 2)]), 0);
// only one row
assert.equal(initialIndex([a("b", "blocked", 1, true)]), 0);
assert.equal(initialIndex([]), 0);
// nothing blocked/done: the agent after the focused one in agents() order, mapped to its row
const q = [a("x", "idle", 9), a("y", "working", 1, true), a("z", "idle", 2)];
assert.equal(sortAgents(q)[initialIndex(q)].address, "z");
// wraps from the last in agents() order
const q2 = [a("x", "idle", 9), a("y", "working", 1), a("z", "idle", 2, true)];
assert.equal(sortAgents(q2)[initialIndex(q2)].address, "x");
// no focused agent: agents()[0]
const q3 = [a("x", "idle", 9), a("y", "working", 1)];
assert.equal(sortAgents(q3)[initialIndex(q3)].address, "x");
// move wraps both ways
assert.equal(move(0, 1, 3), 1);
assert.equal(move(2, 1, 3), 0);
assert.equal(move(0, -1, 3), 2);
assert.equal(move(0, 1, 0), 0);
console.log("ok");
