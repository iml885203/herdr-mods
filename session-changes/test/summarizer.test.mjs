import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRepo } from "../mods/session-changes/summarizer.js";
import { changeShape, summaryKeyOf } from "../mods/session-changes/changekey.js";

const state = {
  root: "/r", baseline: "abc", probe: "probe-1", sig: "sig-1",
  snap: { head: "h1" },
  repo: { label: "payments", subjects: ["feat x"], files: [{ path: "a.cs", status: "M", added: 1, deleted: 0, owner: "session", fresh: false }, { path: ".env", status: "A", added: 1, deleted: 0, owner: "session", fresh: true, secret: true }] },
};
const git = { diffText: async (_root, _base, paths) => `diff --git a/${paths[0]} b/${paths[0]}\n@@ -1 +1 @@\n+ok\n`, readFreshMany: async (_root, paths) => paths.map(() => "SECRET=1") };

function setup(reply = { code: 0, stdout: '{"headline":"h","points":[]}', stderr: "" }) {
  const calls = [];
  const written = [];
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "mktemp") return { code: 0, stdout: "/scratch/dir\n", stderr: "" };
    return cmd === "sh" && args[1].includes("claude") ? reply : { code: 0, stdout: "", stderr: "" };
  };
  const prompts = { dir: "/priv", write: async (path, text) => { written.push({ path, text }); } };
  return { exec, calls, written, prompts, claude: () => calls.find((c) => c.cmd === "sh" && c.args[1].includes("claude")) };
}
const run = (s, over = {}) => summarizeRepo({ exec: s.exec, git, state, prompts: s.prompts, ...over });

test("a good reply becomes a summary keyed by the repo's change set", async () => {
  const s = setup({ code: 0, stdout: '{"headline":"Add","points":["a"]}', stderr: "" });
  const result = await run(s);
  assert.equal(result.summary.headline, "Add");
  assert.equal(result.summary.key, summaryKeyOf(state, "en"));
});

test("the key does not move with the repo's probe, so a touch or a checkout that changes no counts costs no summary", () => {
  assert.equal(summaryKeyOf(state), summaryKeyOf({ ...state, probe: "probe-2" }));
});

test("the key does not move when only the snapshot's time window did", () => {
  assert.equal(summaryKeyOf(state), summaryKeyOf({ ...state, sig: "probe-1|0|999|3" }));
});

test("the prompt travels on stdin from a file in a private folder, never in an argument list", async () => {
  const s = setup();
  await run(s);
  assert.equal(s.written.length, 1);
  assert.ok(s.written[0].path.startsWith("/priv/"));
  assert.ok(s.written[0].text.includes("Repo: payments"));
  for (const call of s.calls) for (const arg of call.args) assert.ok(!arg.includes("Repo: payments"), `${call.cmd} got the prompt`);
  assert.ok(s.claude().args[1].includes('< "$p"') || s.claude().args[1].includes("< \"$1\""));
  assert.equal(s.claude().args[3], s.written[0].path);
  const mkdir = s.calls.find((c) => c.cmd === "mkdir");
  assert.deepEqual(mkdir.args.slice(0, 3), ["-m", "700", "-p"]);
  assert.ok(s.calls.some((c) => c.cmd === "rm" && c.args.includes(s.written[0].path)));
});

test("only non-secret files reach the prompt, and claude runs without tools", async () => {
  const s = setup();
  await run(s);
  assert.ok(!s.written[0].text.includes(".env") && !s.written[0].text.includes("SECRET"));
  assert.deepEqual(s.claude().args.slice(-2), ["--tools", ""]);
});

test("claude runs isolated: no user settings or hooks, no MCP servers, no skills, in an empty scratch folder", async () => {
  const s = setup();
  await run(s);
  const { args, options } = s.claude();
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--disable-slash-commands") && args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(options.cwd, "/scratch/dir");
  assert.ok(s.calls.some((c) => c.cmd === "rm" && c.args.includes("/scratch/dir")));
});

test("a credential in a commit subject never reaches claude", async () => {
  const s = setup();
  await run(s, { state: { ...state, repo: { ...state.repo, subjects: ["fix: rotate DB_PASSWORD=hunter2"] } } });
  assert.ok(!s.written[0].text.includes("hunter2"));
});

test("a failing or unreadable reply is an error, and a rejection says timeout when it was one", async () => {
  assert.ok((await run(setup({ code: 1, stdout: "", stderr: "nope" }))).error.includes("nope"));
  assert.ok((await run(setup({ code: 0, stdout: "prose only", stderr: "" }))).error.startsWith("Summary failed"));
  const timing = setup();
  timing.exec = async (cmd, args) => { if (cmd === "sh" && args[1].includes("claude")) throw new Error("timed out"); return { code: 0, stdout: "/scratch/dir\n", stderr: "" }; };
  assert.equal((await run(timing)).error, "Summary timed out (30 s limit)");
});

