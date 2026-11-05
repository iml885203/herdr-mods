import { test } from "node:test";
import assert from "node:assert/strict";
import { memoStart, makeAlive, dropIfDead } from "../mods/kubernetes/proxymemo.js";

const fakeFetch = (up) => async () => ({ ok: up(), json: async () => ({ gitVersion: "v1" }) });

test("memoStart shares one start and forgets only its own failure", async () => {
  const map = new Map();
  let starts = 0;
  const a = memoStart(map, "c", () => { starts++; return Promise.reject(new Error("x")); });
  assert.equal(memoStart(map, "c", () => { starts++; return Promise.resolve("never"); }), a);
  assert.equal(starts, 1);
  // a newer start replaces the map entry before the old one's rejection is handled
  const fresh = Promise.resolve("ok");
  map.set("c", fresh);
  await a.catch(() => {});
  await Promise.resolve();
  assert.equal(map.get("c"), fresh);
});

test("a failed start is forgotten so the next caller starts again", async () => {
  const map = new Map();
  await memoStart(map, "c", () => Promise.reject(new Error("x"))).catch(() => {});
  await Promise.resolve();
  assert.equal(map.has("c"), false);
});

test("dropIfDead keeps a proxy that still answers", async () => {
  const map = new Map(), p = Promise.resolve("b");
  map.set("c", p);
  assert.equal(await dropIfDead(map, "c", p, "http://x", makeAlive(fakeFetch(() => true))), false);
  assert.equal(map.get("c"), p);
});

test("dropIfDead drops a dead proxy once, and never a newer one", async () => {
  const map = new Map(), old = Promise.resolve("old"), fresh = Promise.resolve("new");
  map.set("c", old);
  assert.equal(await dropIfDead(map, "c", old, "http://x", makeAlive(fakeFetch(() => false))), true);
  assert.equal(map.has("c"), false);
  map.set("c", fresh); // another caller started a new one
  assert.equal(await dropIfDead(map, "c", old, "http://x", makeAlive(fakeFetch(() => false))), false);
  assert.equal(map.get("c"), fresh);
});

test("dropIfDead does not drop when another caller replaced it while checking", async () => {
  const map = new Map(), old = Promise.resolve("old"), fresh = Promise.resolve("new");
  map.set("c", old);
  const alive = async () => { map.set("c", fresh); return false; };
  assert.equal(await dropIfDead(map, "c", old, "http://x", alive), false);
  assert.equal(map.get("c"), fresh);
});

test("makeAlive is false when fetch throws", async () => {
  assert.equal(await makeAlive(async () => { throw new Error("refused"); })("http://x"), false);
});
