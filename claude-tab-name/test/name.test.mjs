// name.sh against a fake `claude`: what it sends, what it prints, how it fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NAME_SH = join(dirname(fileURLToPath(import.meta.url)), "../mods/claude-tab-name/name.sh");
const SID = "0123abcd-4567-89ef-0123-456789abcdef";

function setup({ reply = "<name>fix-login</name>", lines } = {}) {
  const home = mkdtempSync(join(tmpdir(), "name-sh-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, ".claude/projects/-tmp-x"), { recursive: true });
  const transcript = lines ?? [
    { type: "user", message: { content: "The login page loops after a bad password" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Found it: the retry resets the form." }] } },
    { type: "user", isMeta: true, message: { content: "meta line, left out" } },
  ];
  writeFileSync(join(home, `.claude/projects/-tmp-x/${SID}.jsonl`), transcript.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // The fake claude saves its arguments and its prompt, and answers `reply`.
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/args"\ncat > "${home}/prompt"\nprintf '%s' '${reply}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return { home, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } };
}
const run = (env, sid = SID) => spawnSync("sh", [NAME_SH, sid], { env, encoding: "utf8" });

test("prints the name from the reply", () => {
  const { home, env } = setup();
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "fix-login");
  const prompt = readFileSync(join(home, "prompt"), "utf8");
  assert.match(prompt, /USER: The login page loops/);
  assert.match(prompt, /ASSISTANT: Found it/);
  assert.doesNotMatch(prompt, /meta line/);
});

test("claude runs with no tools, no MCP and no saved session", () => {
  const { home, env } = setup();
  run(env);
  const args = readFileSync(join(home, "args"), "utf8").split("\n");
  for (const a of ["-p", "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config"]) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.equal(args[args.indexOf("--tools") + 1], "");
});

test("fails with a code for each reason", () => {
  assert.equal(run(setup().env, "ffffffff-0000").status, 2); // no transcript
  assert.equal(run(setup({ lines: [{ type: "summary", summary: "x" }] }).env).status, 3); // nothing said
  assert.equal(run(setup({ reply: "fix-login" }).env).status, 4); // no <name> tag
});

test("an empty <name> prints nothing; a failing claude fails the script", () => {
  const empty = run(setup({ reply: "<name></name>" }).env);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "");
  const { home, env } = setup();
  writeFileSync(join(home, "bin/claude"), "#!/bin/sh\necho boom >&2\nexit 7\n");
  assert.equal(run(env).status, 7);
});

test("system reminders are left out of what Claude reads", () => {
  const { home, env } = setup({ lines: [{ type: "user", message: { content: "fix the build <system-reminder>secret note</system-reminder> please" } }] });
  run(env);
  const prompt = readFileSync(join(home, "prompt"), "utf8");
  assert.match(prompt, /fix the build/);
  assert.doesNotMatch(prompt, /secret note/);
});