test("the prompt file is removed even when claude fails", async () => {
  const s = setup({ code: 1, stdout: "", stderr: "boom" });
  await run(s);
  assert.ok(s.calls.some((c) => c.cmd === "rm" && c.args.includes(s.written[0].path)));
});

test("the summary is keyed by the repo as it was when the diff was read, even if the repo changes during the call", async () => {
  const s = setup();
  const live = { ...state, repo: { ...state.repo }, snap: { ...state.snap } };
  const before = summaryKeyOf(live);
  const reply = '{"headline":"h","points":[]}';
  const exec = async (cmd, args, options) => {
    if (cmd === "sh" && args[1].includes("claude")) { live.snap.head = "h2"; live.repo.files = []; return { code: 0, stdout: reply, stderr: "" }; }
    return cmd === "mktemp" ? { code: 0, stdout: "/scratch/dir\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  };
  const result = await summarizeRepo({ exec, git, state: live, prompts: s.prompts });
  assert.equal(result.summary.key, before);
  assert.notEqual(result.summary.key, summaryKeyOf(live));
});

test("the files list keeps its paths intact, such as an EF migration with a timestamp", async () => {
  const s = setup();
  const files = [...state.repo.files, { path: "Migrations/20261104123456_AddOtpIndexes.cs", status: "A", added: 30, deleted: 0, owner: "session", fresh: false }];
  await run(s, { state: { ...state, repo: { ...state.repo, files } } });
  assert.ok(s.written[0].text.includes("A Migrations/20261104123456_AddOtpIndexes.cs +30 -0"));
});

test("the diff part of the prompt is redacted once, in the context of its file, and not again as plain text", async () => {
  const s = setup();
  const code = { ...git, diffText: async () => "diff --git a/a.cs b/a.cs\n@@ -1 +1 @@\n+    Token = request.PlayerId,\n+var password = \"hunter2\";\n" };
  await summarizeRepo({ exec: s.exec, git: code, state, prompts: s.prompts });
  assert.ok(s.written[0].text.includes("+    Token = request.PlayerId,") && s.written[0].text.includes('var password = "‹v›";'));
});

test("a subject or a path that contains the diff marker cannot switch redaction off for what follows", async () => {
  const s = setup();
  const tricky = { ...state, repo: { ...state.repo, subjects: ["see <diff> then DB_PASSWORD=hunter2"], files: [{ path: "a/<diff>/DB_PASSWORD=hunter3.txt", status: "A", added: 1, deleted: 0, owner: "session", fresh: false }] } };
  await run(s, { state: tricky });
  assert.ok(!s.written[0].text.includes("hunter2") && !s.written[0].text.includes("hunter3"));
});

const systemOf = (call) => call.args[call.args.indexOf("--system-prompt") + 1];

test("the system prompt asks for an intent headline and concrete contract points, in English by default", async () => {
  const s = setup();
  await run(s);
  const system = systemOf(s.claude());
  assert.ok(system.includes("about 12 words") && system.includes("Add VIP rebate settlement endpoint") && system.includes("routes"));
  assert.ok(system.includes("2 to 5") && system.includes("Write in English"));
});

test("the language is a parameter and reaches the system prompt", async () => {
  for (const [language, needle] of [["zh-TW", "Traditional Chinese"], ["ja", "Japanese"]]) {
    const s = setup();
    await run(s, { language });
    assert.ok(systemOf(s.claude()).includes(needle), language);
    assert.ok(!systemOf(s.claude()).includes("Write in English"), language);
  }
});

test("the summary key carries the language", () => {
  assert.notEqual(summaryKeyOf(state, "zh-TW"), summaryKeyOf(state, "en"));
  assert.equal(summaryKeyOf(state, "en"), summaryKeyOf(state, "en"));
});

test("the model is a parameter and defaults to haiku", async () => {
  const s = setup();
  await run(s);
  assert.equal(s.claude().args[s.claude().args.indexOf("--model") + 1], "haiku");
  const t = setup();
  await run(t, { model: "sonnet" });
  assert.equal(t.claude().args[t.claude().args.indexOf("--model") + 1], "sonnet");
});

test("the stored summary remembers the change shape, the per-file counts and the language, for the tiny-change rule", async () => {
  const s = setup({ code: 0, stdout: '{"headline":"h","points":["a"]}', stderr: "" });
  const result = await run(s);
  assert.ok(result.summary.stats && typeof result.summary.stats === "object");
  assert.equal(result.summary.shape, changeShape(["feat x"], ["a.cs", ".env"]));
  assert.ok(result.summary.shape.length < 40);
  assert.equal(result.summary.lang, "en");
});

test("a failed git diff is an error and no summary is returned", async () => {
  const s = setup();
  const broken = { ...git, diffText: async () => { throw new Error("fatal: bad revision"); } };
  const result = await run(s, { git: broken });
  assert.ok(result.error && !result.summary);
});
