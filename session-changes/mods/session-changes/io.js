import { appHome, closeOverlay, exec, focused, home, openOverlay, panes, props, readTextFile, run, writeTextFile } from "herdr";

export const io = { exec, home, appHome, readTextFile, writeTextFile };
export const api = { panes, focused, props, run, openOverlay, closeOverlay };
