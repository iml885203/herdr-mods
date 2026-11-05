export function unquotePath(text) {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  return text.slice(1, -1).replace(/((?:\\[0-7]{3})+)|\\(["\\tn])/g, (match, octal, simple) => {
    if (simple) return { t: "\t", n: "\n" }[simple] ?? simple;
    try { return decodeURIComponent(octal.replace(/\\([0-7]{3})/g, (_, digits) => `%${parseInt(digits, 8).toString(16).padStart(2, "0")}`)); } catch { return match; }
  });
}

const HEADER = /^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.+?) ("(?:[^"\\]|\\.)*"|b\/.+)$/m;

export function pathOfSection(section) {
  const quoted = HEADER.exec(section)?.[1];
  return quoted === undefined ? undefined : unquotePath(quoted).replace(/^b\//, "");
}
