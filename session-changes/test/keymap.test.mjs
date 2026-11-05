import { test } from "node:test";
import assert from "node:assert/strict";
import { intentOf } from "../mods/session-changes/keymap.js";

const plain = { platform: false, shift: false, control: false, alt: false };
const press = (key, state = {}, modifiers = plain) => intentOf({ key, modifiers, picking: false, hasDiff: false, overlay: false, ...state });

test("movement keys step the selection", () => {
  assert.deepEqual(["j", "down", "k", "up"].map((k) => press(k)), ["next", "next", "previous", "previous"]);
});

test("enter and space open, l and h expand and collapse", () => {
  assert.deepEqual(["enter", "space", "l", "right", "h", "left"].map((k) => press(k)), ["activate", "activate", "expand", "expand", "collapse", "collapse"]);
});

test("the single letters map to refresh, picker, summarize, open and diff", () => {
  assert.deepEqual(["r", "p", "s", "o", "d"].map((k) => press(k)), ["refresh", "picker", "summarize", "open", "diff"]);
});

test("escape closes one level at a time: picker, then diff, then the window, then nothing", () => {
  assert.equal(press("escape", { picking: true, hasDiff: true, overlay: true }), "closePicker");
  assert.equal(press("escape", { hasDiff: true, overlay: true }), "closeDiff");
  assert.equal(press("escape", { overlay: true }), "closeWindow");
  assert.equal(press("escape"), null);
});

test("while picking only p and escape do anything", () => {
  assert.equal(press("p", { picking: true }), "picker");
  for (const key of ["j", "k", "enter", "r", "s", "o", "d", "l"]) assert.equal(press(key, { picking: true }), null, key);
});

test("cmd-enter docks or floats, other cmd, ctrl or alt chords are left to Herdr", () => {
  assert.equal(press("enter", {}, { ...plain, platform: true }), "place");
  assert.equal(press("enter", {}, { ...plain, platform: true, shift: true }), null);
  for (const mod of ["platform", "control", "alt"]) assert.equal(press("j", {}, { ...plain, [mod]: true }), null, mod);
});

test("unknown keys are left alone", () => {
  assert.equal(press("x"), null);
});
