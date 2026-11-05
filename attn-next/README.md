# Attn next

`cmd-shift-j` jumps to the next agent that needs you: waiting for input first, then finished.

![Attn next](preview.png)

## Features

- `cmd-shift-j` focuses the next agent that is waiting for your input, and once none are, the next one that has finished.
- Repeated presses walk through the whole list and wrap around, starting after the agent you are on.
- A short toast tells you when no agent needs you.
- No UI: the mod opens a 1x1 popup, acts, and closes it in the same step.

## Requirements

- Herdr desktop app on macOS or Linux

## Install

Copy `mods/attn-next` into `~/.config/herdr-app/mods/` and merge `keys.json` into your own:

```json
{ "global": { "cmd-shift-j": "mod.open:attn-next" } }
```

Then run `herdr-app check mods/attn-next`. Or tell your Herdr agent to add `herdr.dev/mods/iml885203/herdr-mods--attn-next`.

## Keys

| Key | Action |
| --- | --- |
| `cmd-shift-j` | Focus the next agent that is blocked, then done (wraps around) |

## What it runs / Safety

- It calls only the Herdr command `agent.focus`, plus a toast when nothing needs you. It runs no external programs and reads and writes no files.
- It only moves focus; it never answers, closes or changes an agent.
- It takes over `cmd-shift-j`; remove the key from `keys.json` to get the old behavior back.

## License

MIT
