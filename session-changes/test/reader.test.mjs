import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptReader } from "../mods/session-changes/reader.js";
import { editLine, realIo } from "./fakeio.mjs";

const dir = await mkdtemp(join(tmpdir(), "reader-"));
after(() => rm(dir, { recursive: true, force: true }));
let counter = 0;
const newFile = async (text = "") => { const file = join(dir, `t${counter++}.jsonl`); await writeFile(file, text); return file; };
const filesOf = (events) => events.flatMap((e) => e.files);
const noise = (n) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(n) }] } }) + "\n";
const { exec } = realIo();

test("a first poll reads every tool line, a second poll reads only what was appended", async () => {
  const file = await newFile(editLine("/r/a", "2026-11-04T10:00:00.000Z") + noise(50) + editLine("/r/b", "2026-11-04T10:00:01.000Z"));
  const reader = new TranscriptReader(exec);
  assert.deepEqual(filesOf((await reader.poll([file])).events), ["/r/a", "/r/b"]);
  await appendFile(file, editLine("/r/c", "2026-11-04T10:00:02.000Z"));
  assert.deepEqual(filesOf((await reader.poll([file])).events), ["/r/c"]);
  assert.deepEqual((await reader.poll([file])).events, []);
});

test("lines without a tool use are skipped by the shell, not shipped to the reader", async () => {
  const file = await newFile(noise(5000) + noise(5000) + editLine("/r/a", "2026-11-04T10:00:00.000Z"));
  const seen = [];
  const reader = new TranscriptReader(async (cmd, args, options) => { const r = await exec(cmd, args, options); seen.push(r.stdout.length); return r; });
  await reader.poll([file]);
  assert.ok(Math.max(...seen) < 1000, `largest output ${Math.max(...seen)}`);
  assert.equal(reader.offsetOf(file), (await import("node:fs")).statSync(file).size);
});

test("a chunk that ends mid-line, and mid-character, is picked up whole on the next read", async () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(i % 25 === 0 ? editLine(`/r/\u7e41\u9ad4\u6a94${i}.cs`, "2026-11-04T10:00:00.000Z") : noise(1100));
  const text = lines.join("");
  const wanted = lines.filter((l) => l.includes("tool_use")).length;
  const file = await newFile(text);
  for (const chunk of [65536 + 7, 70000, 100001, 131072 + 13]) {
    const reader = new TranscriptReader(exec, { chunk });
    const seen = [];
    for (let i = 0; i < 30; i++) {
      const result = await reader.poll([file], 1);
      seen.push(...filesOf(result.events));
      if (!reader.behind(file)) break;
    }
    assert.equal(seen.length, wanted, `chunk ${chunk}`);
    assert.ok(seen.every((f, i) => f === `/r/\u7e41\u9ad4\u6a94${i * 25}.cs`), `chunk ${chunk}`);
  }
});

test("the offset counts bytes, not characters, after multi-byte lines", async () => {
  const file = await newFile(editLine("/r/\u7e41", "2026-11-04T10:00:00.000Z") + editLine("/r/b", "2026-11-04T10:00:01.000Z"));
  const reader = new TranscriptReader(exec);
  await reader.poll([file]);
  assert.equal(reader.offsetOf(file), (await import("node:fs")).statSync(file).size);
});

test("an unfinished last line waits for its newline", async () => {
  const full = editLine("/r/a", "2026-11-04T10:00:00.000Z");
  const file = await newFile(full.slice(0, -10));
  const reader = new TranscriptReader(exec);
  assert.deepEqual((await reader.poll([file])).events, []);
  await writeFile(file, full);
  assert.deepEqual(filesOf((await reader.poll([file])).events), ["/r/a"]);
});

test("with no byte budget the reader catches up in one poll, with a budget it reports what is pending", async () => {
  const lines = Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? editLine(`/r/f${i}`, "2026-11-04T10:00:00.000Z") : noise(1000)));
  const file = await newFile(lines.join(""));
  const all = await new TranscriptReader(exec, { chunk: 70000 }).poll([file]);
  assert.equal(all.events.length, 20);
  assert.equal(all.pending, false);
  const some = await new TranscriptReader(exec, { chunk: 70000 }).poll([file], 100_000);
  assert.ok(some.events.length < 20 && some.pending);
});

test("a file that shrinks is read again from the start and the poll says so", async () => {
  const file = await newFile(editLine("/r/a", "2026-11-04T10:00:00.000Z") + editLine("/r/b", "2026-11-04T10:00:01.000Z"));
  const reader = new TranscriptReader(exec);
  await reader.poll([file]);
  await writeFile(file, editLine("/r/z", "2026-11-04T10:00:02.000Z"));
  const again = await reader.poll([file]);
  assert.equal(again.reset, true);
  assert.deepEqual(filesOf(again.events), ["/r/z"]);
  assert.equal((await reader.poll([file])).reset, false);
});

