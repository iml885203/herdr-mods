import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDock, FLOAT } from "../mods/session-changes/dock.js";

function api({ panes = [], focused = { pane: "p1", tab: "t1" }, overlay = "ov1" } = {}) {
  const log = [];
  return {
    log,
    panes: () => panes,
    focused: () => focused,
    props: () => (overlay ? { overlay } : {}),
    run: (name, args) => log.push(["run", name, args]),
    openOverlay: (spec) => log.push(["openOverlay", spec]),
    closeOverlay: (id) => log.push(["closeOverlay", id]),
  };
}
const host = { pane: "p1", tab: "t1", terminal: "t9" };
const session = { sessionId: "sid-1", name: "shop-8a" };

test("docking splits beside the focused pane with the picked session as props, then closes the window", () => {
  const a = api({ panes: [host] });
  assert.equal(createDock(a).dockHere("session-changes", session), "");
  assert.deepEqual(a.log, [
    ["run", "pane.split", { pane: "p1", direction: "right", mod: "session-changes", props: { session: "sid-1", name: "shop-8a" } }],
    ["closeOverlay", "ov1"],
  ]);
});

test("docking again replaces the copy that is already docked, so the picked session wins", () => {
  const a = api({ panes: [host, { pane: "p2", tab: "t1", mod: "session-changes" }] });
  createDock(a).dockHere("session-changes", session);
  assert.deepEqual(a.log.map((l) => l[1]), ["pane.close", "pane.split", "ov1"]);
  assert.deepEqual(a.log[0][2], { pane: "p2" });
});

test("docking without a session sends no props, and without a window or a host it says why", () => {
  const a = api({ panes: [host] });
  createDock(a).dockHere("session-changes", null);
  assert.equal(a.log[0][2].props, undefined);
  assert.equal(createDock(api({ panes: [host], overlay: null })).dockHere("session-changes", session), "No pane to dock beside.");
  assert.equal(createDock(api({ panes: [] })).dockHere("session-changes", session), "No pane to dock beside.");
});

test("floating again opens the window with the picked session and closes the docked pane", () => {
  const a = api({ panes: [{ pane: "p2", tab: "t1", mod: "session-changes", focused: true }], overlay: null });
  assert.equal(createDock(a).floatAgain("session-changes", session), "");
  assert.deepEqual(a.log[0], ["openOverlay", { ...FLOAT, mod: "session-changes", props: { session: "sid-1", name: "shop-8a" } }]);
  assert.deepEqual(a.log[1], ["run", "pane.close", { pane: "p2" }]);
});

test("floating does nothing while already floating", () => {
  const a = api({ panes: [], overlay: "ov1" });
  createDock(a).floatAgain("session-changes", session);
  assert.deepEqual(a.log, []);
});

test("the float spec and mod.json describe the same window, key included", () => {
  const modJson = JSON.parse(readFileSync(new URL("../mods/session-changes/mod.json", import.meta.url), "utf8"));
  assert.deepEqual(modJson.overlay, FLOAT);
  assert.equal(typeof FLOAT.key, "string");
});

test("opening as a tab starts a tab that shows this mod with the picked session, then closes the window", () => {
  const a = api({ panes: [host], focused: { space: "s1", pane: "p1", tab: "t1" } });
  assert.equal(createDock(a).openAsTab("session-changes", "Session changes", session), "");
  assert.deepEqual(a.log, [
    ["run", "tab.new", { space: "s1", mod: "session-changes", name: "Session changes", props: { session: "sid-1", name: "shop-8a" } }],
    ["closeOverlay", "ov1"],
  ]);
});

test("opening as a tab needs a window and a space", () => {
  assert.equal(createDock(api({ overlay: null })).openAsTab("session-changes", "x", session), "No window to move into a tab.");
  assert.equal(createDock(api({ focused: null })).openAsTab("session-changes", "x", session), "No space to open a tab in.");
});
