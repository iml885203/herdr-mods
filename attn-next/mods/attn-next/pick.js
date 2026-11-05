// Agents that need the user: blocked first, then done, each by seq. Sub-agents are agents() rows too.
export function queue(agents) {
  const by = (s) => agents.filter((a) => a.status === s).sort((a, b) => a.seq - b.seq);
  return [...by("blocked"), ...by("done")];
}

// The next one after the focused agent, wrapping; the first when the focused one isn't queued; null when empty.
export function pickNext(agents) {
  const q = queue(agents);
  if (!q.length) return null;
  const i = q.findIndex((a) => a.focused);
  return q[(i + 1) % q.length];
}
