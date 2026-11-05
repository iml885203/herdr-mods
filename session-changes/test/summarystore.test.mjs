import { test } from "node:test";
import assert from "node:assert/strict";
import { createSummaryStore } from "../mods/session-changes/summarystore.js";

const memoryStorage = () => {
  const map = new Map();
  return { map, reads: 0, getItem(k) { this.reads++; return map.get(k) ?? null; }, setItem(k, v) { map.set(k, v); }, removeItem(k) { map.delete(k); } };
};

test("a stored summary comes back, also through a second store on the same storage", () => {
  const storage = memoryStorage();
  const store = createSummaryStore(storage);
  store.set("s", "/r", { key: "k", headline: "h", points: [] });
  assert.equal(store.get("s", "/r").headline, "h");
  assert.equal(createSummaryStore(storage).get("s", "/r").headline, "h");
});

test("a summary written by one copy is seen by another copy that looked before and found nothing", () => {
  const storage = memoryStorage();
  const floating = createSummaryStore(storage), docked = createSummaryStore(storage);
  assert.equal(floating.get("s", "/r"), null);
  assert.equal(docked.get("s", "/r"), null);
  docked.set("s", "/r", { key: "k", headline: "new" });
  assert.equal(floating.get("s", "/r").headline, "new");
});

test("a copy sees the newer summary another copy wrote over an older one", () => {
  const storage = memoryStorage();
  const a = createSummaryStore(storage), b = createSummaryStore(storage);
  a.set("s", "/r", { key: "1", headline: "old" });
  assert.equal(b.get("s", "/r").headline, "old");
  a.set("s", "/r", { key: "2", headline: "newer" });
  assert.equal(b.get("s", "/r").headline, "newer");
});

test("the oldest summaries are evicted past the cap, from memory and storage", () => {
  const storage = memoryStorage();
  const store = createSummaryStore(storage, { cap: 2 });
  for (const root of ["/a", "/b", "/c"]) store.set("s", root, { key: root });
  assert.equal(store.get("s", "/a"), null);
  assert.equal(store.get("s", "/c").key, "/c");
  assert.equal(storage.getItem("session-changes.summary.s./a"), null);
  assert.equal([...storage.map.keys()].filter((k) => !k.endsWith("index")).length, 2);
});

test("a broken or full storage never throws", () => {
  const broken = { getItem() { throw new Error("no"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("no"); } };
  const store = createSummaryStore(broken);
  assert.equal(store.get("s", "/r"), null);
  store.set("s", "/r", { key: "k" });
  assert.equal(store.get("s", "/r"), null);
});

test("a slot is parsed once until its stored text changes, and a set serves the value it wrote without parsing", () => {
  const storage = memoryStorage();
  const store = createSummaryStore(storage);
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (text) => { parses++; return parse(text); };
  try {
    storage.setItem("session-changes.summary.s./r", JSON.stringify({ key: "1" }));
    const first = store.get("s", "/r");
    assert.equal(store.get("s", "/r"), first);
    assert.equal(parses, 1);
    store.set("s", "/r", { key: "2" });
    const before = parses;
    assert.equal(store.get("s", "/r").key, "2");
    assert.equal(parses - before, 0);
  } finally { JSON.parse = parse; }
});
