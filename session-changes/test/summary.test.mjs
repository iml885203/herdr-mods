import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSummary, summaryError, summaryFailure, summaryPrompt, summarySystem, trimDiff } from "../mods/session-changes/summary.js";
import { cleanText } from "../mods/session-changes/text.js";
import { unquotePath } from "../mods/session-changes/diffpath.js";
import { languageRule } from "../mods/session-changes/languages.js";
import { overviewSystem } from "../mods/session-changes/overview.js";

test("parseSummary finds the JSON in surrounding prose and cleans control characters", () => {
  const out = parseSummary('Here:\n{"headline":"Add\\u001b[31mrate","points":["a","","b","c","d"]}\nthanks');
  assert.equal(out.headline, "Add [31mrate");
  assert.deepEqual(out.points, ["a", "b", "c", "d"]);
});

test("parseSummary rejects replies without a usable headline", () => {
  assert.equal(parseSummary("no json"), undefined);
  assert.equal(parseSummary('{"headline":"  ","points":[]}'), undefined);
  assert.equal(parseSummary('{"headline": 3}'), undefined);
  assert.equal(parseSummary("{broken"), undefined);
});

test("cleanText flattens whitespace and truncates with an ellipsis", () => {
  assert.equal(cleanText("a\n\n b", 10), "a b");
  assert.equal(cleanText("abcdef", 4), "abc…");
});

test("trimDiff drops noise and secret files, then truncates", () => {
  const diff = ["diff --git a/src/a.cs b/src/a.cs\n+keep\n", "diff --git a/package-lock.json b/package-lock.json\n+lock\n", "diff --git a/.env b/.env\n+SECRET=1\n"].join("");
  const out = trimDiff(diff, 1000);
  assert.ok(out.includes("+keep") && !out.includes("lock") && !out.includes("SECRET"));
  assert.ok(trimDiff("x".repeat(50), 10).endsWith("… (diff truncated)"));
});

test("summaryPrompt lists files without secrets and says when nothing is committed", () => {
  const prompt = summaryPrompt({
    name: "payments", subjects: [], diff: "+x",
    files: [{ path: "a.cs", status: "M", added: 1, deleted: 0 }, { path: ".env", status: "A", added: 1, deleted: 0 }],
  });
  assert.ok(prompt.includes("M a.cs +1 -0") && !prompt.includes(".env"));
  assert.ok(prompt.includes("No commits yet"));
  assert.ok(prompt.includes("<diff>\n+x\n</diff>"));
});

const section = (path, body) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

test("trimDiff reads paths with spaces and drops secret files whole", () => {
  const diff = section("my dir/.env", "@@ -1 +1 @@\n+X=1\n") + section("my dir/a b.cs", "@@ -1 +1 @@\n+keep\n");
  const out = trimDiff(diff, 5000);
  assert.ok(out.includes("+keep") && !out.includes("X=1"));
});

test("trimDiff redacts values before it truncates", () => {
  const out = trimDiff(section("app.ini", "@@ -1 +1 @@\n+token = abc123\n"), 5000);
  assert.ok(!out.includes("abc123") && out.includes("token ="));
});

test("summaryFailure says what claude printed, or that it may have hit the time limit", () => {
  assert.equal(summaryFailure({ code: 1, stdout: "", stderr: "boom\n" }), "Summary failed: boom");
  assert.ok(summaryFailure({ code: 1, stdout: "", stderr: "" }).includes("30 s"));
});

test("summaryError tells a timeout from any other rejection", () => {
  assert.equal(summaryError(new Error("command timed out after 30s")), "Summary timed out (30 s limit)");
  assert.equal(summaryError(new Error("spawn claude ENOENT")), "Summary failed: spawn claude ENOENT");
});

test("summaryPrompt caps the file list", () => {
  const files = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}.cs`, status: "M", added: 1, deleted: 0 }));
  const prompt = summaryPrompt({ name: "r", subjects: [], files, diff: "" });
  assert.ok(prompt.includes("f0.cs") && !prompt.includes("f499.cs"));
});

test("unquotePath decodes git's quoted names, octal UTF-8 included, and leaves plain ones alone", () => {
  assert.equal(unquotePath('"caf\\303\\251/.env"'), "café/.env");
  assert.equal(unquotePath('"a\\"b\\\\c\\td"'), 'a"b\\c\td');
  assert.equal(unquotePath("plain/path.cs"), "plain/path.cs");
  assert.equal(unquotePath('"100%\\303"'), '100%\\303');
});

test("trimDiff still drops a secret whose header git quoted", () => {
  const quoted = 'diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"\n--- "a/caf\\303\\251/.env"\n+++ "b/caf\\303\\251/.env"\n@@ -1 +1 @@\n+X=1\n';
  const out = trimDiff(quoted + section("ok.cs", "@@ -1 +1 @@\n+keep\n"), 5000);
  assert.ok(out.includes("+keep") && !out.includes("X=1"));
});

test("trimDiff caps its input before redacting, so a huge diff costs a bounded time", () => {
  const started = performance.now();
  const out = trimDiff(section("b.cs", "@@ -1 +1 @@\n" + "+word word\n".repeat(60000)) + section("a.cs", "@@ -1 +1 @@\n+" + "x".repeat(300000) + "\n"), 12000);
  assert.ok(performance.now() - started < 500, `${performance.now() - started} ms`);
  assert.ok(out.length < 12100 && out.endsWith("… (diff truncated)"));
});

test("a single huge line in the diff becomes a marker, not a cost", () => {
  const started = performance.now();
  const out = trimDiff(section("a.cs", "@@ -1 +1 @@\n+" + "x".repeat(300000) + "\n+after\n"), 12000);
  assert.ok(performance.now() - started < 500, `${performance.now() - started} ms`);
  assert.ok(out.includes("‹long line›") || out.length < 12100);
});

test("trimDiff keeps the diff of an edited file under a path that is normally noise", () => {
  const out = trimDiff(section("bin/deploy.sh", "@@ -1 +1 @@\n+echo hi\n") + section("package-lock.json", "@@ -1 +1 @@\n+lock\n"), 5000);
  assert.ok(out.includes("echo hi") && !out.includes("lock"));
});

test("the files list keeps an edited file under a path that is normally noise, and drops lockfiles", () => {
  const prompt = summaryPrompt({ name: "r", subjects: [], diff: "", files: [{ path: "bin/deploy.sh", status: "M", added: 1, deleted: 0 }, { path: "yarn.lock", status: "M", added: 9, deleted: 9 }] });
  assert.ok(prompt.includes("M bin/deploy.sh +1 -0") && !prompt.includes("yarn.lock"));
});

test("parseSummary keeps at most five points", () => {
  const out = parseSummary('{"headline":"h","points":["1","2","3","4","5","6","7"]}');
  assert.equal(out.points.length, 5);
});

test("both system prompts carry the language rule", () => {
  for (const id of ["zh-TW", "en", "ja"]) {
    assert.ok(summarySystem(id).includes(languageRule(id)), id);
    assert.ok(overviewSystem(id).includes(languageRule(id)), id);
  }
});
