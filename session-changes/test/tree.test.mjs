import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenRows, groupByDir, majorityDir, moveSelection, rowKey } from "../mods/session-changes/tree.js";

const f = (path, owner = "session") => ({ path, owner, status: "M", added: 1, deleted: 0 });
const repo = (name, files, extra = {}) => ({
  root: `/d/${name}`, label: name, layer: "service", branch: "main", state: "pushed", files, owned: files.filter((x) => x.owner === "session").length,
  other: files.filter((x) => x.owner !== "session").length, added: 1, deleted: 0, noise: 0, subjects: ["feat: x"], ahead: 0, ...extra,
});

test("majorityDir picks the folder most paths share", () => {
  assert.equal(majorityDir(["src/a/x.cs", "src/a/y.cs", "src/b/z.cs", "README.md"]), "src/");
  assert.equal(majorityDir(["only/one.cs"]), "only/");
  assert.equal(majorityDir(["a.cs", "b.cs"]), "");
});

test("groupByDir groups by folder under the prefix and puts outliers last", () => {
  const files = [f("src/a/x.cs"), f("src/a/y.cs"), f("src/b/z.cs"), f("README.md")];
  const groups = groupByDir(files, "src/");
  assert.deepEqual(groups.map((g) => [g.dir, g.entries.map((e) => e.name)]), [["a/", ["x.cs", "y.cs"]], ["b/", ["z.cs"]], ["/", ["README.md"]]]);
});

test("a collapsed repo is one row plus its info rows", () => {
  const rows = flattenRows({ repos: [repo("payments", [f("a.cs")])], expanded: new Set(), summaries: {}, relations: {} });
  assert.deepEqual(rows.map((r) => r.kind), ["layer", "repo", "headline"]);
});

test("an expanded repo lists folders then files, then other source after a divider", () => {
  const files = [f("src/a.cs"), f("src/b.cs"), f("x/c.cs", "other")];
  const rows = flattenRows({ repos: [repo("payments", files)], expanded: new Set(["/d/payments"]), summaries: {}, relations: {} });
  assert.deepEqual(rows.map((r) => r.kind), ["layer", "repo", "headline", "folder", "file", "file", "divider", "folder", "file"]);
  assert.equal(rows.at(-1).file.owner, "other");
});

const summarized = {
  summaries: { "/d/payments": { headline: "Add rate", points: ["p1", "p2"] } },
  relations: { "/d/payments": [{ kind: "jira", label: "SHOP-1", targets: ["storefront"] }] },
};

test("a collapsed repo shows its headline only, so it reads at a glance", () => {
  const rows = flattenRows({ repos: [repo("payments", [f("a.cs")])], expanded: new Set(), ...summarized });
  assert.deepEqual(rows.map((r) => r.kind), ["layer", "repo", "headline"]);
  assert.equal(rows[2].text, "Add rate");
});

test("an expanded repo shows its points and links first, and the files below them", () => {
  const rows = flattenRows({ repos: [repo("payments", [f("src/a.cs")])], expanded: new Set(["/d/payments"]), ...summarized });
  assert.deepEqual(rows.map((r) => r.kind), ["layer", "repo", "headline", "point", "point", "links", "folder", "file"]);
});

test("a repo whose file list was cut says how many files are not shown", () => {
  const rows = flattenRows({ repos: [repo("payments", [f("a.cs")], { truncated: 43 })], expanded: new Set(["/d/payments"]), summaries: {}, relations: {} });
  assert.deepEqual(rows.at(-1), { kind: "truncated", count: 43 });
  const closed = flattenRows({ repos: [repo("payments", [f("a.cs")], { truncated: 43 })], expanded: new Set(), summaries: {}, relations: {} });
  assert.ok(!closed.some((r) => r.kind === "truncated"));
});

test("a failed summary is shown as a headline marked failed", () => {
  const rows = flattenRows({ repos: [repo("payments", [f("a.cs")])], expanded: new Set(), summaries: { "/d/payments": { headline: "summary failed: x", points: [], stale: true, failed: true } }, relations: {} });
  assert.equal(rows[2].failed, true);
});

test("a layer header appears once per layer", () => {
  const rows = flattenRows({
    repos: [repo("a", [f("x")], { layer: "db" }), repo("b", [f("x")], { layer: "ui" }), repo("c", [f("x")], { layer: "ui" })],
    expanded: new Set(), summaries: {}, relations: {},
  });
  assert.deepEqual(rows.filter((r) => r.kind === "layer").map((r) => r.layer), ["db", "ui"]);
});

test("very long file lists are capped with a more row", () => {
  const files = Array.from({ length: 5 }, (_, i) => f(`a/${i}.cs`));
  const rows = flattenRows({ repos: [repo("payments", files)], expanded: new Set(["/d/payments"]), summaries: {}, relations: {}, fileLimit: 3 });
  assert.equal(rows.filter((r) => r.kind === "file").length, 3);
  assert.equal(rows.find((r) => r.kind === "more").count, 2);
});

test("moveSelection skips rows that cannot be selected and stays at the ends", () => {
  const rows = flattenRows({ repos: [repo("payments", [f("a.cs")])], expanded: new Set(["/d/payments"]), summaries: {}, relations: {} });
  const keys = rows.filter((r) => r.selectable).map(rowKey);
  assert.deepEqual(keys, ["repo:/d/payments", "file:/d/payments:a.cs"]);
  assert.equal(moveSelection(rows, null, 1), keys[0]);
  assert.equal(moveSelection(rows, keys[0], 1), keys[1]);
  assert.equal(moveSelection(rows, keys[1], 1), keys[1]);
  assert.equal(moveSelection(rows, keys[1], -1), keys[0]);
  assert.equal(moveSelection(rows, "gone", 1), keys[0]);
});

test("outlier folders are titled by their own path, the repo root as a dot", () => {
  const files = ["src/a/1.cs", "src/a/2.cs", "src/a/3.cs", "src/a/4.cs", "src/a/5.cs", "docs/guide/a.md", "other/a.md", "README.md"].map((p) => f(p));
  const rows = flattenRows({ repos: [repo("r", files)], expanded: new Set(["/d/r"]), summaries: {}, relations: {} });
  assert.deepEqual(rows.filter((r) => r.kind === "folder").map((r) => r.text), ["src/a/", ".", "docs/guide/", "other/"]);
});

test("groupByDir keeps the order of the files within a folder and stays linear for a big folder", () => {
  const files = Array.from({ length: 20000 }, (_, i) => ({ path: `src/big/f${i}.cs` }));
  const started = performance.now();
  const [group] = groupByDir(files, "src/");
  assert.equal(group.entries.length, 20000);
  assert.equal(group.entries[0].name, "f0.cs");
  assert.equal(group.entries[19999].name, "f19999.cs");
  assert.ok(performance.now() - started < 500);
});
