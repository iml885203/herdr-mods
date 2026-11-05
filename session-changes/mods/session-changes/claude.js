export function isClaudeForeground(foreground) {
  const program = foreground?.argv?.[0] ?? "";
  return (program.split("/").pop() ?? "").startsWith("claude");
}

export function parseSessionFile(text) {
  if (!text) return null;
  try {
    const { sessionId, cwd, name } = JSON.parse(text);
    return typeof sessionId === "string" && sessionId ? { sessionId, cwd, name } : null;
  } catch {
    return null;
  }
}

export const newestFirst = (agents) => [...agents].sort((a, b) => b.seq - a.seq);

export const sessionLabel = (session) => (session ? session.name ?? session.sessionId.slice(0, 8) : "no session");
