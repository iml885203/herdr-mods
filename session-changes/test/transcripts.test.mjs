import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscripts } from "../mods/session-changes/transcripts.js";
import { realIo } from "./fakeio.mjs";

const home = await mkdtemp(join(tmpdir(), "transcripts-"));
after(() => rm(home, { recursive: true, force: true }));
const projects = join(home, ".claude/projects");
const touch = async (...parts) => { const file = join(projects, ...parts); await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, "{}\n"); return file; };
const main = await touch("proj-a", "sid.jsonl");
await touch("proj-a", "other.jsonl");
const sub1 = await touch("proj-b", "sid", "subagents", "agent-1.jsonl");
const sub2 = await touch("proj-a", "sid", "subagents", "agent-2.jsonl");
await touch("proj-a", "other", "subagents", "agent-3.jsonl");
await touch("proj-a", "sid", "subagents", "notes.txt");
const transcripts = createTranscripts(realIo().exec, home, { ttl: 0 });

test("find returns the session's own file from whichever project folder holds it", async () => {
  assert.deepEqual(await transcripts.find("sid"), { file: main });
  assert.equal(await transcripts.find("missing"), null);
});

test("subagent transcripts are found under every project folder, and only this session's jsonl files", async () => {
  assert.deepEqual((await transcripts.subagents("sid")).sort(), [sub2, sub1].sort());
  assert.deepEqual(await transcripts.subagents("missing"), []);
});

test("the lookups are one shell call each, never a scan of the projects folder", async () => {
  const calls = [];
  const spy = createTranscripts(async (cmd, args) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "" }; }, "/home");
  await spy.find("sid");
  await spy.subagents("sid");
  assert.deepEqual(calls.map((c) => c.cmd), ["sh", "sh"]);
  assert.ok(calls.every((c) => !c.args[1].includes("find ")));
});

test("a failing shell means no transcripts, not a crash", async () => {
  const broken = createTranscripts(async () => { throw new Error("x"); }, "/home");
  assert.equal(await broken.find("sid"), null);
  assert.deepEqual(await broken.subagents("sid"), []);
});

test("the subagent list is kept for the ttl, and asked again when refresh is requested or the ttl has passed", async () => {
  let clock = 0, globs = 0;
  const exec = async () => { globs++; return { code: 0, stdout: `/f${globs}\n`, stderr: "" }; };
  const cached = createTranscripts(exec, "/home", { now: () => clock, ttl: 30000 });
  assert.deepEqual(await cached.subagents("sid"), ["/f1"]);
  clock = 29000;
  assert.deepEqual(await cached.subagents("sid"), ["/f1"]);
  assert.deepEqual(await cached.subagents("sid", { refresh: true }), ["/f2"]);
  clock = 58000;
  assert.deepEqual(await cached.subagents("sid"), ["/f2"]);
  clock = 60000;
  assert.deepEqual(await cached.subagents("sid"), ["/f3"]);
  assert.deepEqual(await cached.subagents("other"), ["/f4"]);
  assert.equal(globs, 4);
});
