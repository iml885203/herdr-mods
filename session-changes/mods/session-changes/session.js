import { agents, appHome, focused, hc, home, props, readTextFile } from "herdr";
import { isClaudeForeground, newestFirst, parseSessionFile } from "./claude.js";

const PIN_FILE = "session-changes.pin";

async function foregroundOf(address) {
  const result = await hc(["get", address, "--json"]);
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout).foreground ?? null; } catch { return null; }
}

async function sessionOfTerminal(address) {
  const foreground = await foregroundOf(address).catch(() => null);
  if (!isClaudeForeground(foreground) || !foreground.pid) return null;
  const text = await readTextFile(`${home()}/.claude/sessions/${foreground.pid}.json`).catch(() => null);
  const session = parseSessionFile(text);
  return session ? { ...session, address } : null;
}

const isClaudeAgent = (agent) => agent.program?.key === "claude" || agent.app === "claude-code";

export async function claudeSessions() {
  const found = await Promise.all(newestFirst(agents().filter(isClaudeAgent)).map((agent) => sessionOfTerminal(agent.address).catch(() => null)));
  return found.filter(Boolean);
}

async function pinnedSession() {
  const fromProps = props()?.session;
  if (typeof fromProps === "string" && fromProps) return { sessionId: fromProps, name: props()?.name ?? null, cwd: null, address: null };
  const text = await readTextFile(`${appHome()}/${PIN_FILE}`).catch(() => null);
  const pinned = text?.trim();
  return pinned ? { sessionId: pinned, name: null, cwd: null, address: null } : null;
}

export async function initialSession() {
  const pinned = await pinnedSession();
  if (pinned) return pinned;
  const terminal = focused()?.terminal;
  const own = terminal ? await sessionOfTerminal(terminal) : null;
  return own ?? (await claudeSessions())[0] ?? null;
}
