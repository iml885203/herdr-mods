const KEEP = "Keep code identifiers, routes, SP and table names, column and field names, config keys and file paths verbatim; never translate them.";

export const LANGUAGES = [
  { id: "zh-TW", label: "繁體中文", rule: `Write in Traditional Chinese (繁體中文, Taiwan usage) characters, never Simplified. ${KEEP}` },
  { id: "en", label: "English", rule: `Write in English. ${KEEP}` },
  { id: "ja", label: "日本語", rule: `Write in Japanese (日本語). ${KEEP}` },
];

export const DEFAULT_LANGUAGE = "en";

export const isLanguage = (id) => LANGUAGES.some((language) => language.id === id);

export const languageRule = (id) => (LANGUAGES.find((language) => language.id === id) ?? LANGUAGES.find((language) => language.id === DEFAULT_LANGUAGE)).rule;

// Claude Code's own `language` setting is free text ("japanese", "ja", "Traditional Chinese"); map what we can.
export function languageFromClaude(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (/simplified|zh-cn|zh-hans|简/.test(text)) return null;
  if (/^(zh|chinese)|traditional|中文|繁/.test(text)) return "zh-TW";
  if (/^(ja|jp)\b|japanese|日本語/.test(text)) return "ja";
  if (/^en\b|english/.test(text)) return "en";
  return null;
}
