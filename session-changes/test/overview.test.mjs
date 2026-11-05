import { test } from "node:test";
import assert from "node:assert/strict";
import { overviewDue, overviewKey, overviewPrompt, overviewSystem, parseOverview } from "../mods/session-changes/overview.js";

const entry = (root, key, over = {}) => ({ root, key, label: root, layer: "service", headline: `h-${root}`, points: [`p-${root}`], ...over });

test("overviewKey depends on the set of per-repo summary keys, not on their order", () => {
  assert.equal(overviewKey([entry("a", "1"), entry("b", "2")]), overviewKey([entry("b", "2"), entry("a", "1")]));
  assert.notEqual(overviewKey([entry("a", "1"), entry("b", "2")]), overviewKey([entry("a", "1"), entry("b", "3")]));
  assert.notEqual(overviewKey([entry("a", "1")]), overviewKey([entry("a", "1"), entry("b", "2")]));
});

test("an overview is due when two or more repos have summaries, the set changed, everything is idle and it did not just fail", () => {
  const entries = [entry("a", "1"), entry("b", "2")];
  const base = { entries, shown: 2, current: null, failedKey: null, running: false, idle: true };
  assert.equal(overviewDue(base)?.key, overviewKey(entries));
  assert.equal(overviewDue({ ...base, current: overviewKey(entries) }), null);
  assert.equal(overviewDue({ ...base, failedKey: overviewKey(entries) }), null);
  assert.equal(overviewDue({ ...base, running: true }), null);
  assert.equal(overviewDue({ ...base, idle: false }), null);
  assert.equal(overviewDue({ ...base, entries: [entry("a", "1")], shown: 2 }), null);
  assert.equal(overviewDue({ ...base, entries: [entry("a", "1")], shown: 1 }), null);
});

test("the prompt lists the repos in layer order with their headlines and points, and the links between them", () => {
  const prompt = overviewPrompt({ jira: ["SHOP-1"], repos: [entry("shop-db", "1", { layer: "db", headline: "Add rate column", points: ["new SP usp_GetRate"] }), entry("storefront", "2", { layer: "ui" })], relations: ["shop-db jira → storefront"] });
  assert.ok(prompt.includes("Jira: SHOP-1"));
  assert.ok(prompt.includes("- [db] shop-db: Add rate column (new SP usp_GetRate)"));
  assert.ok(prompt.includes("Repos (in layer order):") && prompt.includes("- shop-db jira → storefront"));
  assert.ok(overviewPrompt({ jira: [], repos: [], relations: [] }).includes("Jira: none") && overviewPrompt({ jira: [], repos: [], relations: [] }).includes("Links: none found"));
});

test("the system prompt asks for the gist and the story across repos, in the language it was told", () => {
  const en = overviewSystem("en"), zh = overviewSystem("zh-TW");
  assert.ok(en.includes("two or three sentences") && en.includes("how the repos connect") && en.includes("Write in English"));
  assert.ok(zh.includes("Traditional Chinese") && !zh.includes("Write in English"));
});

test("parseOverview finds the JSON in prose, cleans it and rejects anything else", () => {
  assert.equal(parseOverview('ok {"overview": "DB adds a column\\u001b, API returns it."} done'), "DB adds a column , API returns it.");
  assert.equal(parseOverview('{"overview": "   "}'), undefined);
  assert.equal(parseOverview("no json"), undefined);
  assert.equal(parseOverview('{"overview": 3}'), undefined);
  assert.ok(parseOverview(`{"overview": "${"x".repeat(900)}"}`).length <= 400);
});
