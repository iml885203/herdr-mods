# Claude tab name

A tab and its Claude Code session keep the same name: `/rename` in Claude renames the tab, and `F2` renames both.

![Claude tab name](preview.png)

## What you see

- `F2` opens a small popup at the top of the window (`mod.json`: `place: "none"`, title `Rename tab`, overlay `popup`, `at: "top"`, `offset: 80`, `420` × `132`). Inside, on `theme().popover` with 14 px padding: the title "Rename tab" (14 px, semibold); one text field in a 34 px rounded box with an accent border, holding the tab's name when someone named it, else empty with the placeholder `Tab <index>`; and a dim 11.5 px line with, on the left, "Its Claude session gets the name too." ("No Claude in this tab: the tab only." without one, "No tab is focused." without a tab, "Renaming the Claude session…" while it works) and on the right "↵ rename   esc cancel".
- The other copy, a 0 px layout block, draws an empty `div()`.

## How it behaves

- **One mod, two copies.** `init()` checks `props().overlay`: set means the F2 popup, unset means the sync copy in the layout.
- **Sync copy**: `cx.timer.every(2000)` plus one run at start; a run is skipped while the previous one is still going.
  1. Takes this machine's Claude panes: `panes()` entries with `app === "claude-code"`, a `terminal`, and a tab of a space whose `machine` is null. Cached pids of terminals no longer among them are dropped; with no Claude panes the run ends here.
  2. Reads every `~/.claude/sessions/<digits>.json` (`fs.readdir`, `fs.readFile`). A file with a numeric `pid` is a live session; its name counts only when `nameSource === "user"` and the cleaned `name` isn't empty. `since` is `nameSince`, or 0.
  3. Maps each Claude terminal to Claude's pid with `hc get <terminal>` → `foreground.pid`. The answer is kept per terminal and asked again when it is null, when that pid has no session file, or after 30 s.
  4. For each Claude pane with a named session, the key is `since` + name. When it differs from the last key recorded for that terminal, it is recorded, and when the tab's name differs, `run("tab.rename", { id, name })`, at most one rename per tab per run (the first Claude in pane order). Keys of terminals that are gone are forgotten.
  5. Errors are logged with `console.log` and the next run tries again.
