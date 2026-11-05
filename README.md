# herdr-mods

Add-ons for the [Herdr](https://herdr.dev) desktop app.

<table>
<tr>
<td width="50%"><a href="kubernetes/"><img src="kubernetes/preview.png" alt="Kubernetes"></a><br><b><a href="kubernetes/">Kubernetes</a></b> <code>cmd-k</code><br>Browse pods, deployments and logs across clusters.</td>
<td width="50%"><a href="agent-history/"><img src="agent-history/preview.png" alt="Agent History"></a><br><b><a href="agent-history/">Agent History</a></b> <code>cmd-y</code><br>Search every past Claude Code / Codex session by what was said, and resume it.</td>
</tr>
<tr>
<td><a href="session-changes/"><img src="session-changes/preview.png" alt="Session changes"></a><br><b><a href="session-changes/">Session changes</a></b> <code>cmd-e</code><br>What a Claude Code session changed across every repo it touched, from an AI overview down to the diff.</td>
<td><a href="claude-goal/"><img src="claude-goal/preview.png" alt="Claude goal"></a><br><b><a href="claude-goal/">Claude goal</a></b> <code>cmd-shift-g</code><br>Write the next <code>/goal</code> for the Claude Code session in front of you.</td>
</tr>
<tr>
<td><a href="smart-close/"><img src="smart-close/preview.png" alt="Smart close"></a><br><b><a href="smart-close/">Smart close</a></b> <code>cmd-w</code><br>Closes the pane you're in; the tab goes only with its last pane.</td>
<td><a href="https://github.com/iml885203/orbit/tree/main/integrations/herdr-app"><img src="https://raw.githubusercontent.com/iml885203/orbit/main/integrations/herdr-app/preview.png" alt="Orbit"></a><br><b><a href="https://github.com/iml885203/orbit/tree/main/integrations/herdr-app">Orbit</a></b> <code>cmd-o</code><br>Your local Orbit environments: services, logs, traces. Lives in the Orbit repo.</td>
</tr>
</table>

## Install

Ask the agent in your Herdr app:

> Add herdr.dev/mods/iml885203/herdr-mods--kubernetes

That's it. To install by hand, see the mod's own README.

## Contributing a mod

Each folder with a `RECIPE.md` and a `preview.png` is one gallery item. Make the preview with `scripts/preview-card.py` so every card looks the same, and run `scripts/check.sh` before pushing.

## License

MIT
