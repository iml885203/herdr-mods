# Claude tab name

A tab and its Claude Code session keep the same name: `/rename` in Claude renames the tab, and `F2` renames both.

![Claude tab name](preview.png)

## Features

- `/rename <name>` in Claude Code: the tab takes the name within a couple of seconds.
- `F2` in Herdr: rename the tab, and the Claude in it gets `/rename <name>` typed for it. Works while Claude is busy too.
- Only names you gave count. Claude's own automatic titles never rename a tab.
- An empty name puts the tab back to its number and leaves Claude's name alone (Claude has no "no name").

## Requirements

- Herdr desktop app on macOS or Linux
- Claude Code (it writes `~/.claude/sessions/<pid>.json`, which this reads)

## Install

1. Copy `mods/claude-tab-name` into `~/.config/herdr-app/mods/`.
2. Merge `keys.json` into your own: `{ "global": { "f2": "mod.open:claude-tab-name" } }`.
3. Add a 0 px block to your layout (a personal one: clone a shipped layout first), anywhere in its tree:

   ```json
   { "id": "claude-tab-name", "type": "block", "size": { "px": 0 }, "content": { "mod": "claude-tab-name" } }
   ```

   This copy does the `/rename` → tab part. Don't mark it `"hidden": true`: a hidden block never starts its mod.
4. Run `herdr-app check ~/.config/herdr-app/mods/claude-tab-name`.

Or tell your Herdr agent to add `herdr.dev/mods/iml885203/herdr-mods--claude-tab-name`.

## Keys

| Key | Action |
| --- | --- |
| `F2` | Rename the focused tab, and its Claude session with it |

## What it runs / Safety

- Reads `~/.claude/sessions/*.json` every 2 seconds (small files Claude Code keeps per running session) and runs `hc get <terminal>` to match a session to its terminal (when a Claude appears or restarts, and every 30 seconds).
- `F2` reads that Claude's screen (`hc read`) and types `/rename <name>` into it with `hc send` (run through `env` without Herdr's `HC_*` variables), as if you had typed it. The draft check uses `hc keys` and `sleep`. The name is one line of printable text (no control, zero-width or bidi characters), at most 100 characters.
- It never types over your work. It renames only the tab, and tells you to run `/rename` yourself, when Claude's prompt has unsent text, when Claude is asking you a question (a permission prompt), when a picker or dialog is open, when Claude's prompt is in vim mode, or when it can't read Claude's screen. To tell your draft from Claude's grey suggestion it may type one `x` and delete it again within half a second while Claude waits for you, so the prompt ends as it was.
- The tab follows Claude when Claude's name changes, and whenever the mod first sees a Claude (Herdr starting, a new Claude pane, a layout switch). A tab you renamed some other way (not `F2`) gets Claude's name back then.
- Only this machine's tabs; spaces on other machines are skipped.

## License

MIT
