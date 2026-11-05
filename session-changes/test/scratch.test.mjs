import { test } from "node:test";
import assert from "node:assert/strict";
import { lazyScratchDir, makeScratchDir, removeScratchDir, withScratchDir } from "../mods/session-changes/scratch.js";

test("makeScratchDir returns the folder mktemp made", async () => {
  assert.equal(await makeScratchDir(async () => ({ code: 0, stdout: "/tmp/x\n", stderr: "" })), "/tmp/x");
});

test("makeScratchDir fails when mktemp fails or prints nothing", async () => {
  await assert.rejects(makeScratchDir(async () => ({ code: 1, stdout: "", stderr: "no" })), /scratch/);
  await assert.rejects(makeScratchDir(async () => ({ code: 0, stdout: "\n", stderr: "" })), /scratch/);
});

test("removeScratchDir never throws", async () => {
  await removeScratchDir(async () => { throw new Error("gone"); }, "/tmp/x");
});

const recorder = (fail = 0) => {
  const calls = [];
  let attempts = 0;
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "mktemp" && ++attempts <= fail) throw new Error("no space");
    return { code: 0, stdout: cmd === "mktemp" ? `/scratch/${attempts}\n` : "", stderr: "" };
  };
  return { exec, calls };
};

test("withScratchDir hands the work a folder and removes it afterwards, even when the work throws", async () => {
  const ok = recorder();
  assert.equal(await withScratchDir(ok.exec, async (dir) => `used ${dir}`), "used /scratch/1");
  assert.deepEqual(ok.calls.at(-1), ["rm", "-rf", "/scratch/1"]);
  const bad = recorder();
  await assert.rejects(withScratchDir(bad.exec, async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(bad.calls.at(-1), ["rm", "-rf", "/scratch/1"]);
});

test("lazyScratchDir makes one folder on first use, keeps it, and removes it on dispose", async () => {
  const r = recorder();
  const scratch = lazyScratchDir(r.exec);
  assert.equal(await scratch.dispose(), false);
  assert.equal(await scratch.get(), "/scratch/1");
  assert.equal(await scratch.get(), "/scratch/1");
  assert.equal(r.calls.filter((c) => c[0] === "mktemp").length, 1);
  assert.equal(await scratch.dispose(), true);
  assert.deepEqual(r.calls.at(-1), ["rm", "-rf", "/scratch/1"]);
});

test("lazyScratchDir forgets a failed attempt, so the next use tries again", async () => {
  const r = recorder(1);
  const scratch = lazyScratchDir(r.exec);
  await assert.rejects(scratch.get(), /no space/);
  assert.equal(await scratch.get(), "/scratch/2");
});
