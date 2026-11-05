# Session changes

See what a Claude Code session changed across every repo it touched, from an AI summary down to the diff. Press `cmd-e`.

![Session changes](preview.png)

## Privacy: read this first

- The mod reads your Claude Code transcripts (`~/.claude/projects`) and the git diffs of the repos that session touched.
- It then sends those diffs to Claude to write the summaries, automatically, with no confirmation. It runs `claude -p --model haiku` with your own Claude login. Every summary is a paid model call, so a busy session makes several.
- What is sent per repo: the repo name, commit subjects, the file list, and up to about 12,000 characters of diff. Transcript contents are never sent; they are only scanned for which files and folders the session touched.
- Before sending, the text goes through a credential redactor (`redact.js`). It replaces with `‹v›`, `‹t›` or `‹u›`:
  - values of keys named like password, secret, token, API key, access key, private key, connection string, credentials, and the same in XML elements, attributes, and CLI flags (`--password`, `docker login -p`, `sqlcmd -P`, `curl -u`, `mysql -p`);
  - passwords inside URLs (`scheme://user:pass@host`);
  - well-known token shapes: AWS access keys, GitHub, GitLab and Grafana tokens, Stripe-style keys, Google API keys, npm tokens, `sk-` keys, Slack tokens, `Bearer` tokens, JWTs;
  - PEM private key blocks, long random-looking strings in diffs, and any line over 1,000 characters.
  Files named like secrets (`.env`, `*.pem`, `*.key`, `appsettings*.json`, `credentials*`, kubeconfig and similar), lockfiles and generated files are left out entirely.
- **Redaction is best effort, not a guarantee.** Anything that does not look like a credential, including proprietary code and data in your diffs, is sent as is. Do not use this mod on repos you may not send to Claude.
- Summaries are kept in the mod's `localStorage` (last 40, per session, repo and language); the chosen language is saved to `data/session-changes.json` in the app home. Nothing is written into your repos. Git is run read-only.

## Features

- One headline per repo, an AI overview line across repos, then key points (routes, tables, fields, versions), files, and a diff, from shallow to deep.
- Repos grouped by layer, with branch, an `uncommitted` / `unpushed` / `no upstream` / `pushed` chip, file count and `+`/`-` lines.
- Links between repos: shared Jira keys, submodule pointers, shared identifiers.
- Finds the session for you: the focused Claude Code terminal, or the newest one; pick another with `p`.
- Summary language picker: Traditional Chinese, English, Japanese. Default is Claude Code's `language` setting, else English.
- Float, dock as a split, or open as a tab. Optional VS Code buttons for the file and its diff.

## Requirements

- Herdr desktop app on macOS (Linux: see below)
- `git` and `claude` (Claude Code, logged in) on your `PATH`
- Optional: `code` on your `PATH` (VS Code buttons), `JetBrainsMono Nerd Font` (icons)

## Install

Copy `mods/session-changes` into `~/.config/herdr-app/mods/` (keep the folder name) and merge `keys.json` into your own:

```json
{ "global": { "cmd-e": "mod.open:session-changes" } }
```

Then run `herdr-app check mods/session-changes`. Or tell your Herdr agent to add `herdr.dev/mods/iml885203/herdr-mods--session-changes`.

## Keys

| Key | Action |
| --- | --- |
| `cmd-e` | Open the window |
| `j` `k` / arrows | Move |
| `Enter` or `space` | Expand a repo, or open a file's diff |
| `l` `h` / arrows | Expand, collapse |
| `r` | Refresh |
| `s` | Write the selected repo's summary again |
| `p` | Pick another Claude session |
| `o` `d` | Open the file, or its diff, in VS Code |
| `cmd-enter` | Dock beside the focused pane, or float again |
| `Esc` | Close the picker, then the diff, then the window |

## Good to know

- The `pushed` chip compares with your last fetch, not with the server. A repo with no upstream branch (for example no remote) always says `no upstream`.
- Only files the session edited with its edit tools (or committed during the session) count as the session's. Changes made only through shell commands and not committed are not attributed.
- It reads Claude Code's own transcript files, whose format is not a public contract and can change.
- It uses `stat -f`, which is BSD/macOS syntax. On Linux (GNU `stat`) the change probe does not work, so edits you make by hand are only picked up with `r`. Not tested on Linux.

## Credits

A port of a Changes view from an earlier internal Claude Code plugin.

## License

MIT, see the repository `LICENSE`.
