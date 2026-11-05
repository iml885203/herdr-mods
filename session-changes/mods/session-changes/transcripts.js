const MAIN = 'for f in "$1"/*/"$2".jsonl; do [ -e "$f" ] && printf "%s\\n" "$f"; done';
const SUBAGENTS = 'for f in "$1"/*/"$2"/subagents/*.jsonl; do [ -e "$f" ] && printf "%s\\n" "$f"; done';
const SUBAGENT_TTL_MS = 30000;

export function createTranscripts(exec, home, { now = Date.now, ttl = SUBAGENT_TTL_MS } = {}) {
  const root = `${home}/.claude/projects`;
  const subagentLists = new Map();
  const list = async (script, sessionId) => (await exec("sh", ["-c", script, "sh", root, sessionId]).catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean);

  async function find(sessionId) {
    const [file] = await list(MAIN, sessionId);
    return file ? { file } : null;
  }

  // The glob is repeated only when asked (a forced tick, or the transcript just grew and may have started a subagent) or when the list is older than the ttl.
  async function subagents(sessionId, { refresh = false } = {}) {
    const known = subagentLists.get(sessionId);
    if (known && !refresh && now() - known.at < ttl) return known.files;
    const files = await list(SUBAGENTS, sessionId);
    subagentLists.set(sessionId, { files, at: now() });
    return files;
  }

  return { find, subagents };
}