- **F2 popup**: at open, the tab is `focused().tab` among this machine's tabs, and its Claude is `focused().terminal` when that is one of the tab's Claude panes, else the tab's focused Claude pane, else its first one. The field gets focus at once and again after 300 ms. Esc closes the popup, except while it is renaming. Closed some other way mid-rename (a click outside), it stops where it was: no `/rename`, no warning; a probe already started still takes its key back. Enter:
  1. The name is cleaned: control characters (U+0000–001F, U+007F–009F) and U+2028/2029 become spaces, zero-width and bidi controls (U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF) go, whitespace runs collapse to one space, trimmed, cut to 100 code points. `run("tab.rename", { id, name })`; an empty name puts the tab back to its number.
  2. When the name is empty, or the tab's Claude pane is gone or no longer runs Claude (`terminal`, `tab` and `app` are checked again), the popup closes. Claude has no "no name", so an empty name never reaches it.
  3. Otherwise the popup stays open ("Renaming the Claude session…"), decides, types or not, then closes. The decision (`decide(status, hc read screen)`):
     - `blocked`: don't type ("Claude is asking you something").
     - No prompt box on the screen (the read failed, a picker or dialog is open, bash mode): don't type ("couldn't find Claude's prompt (a dialog may be open)"). The box is the last line starting with `❯` right under a line starting with `─`, down to the next such rule; no closing rule means no box.
     - `-- NORMAL --`, `-- INSERT --` or `-- VISUAL --` below the box: don't type ("Claude's prompt is in vim mode").
     - Empty box: type.
     - Text in the box while `working`: don't type ("Claude's prompt has unsent text"); mid-turn there's no suggestion, so it is yours.
     - Text in the box otherwise (`idle`, `done`, no status yet): it may be Claude's grey suggestion (or the `Try "…"` placeholder), which reads the same. Probe, in one `exec("sh", ["-c", PROBE_SH, "probe", terminal, "x"])` so it finishes even if the popup closes: `hc keys "$1" "$2" >/dev/null || exit 3; sleep 0.4; hc read "$1"; r=$?; hc keys "$1" backspace >/dev/null || exit 4; [ $r -eq 0 ] || exit 5; exit 0`. Exit 3: don't type ("couldn't type into Claude's prompt"; no backspace was sent). Exit 4: don't type (`an "x" was left in Claude's prompt (delete it)`). Otherwise compare the printed screen's box with the one before (`probeResult`): just `x` means a suggestion (a typed key replaces it); unchanged or empty means "same"; other text means a draft ("Claude's prompt has unsent text"); no box, or any other non-zero exit (5: the read failed, the key already taken back), means "unknown". Anything but a suggestion: don't type ("couldn't tell Claude's suggestion from a draft" for same/unknown). After a suggestion, up to six 0.15 s reads (`exec("sleep")`) until the box reads as before or empty (`settled`), else don't type ("Claude's prompt didn't settle"); then type.
     - Before typing, the pane is checked again ("Claude is no longer running in that tab"). Typing is `exec("env", ["-u", "HC_TERMINAL_ID", "-u", "HC_TERMINAL_SOCKET", "-u", "HC_SCOPE", "hc", "send", terminal, "/rename <name>"])`; a non-zero exit gives its output (160 characters) or `hc send exited <code>` as the reason. A thrown error's message is a reason too.
  4. With a reason, `notify` a warning: title "Tab renamed, Claude not", body "<reason>. Run /rename <name> in Claude to match."
- `close()` cancels the timers and releases the input.

## Built from

- `mods/claude-tab-name/main.js` (the view, both copies), `logic.js` (pure rules: `readSession`, `cleanName`, `claudeOf`, `renames`, `promptBox`, `decide`, `probeResult`, `settled`, `PROBE_KEY`), `mod.json`, and `keys.json`. Tests for `logic.js` live outside the mod folder (`test/logic.test.mjs`, `node --test`).
- `herdr`: `spaces`, `panes`, `focused`, `run`, `hc`, `exec`, `home`, `props`, `closeOverlay`, `notify`, `theme`; `gpui-kit`: `View`, `div`; `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`; `fs/promises`.
- Commands: `tab.rename`. Programs: `hc get`, `hc read`, `hc keys` (inside `sh -c` for the probe), `hc send` (through `env`), `sleep`.
- `keys.json`: `{ "global": { "f2": "mod.open:claude-tab-name" } }` (replaces Herdr's own `f2` → `tab.rename`).
- The layout needs `{ "id": "claude-tab-name", "type": "block", "size": { "px": 0 }, "content": { "mod": "claude-tab-name" } }` somewhere in its tree (a personal layout; shipped ones take no structure changes).

## Watch out

- **The layout block must not be `"hidden": true`.** A copy starts the first time it shows, and a hidden block never shows, so the sync never runs. A shown 0 px block takes no room and works.
- **`hc send` from inside an hc terminal is a message, not typing.** When Herdr was started from a shell running in an hc terminal, `HC_TERMINAL_ID` and friends are inherited, and `hc send` then delivers `<hc from="t…">/rename …</hc>`, which Claude reads as chat. Strip those variables (the `env -u` call).
- **Claude runs `/rename` mid-turn.** No need to wait for it to finish; only a permission prompt (`blocked`) must not get text.
- **Typing over a draft sends the draft.** Pasting `/rename` after unsent text gives `hello/rename x` + Enter, a message to the model. Type only into a box shown empty, or one the probe showed to hold a suggestion; anything unreadable means don't type.
- **Don't probe with Esc.** It looks tempting (Claude offers "Esc again to clear" for typed text only), but with the `/` or `@` menu open the first Esc closes the menu instead, which `hc read` can't see, and a draft like `/mo` then reads as a suggestion. A second Esc on an empty prompt opens the rewind picker. A typed key and a backspace are safe in every state but vim mode, which is refused. Run them in one shell command: a popup closed between them (its tasks stop) would leave the key in the prompt, and a backspace without its key eats a character of the draft.
- **Only user names.** `nameSource` is `"derived"` for Claude's automatic names; they must not rename tabs.
- **The popup must stay open until it's done.** A closed popup's tasks stop, so the reads and the probe happen before `closeOverlay`, and Esc is ignored meanwhile.
- **No timers outside init/handlers** (QuickJS): the waits are `exec("sleep")`.
- **`hc` comes from Herdr's PATH** (`~/.local/bin/hc`). Without it every call fails, safely: nothing is typed, and the warning says so.
- **Folder name.** The key is `mod.open:claude-tab-name`, so the folder must be `mods/claude-tab-name/`.
- **Gaps.** A prompt holding only spaces reads as empty (the screen pads lines with spaces too), so `/rename` lands after them and goes out as a message. Typing into that prompt during the probe's 0.4 s mixes with the probe key. Mouse renames (double-click a tab) use Herdr's own `tab.rename` and don't reach Claude; the next time the mod first sees that Claude (Herdr start, layout switch, Claude restart) the tab gets Claude's name back. Remote machines are skipped. Two named Claudes in one tab: the first in pane order names it.

## Done when

- `herdr-app check mods/claude-tab-name` passes and `node --test` passes in the item folder.
- `/rename alpha` in a Claude tab renames the tab to `alpha` within ~2 s.
- `F2`, type `beta`, Enter: the tab is `beta` and Claude's session is `beta` (`~/.claude/sessions/<pid>.json` `name`), with Claude idle, showing a suggestion, or mid-turn.
- With unsent text in Claude's prompt (idle or mid-turn), or a picker open, `F2` renames only the tab, Claude's screen is as it was, and a warning says why.
- `F2` with an empty name puts the tab back to its number and leaves Claude's name.
