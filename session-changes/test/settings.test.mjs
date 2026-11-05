import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LANGUAGE, LANGUAGES, isLanguage, languageRule } from "../mods/session-changes/languages.js";
import { loadLanguage, saveLanguage, settingsPath } from "../mods/session-changes/settings.js";

function memoryIo(initial, claude) {
  const files = new Map(initial === undefined ? [] : [["/app/data/session-changes.json", initial]]);
  if (claude !== undefined) files.set("/home/me/.claude/settings.json", claude);
  const writes = [];
  return {
    files, writes,
    appHome: () => "/app",
    home: () => "/home/me",
    readTextFile: async (path) => files.get(path) ?? null,
    writeTextFile: async (path, text, expected) => {
      if ((files.get(path) ?? null) !== expected) throw new Error("stale snapshot");
      files.set(path, text);
      writes.push({ path, text, expected });
      return null;
    },
  };
}

test("the settings live in data/session-changes.json under the app home", () => {
  assert.equal(settingsPath({ appHome: () => "/app" }), "/app/data/session-changes.json");
});

test("the default language is English, used when the file, the key or the value is missing or wrong", async () => {
  assert.equal(DEFAULT_LANGUAGE, "en");
  assert.equal(await loadLanguage(memoryIo()), "en");
  assert.equal(await loadLanguage(memoryIo("{}")), "en");
  assert.equal(await loadLanguage(memoryIo("not json")), "en");
  assert.equal(await loadLanguage(memoryIo('{"summaryLanguage": "klingon"}')), "en");
  assert.equal(await loadLanguage(memoryIo('{"summaryLanguage": 3}')), "en");
});

test("without a saved choice, Claude Code's own language setting is used", async () => {
  assert.equal(await loadLanguage(memoryIo(undefined, '{"language": "japanese"}')), "ja");
  assert.equal(await loadLanguage(memoryIo("{}", '{"language": "Traditional Chinese"}')), "zh-TW");
  assert.equal(await loadLanguage(memoryIo(undefined, '{"language": "zh-TW"}')), "zh-TW");
  assert.equal(await loadLanguage(memoryIo(undefined, '{"language": "English"}')), "en");
});

test("Claude's language setting that is unsupported, malformed or missing falls back to English, and a saved choice still wins", async () => {
  assert.equal(await loadLanguage(memoryIo(undefined, '{"language": "french"}')), "en");
  assert.equal(await loadLanguage(memoryIo(undefined, '{"language": "simplified chinese"}')), "en");
  assert.equal(await loadLanguage(memoryIo(undefined, '{"language": 5}')), "en");
  assert.equal(await loadLanguage(memoryIo(undefined, "garbage")), "en");
  assert.equal(await loadLanguage({ appHome: () => "/app", home: () => { throw new Error("no home"); }, readTextFile: async () => null }), "en");
  assert.equal(await loadLanguage(memoryIo('{"summaryLanguage": "en"}', '{"language": "japanese"}')), "en");
});

test("a saved language is read back", async () => {
  assert.equal(await loadLanguage(memoryIo('{"summaryLanguage": "en"}')), "en");
  assert.equal(await loadLanguage(memoryIo('{"summaryLanguage": "ja"}')), "ja");
});

test("saving creates the file when there is none", async () => {
  const io = memoryIo();
  await saveLanguage(io, "en");
  assert.deepEqual(JSON.parse(io.files.get("/app/data/session-changes.json")), { summaryLanguage: "en" });
  assert.equal(io.writes[0].expected, null);
});

test("saving keeps every other key in the file", async () => {
  const io = memoryIo('{"other": {"a": 1}, "summaryLanguage": "en", "zoom": 2}');
  await saveLanguage(io, "ja");
  assert.deepEqual(JSON.parse(io.files.get("/app/data/session-changes.json")), { other: { a: 1 }, summaryLanguage: "ja", zoom: 2 });
});

test("saving over a file that is not valid JSON starts a clean one rather than failing", async () => {
  const io = memoryIo("garbage");
  await saveLanguage(io, "en");
  assert.deepEqual(JSON.parse(io.files.get("/app/data/session-changes.json")), { summaryLanguage: "en" });
});

test("an unknown language is never saved", async () => {
  const io = memoryIo();
  await assert.rejects(saveLanguage(io, "klingon"), /language/);
  assert.equal(io.writes.length, 0);
});

test("the language list is small, easy to extend, and each entry has an id, a label and a rule", () => {
  assert.deepEqual(LANGUAGES.map((l) => l.id), ["zh-TW", "en", "ja"]);
  assert.deepEqual(LANGUAGES.map((l) => l.label), ["\u7e41\u9ad4\u4e2d\u6587", "English", "\u65e5\u672c\u8a9e"]);
  for (const id of LANGUAGES.map((l) => l.id)) assert.ok(isLanguage(id) && languageRule(id).length > 20);
  assert.equal(isLanguage("zh"), false);
});

test("every rule keeps identifiers, routes, SP and table names, fields and paths verbatim, and Chinese is Traditional only", () => {
  for (const { id } of LANGUAGES) {
    const rule = languageRule(id);
    assert.ok(/verbatim/.test(rule) && /identifiers/.test(rule) && /paths/.test(rule) && /never translate/i.test(rule), id);
  }
  assert.ok(languageRule("zh-TW").includes("Traditional Chinese") && /never Simplified/.test(languageRule("zh-TW")));
  assert.ok(languageRule("en").includes("Write in English"));
  assert.ok(languageRule("ja").includes("Japanese"));
  assert.equal(languageRule("klingon"), languageRule("en"));
});

test("two quick saves are applied one after the other, so the last choice is the one kept", async () => {
  const io = memoryIo('{"keep": 1}');
  await Promise.all([saveLanguage(io, "en"), saveLanguage(io, "ja")]);
  assert.deepEqual(JSON.parse(io.files.get("/app/data/session-changes.json")), { keep: 1, summaryLanguage: "ja" });
  assert.equal(io.writes.length, 2);
});

test("a save that finds the file changed under it reads again and retries once", async () => {
  const io = memoryIo('{"a": 1}');
  const write = io.writeTextFile;
  let raced = false;
  io.writeTextFile = async (path, text, expected) => {
    if (!raced) { raced = true; io.files.set(path, '{"a": 1, "b": 2}'); }
    return write(path, text, expected);
  };
  await saveLanguage(io, "en");
  assert.deepEqual(JSON.parse(io.files.get("/app/data/session-changes.json")), { a: 1, b: 2, summaryLanguage: "en" });
});

test("a save that fails twice rejects with the reason, and the next save still goes through", async () => {
  const io = memoryIo();
  const write = io.writeTextFile;
  let broken = true;
  io.writeTextFile = async (...args) => { if (broken) throw new Error("disk full"); return write(...args); };
  await assert.rejects(saveLanguage(io, "en"), /disk full/);
  broken = false;
  await saveLanguage(io, "ja");
  assert.equal(JSON.parse(io.files.get("/app/data/session-changes.json")).summaryLanguage, "ja");
});