test("a line longer than a chunk is skipped whole, never cut in the middle", async () => {
  const file = await newFile(noise(200_000) + editLine("/r/after", "2026-11-04T10:00:00.000Z"));
  const reader = new TranscriptReader(exec, { chunk: 70000 });
  const seen = [];
  for (let i = 0; i < 40 && (i === 0 || reader.behind(file)); i++) seen.push(...filesOf((await reader.poll([file], 1)).events));
  assert.deepEqual(seen, ["/r/after"]);
});

test("a long line still being written is not skipped", async () => {
  const file = await newFile('{"type":"assistant","message":{"content":[{"type":"text","text":"' + "x".repeat(200_000));
  const reader = new TranscriptReader(exec, { chunk: 70000 });
  await reader.poll([file], 1);
  assert.equal(reader.offsetOf(file), 0);
});

test("a terminated line longer than a chunk that ends exactly at the end of the file is skipped, with a warning", async () => {
  const file = await newFile(noise(200_000));
  const reader = new TranscriptReader(exec, { chunk: 70000 });
  const first = await reader.poll([file], 1);
  assert.equal(reader.offsetOf(file), (await import("node:fs")).statSync(file).size);
  assert.equal(reader.behind(file), false);
  assert.deepEqual(first.skipped.map((s) => s.file), [file]);
  assert.ok(first.skipped[0].bytes > 200_000);
  assert.deepEqual((await reader.poll([file], 1)).skipped, []);
});

test("an oversize line is reported once, however many polls follow", async () => {
  const file = await newFile(noise(200_000) + editLine("/r/after", "2026-11-04T10:00:00.000Z"));
  const reader = new TranscriptReader(exec, { chunk: 70000 });
  const all = [];
  for (let i = 0; i < 20 && (i === 0 || reader.behind(file)); i++) all.push(...(await reader.poll([file], 1)).skipped);
  assert.equal(all.length, 1);
});

test("several files are read at the same time, never more than four at once", async () => {
  const files = [];
  for (let i = 0; i < 10; i++) files.push(await newFile(editLine(`/r/f${i}`, "2026-11-04T10:00:00.000Z")));
  let running = 0, peak = 0;
  const slow = async (cmd, args, options) => {
    if (cmd !== "sh" || !args[1].includes("dd ")) return exec(cmd, args, options);
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const result = await exec(cmd, args, options);
    running--;
    return result;
  };
  const result = await new TranscriptReader(slow).poll(files);
  assert.deepEqual(filesOf(result.events).sort(), files.map((_, i) => `/r/f${i}`).sort());
  assert.ok(peak > 1 && peak <= 4, `peak ${peak}`);
});

test("the byte budget stops new chunks, so a big backlog is read over several polls", async () => {
  const lines = Array.from({ length: 600 }, (_, i) => (i % 15 === 0 ? editLine(`/r/f${i}`, "2026-11-04T10:00:00.000Z") : noise(1000)));
  const file = await newFile(lines.join(""));
  const reader = new TranscriptReader(exec, { chunk: 70000 });
  const first = await reader.poll([file], 200_000);
  assert.equal(first.pending, true);
  assert.ok(first.events.length > 0 && first.events.length < 40, `${first.events.length}`);
  let seen = first.events.length;
  for (let i = 0; i < 20 && reader.behind(file); i++) seen += (await reader.poll([file], 200_000)).events.length;
  assert.equal(seen, 40);
});

test("progress is the share of bytes read", async () => {
  const file = await newFile(editLine("/r/a", "2026-11-04T10:00:00.000Z"));
  const reader = new TranscriptReader(exec);
  await reader.measure([file]);
  assert.equal(reader.progress(), 0);
  await reader.poll([file]);
  assert.equal(reader.progress(), 1);
});

test("when a later read throws, the events of the chunks already consumed are still returned, with the error", async () => {
  const first = editLine("/r/f1", "2026-11-04T10:00:00.000Z");
  const file = await newFile(first + noise(200_000) + editLine("/r/f2", "2026-11-04T10:00:01.000Z"));
  let reads = 0;
  const flaky = async (cmd, args, options) => {
    if (cmd === "sh" && args[1].includes("dd ") && ++reads === 2) throw new Error("disk went away");
    return exec(cmd, args, options);
  };
  const reader = new TranscriptReader(flaky, { chunk: 70000 });
  const result = await reader.poll([file]);
  assert.deepEqual(filesOf(result.events), ["/r/f1"]);
  assert.equal(result.error.message, "disk went away");
  assert.equal(reader.offsetOf(file), Buffer.byteLength(first));
  assert.deepEqual(filesOf((await reader.poll([file])).events), ["/r/f2"]);
});

test("total is the size of every measured file together", async () => {
  const exec = async () => ({ code: 0, stdout: "10 /a\n32 /b\n42 total\n", stderr: "" });
  const reader = new TranscriptReader(exec);
  assert.equal(reader.total(), 0);
  await reader.measure(["/a", "/b"]);
  assert.equal(reader.total(), 42);
});
