import { DEFAULT_LANGUAGE, isLanguage, languageFromClaude } from "./languages.js";

export const settingsPath = (io) => `${io.appHome()}/data/session-changes.json`;

const readRaw = (io) => io.readTextFile(settingsPath(io)).catch(() => null);

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export const claudeSettingsPath = (io) => `${io.home()}/.claude/settings.json`;

async function claudeLanguage(io) {
  try {
    const text = await io.readTextFile(claudeSettingsPath(io));
    return languageFromClaude(parse(text).language);
  } catch {
    return null;
  }
}

// The language picked in the panel wins; then Claude Code's own `language` setting; then English.
export async function loadLanguage(io) {
  const saved = parse(await readRaw(io)).summaryLanguage;
  if (isLanguage(saved)) return saved;
  return (await claudeLanguage(io)) ?? DEFAULT_LANGUAGE;
}

const queues = new WeakMap();

async function writeLanguage(io, id) {
  const text = await readRaw(io);
  await io.writeTextFile(settingsPath(io), `${JSON.stringify({ ...parse(text), summaryLanguage: id }, null, 2)}\n`, text);
}

export function saveLanguage(io, id) {
  if (!isLanguage(id)) return Promise.reject(new Error(`unknown language: ${id}`));
  const save = (queues.get(io) ?? Promise.resolve()).then(() => writeLanguage(io, id).catch(() => writeLanguage(io, id)));
  queues.set(io, save.catch(() => null));
  return save;
}
