import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkPlan, parseChunk, parseWc } from "../mods/session-changes/chunks.js";

test("parseChunk splits the kept lines from the consumed byte count the shell appended", () => {
  assert.deepEqual(parseChunk('{"a":1}\n{"b":2}\n\x01CONSUMED 120\n'), { text: '{"a":1}\n{"b":2}\n', consumed: 120 });
  assert.deepEqual(parseChunk("\x01CONSUMED 0\n"), { text: "", consumed: 0 });
});

test("parseChunk treats a missing or broken marker as nothing consumed", () => {
  assert.deepEqual(parseChunk(""), { text: "", consumed: 0 });
  assert.deepEqual(parseChunk("no marker here"), { text: "", consumed: 0 });
  assert.deepEqual(parseChunk("\x01CONSUMED nope\n"), { text: "", consumed: 0 });
});

test("parseWc reads byte counts per file and skips the total", () => {
  const out = "  120 /a/one.jsonl\n   7 /a/with space.jsonl\n  127 total\n";
  assert.deepEqual([...parseWc(out)], [["/a/one.jsonl", 120], ["/a/with space.jsonl", 7]]);
});

test("chunkPlan reads whole 64 KiB blocks, with the lead being the bytes of the first block that precede the offset", () => {
  assert.deepEqual(chunkPlan(0, 65536), { skip: 0, count: 2, lead: 0 });
  assert.deepEqual(chunkPlan(65536, 1000), { skip: 1, count: 1, lead: 0 });
  assert.deepEqual(chunkPlan(70000, 6_000_000), { skip: 1, count: 92, lead: 4464 });
});

test("a plan always covers the lead plus the wanted bytes", () => {
  for (const [offset, size] of [[0, 1], [1, 1], [65535, 10], [65536, 65536], [123456789, 6_000_000], [7, 6_000_000]]) {
    const { skip, count, lead } = chunkPlan(offset, size);
    assert.equal(skip * 65536 + lead, offset);
    assert.ok(count * 65536 >= lead + size, `${offset}/${size}`);
    assert.ok(lead < 65536);
  }
});
