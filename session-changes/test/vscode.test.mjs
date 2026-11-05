import { test } from "node:test";
import assert from "node:assert/strict";
import { createVscode } from "../mods/session-changes/vscode.js";

const git = { baseVersionFile: async () => "/scratch/1/a.cs" };
const recorder = (reply = { code: 0, stdout: "", stderr: "" }) => {
  const calls = [];
  return { calls, exec: async (cmd, args) => { calls.push({ cmd, args }); return typeof reply === "function" ? reply(cmd) : reply; } };
};

test("hasCode is true only when which finds code", async () => {
  assert.equal(await createVscode(recorder().exec, git).hasCode(), true);
  assert.equal(await createVscode(recorder({ code: 1, stdout: "", stderr: "" }).exec, git).hasCode(), false);
  assert.equal(await createVscode(async () => { throw new Error("no which"); }, git).hasCode(), false);
});

test("openDiff compares the base copy with the working file", async () => {
  const r = recorder();
  assert.equal(await createVscode(r.exec, git).openDiff("/r", "abc", { path: "a.cs", status: "M" }), "");
  assert.deepEqual(r.calls[0], { cmd: "code", args: ["--diff", "/scratch/1/a.cs", "/r/a.cs"] });
});

test("a secret file is never copied to disk for a diff", async () => {
  let copied = false;
  const spy = { baseVersionFile: async () => { copied = true; return "/x"; } };
  const r = recorder();
  const message = await createVscode(r.exec, spy).openDiff("/r", "abc", { path: ".env", status: "M", secret: true });
  assert.ok(message.includes("Secret"));
  assert.equal(copied, false);
  assert.equal(r.calls.length, 0);
});

test("a deleted file just opens", async () => {
  const r = recorder();
  await createVscode(r.exec, git).openDiff("/r", "abc", { path: "gone.cs", status: "D" });
  assert.deepEqual(r.calls[0].args, ["/r/gone.cs"]);
});

test("a rejected or failing exec becomes a message, never a throw", async () => {
  const rejecting = createVscode(async () => { throw new Error("spawn code ENOENT"); }, git);
  assert.equal(await rejecting.openFile("/r", "a.cs"), "code failed: spawn code ENOENT");
  assert.equal(await rejecting.openDiff("/r", "abc", { path: "a.cs", status: "M" }), "code failed: spawn code ENOENT");
  const failing = createVscode(recorder({ code: 1, stdout: "", stderr: "bad\n" }).exec, git);
  assert.equal(await failing.openFile("/r", "a.cs"), "code failed: bad");
  const noBase = createVscode(recorder().exec, { baseVersionFile: async () => null });
  assert.equal(await noBase.openDiff("/r", "abc", { path: "a.cs", status: "M" }), "Could not read the base version");
});
