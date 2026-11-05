import { pathOfSection } from "./diffpath.js";

const MAX_LINE = 1000;
const LONG_LINE = "‹long line›";
const VALUE = "‹v›";
const USER = "‹u›";
const TOKEN = "‹t›";

const CONFIG = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|appsettings[^/]*|\.env[^/]*|[^/]*\.(json|ya?ml|ini|cfg|properties|toml|conf|config|sh|tf|tfvars|env))$/i;
const SINGLES = new Set(["pass", "password", "passwd", "passphrase", "pwd", "pw", "secret", "secrets", "token", "tokens", "credential", "credentials", "dsn", "auth", "authorization", "apikey", "accesskey", "privatekey", "accountkey", "signingkey", "encryptionkey", "clientsecret", "connectionstring"]);
const TRIPLES = new Set(["secret key base"]);
const PAIRS = new Set(["api key", "access key", "private key", "account key", "signing key", "encryption key", "secret key", "client secret", "connection string", "shared access key", "auth token"]);
const NOT_PASS = new Set(["bypass", "compass", "overpass", "underpass", "surpass", "trespass", "encompass", "impass", "mass", "pass"]);
const KEYWORDS = new Set(["new", "default", "null", "nil", "none", "true", "false", "undefined", "this", "empty", "string", "number", "boolean", "bool", "int", "any", "object", "void", "required", "optional", "str", "float", "double", "long", "decimal", "char"]);
const PLACEHOLDER = /^(\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_]\w*|\{\{.*\}\}|<[^>]*>|%[^%]+%)$/;
const SCHEMES = new Set(["bearer", "basic", "token", "digest"]);
const ASSIGNMENT = /(?<![\w.$@-])([A-Za-z_$@][\w.$@-]*)(["']?)(\s*)(:=|=>|(?<![!<>=:])=(?![=>])|:(?![:=]))\s*/g;
const XML_ELEMENT = /<([A-Za-z_][\w.-]*)>([^<]+)<\/\1>/g;
const ATTRIBUTE_PAIR = /\b((?:key|name|id)\s*=\s*)(["'])([^"']*)\2(\s+value\s*=\s*)(["'])([^"']*)\5/gi;
const LONG_FLAG = /(\s--?(?:password|passwd|passphrase|pwd|secret|token|api-?key|access-?key|client-?secret|auth-?token)[ ]+)(?![-$<{%])(\S+)/gi;
const SQL_CLIENT_FLAG = /\b(mysql|mysqldump|mysqladmin|psql|pg_dump|mongo|mongosh|redis-cli)\b([^\n]*?\s-p)(?![\s\d])(\S+)/g;
const PAIR_LIST = /(?<![\w .-])[A-Za-z][\w .-]*=[^;=\n]*;\s*[A-Za-z][\w .-]*=/;
const SUBSCRIPT = /\[\s*(["'])([^"']+)\1\s*\]\s*=(?![=>])\s*/g;
const PROPERTY_DEFAULT = /\b([A-Za-z_]\w*)\s*\{[^}]*\}\s*=(?![=>])\s*/g;
const CALL_PAIR = /\(\s*(["'])([^"']+)\1\s*,\s*/g;
const AUTH_TUPLE = /\bauth\s*=\s*\(\s*(["'])[^"']*\1\s*,\s*/g;
const DOCKER_LOGIN = /\b(docker\s+login\b[^\n]*?\s(?:-p|--password)[ =]+)(?![-$<{%])(\S+)/g;
const SQLCMD = /\b(sqlcmd\b[^\n]*?\s-P\s+)(?![-$<{%])(\S+)/g;
const CURL_USER = /\b((?:curl|wget|http)\b[^\n]*?\s(?:-u|--user)[ =]+)([^\s:]+:)(?![-$<{%])(\S+)/g;
const TERNARY = /\?\s*(["'])([^"']+)\1\s*:\s*(["'])([^"']+)\3/;
const USERINFO = /(:\/\/)[^\s/@]*:[^\s/@]*@/g;
const SCHEMELESS = /(?<![\w/@.:-])[A-Za-z0-9_.-]{2,}:[^\s/@:'"]{4,}@(?=[A-Za-z0-9])/g;
const SHAPES = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bglsa_[A-Za-z0-9_]{20,}/g,
  /\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?<=Bearer\s+)[A-Za-z0-9._-]{20,}/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g,
];
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const SEGMENT = /[A-Za-z0-9+=]{32,}/g;
const WORD = /[A-Z]?[a-z]+/g;
const NAME_ENTRY = /\b(?:name|key|id|variable)\s*[:=]\s*["']?([A-Za-z_][\w.-]*)["']?\s*,?\s*$/i;
const VALUE_ENTRY = /^(\s*(?:-\s*)?["']?(?:value|val)["']?\s*[:=]\s*)(.+)$/i;

export const isConfigPath = (path) => CONFIG.test(path);

function wordsOf(key) {
  const last = key.split(".").pop().replace(/^[$@]+/, "");
  return last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
}

function credentialKey(key) {
  const words = wordsOf(key);
  const last = words.at(-1);
  if (!last) return false;
  if (SINGLES.has(last) || PAIRS.has(words.slice(-2).join(" ")) || TRIPLES.has(words.slice(-3).join(" "))) return true;
  return (/(pass|pwd)$/.test(last) && !NOT_PASS.has(last)) || /(password|passwd|secret|token)$/.test(last);
}

function identifierShaped(run) {
  const characters = run.replace(/[^A-Za-z0-9]/g, "");
  const inWords = (run.match(WORD) ?? []).filter((w) => w.length >= 2).reduce((n, w) => n + w.length, 0);
  return inWords / characters.length >= 0.75;
}

const randomLooking = (run) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run) && !identifierShaped(run);

const defaultOf = (text, base) => {
  const found = /^\$\{[^}:]*:[-=]([^}]*)\}$/.exec(text);
  return found && found[1] ? { start: base + text.length - 1 - found[1].length, end: base + text.length - 1 } : null;
};

function quotedValueAt(line, at) {
  const quote = line[at];
  let end = at + 1;
  while (end < line.length && line[end] !== quote) end += line[end] === "\\" ? 2 : 1;
  const inner = line.slice(at + 1, Math.min(end, line.length));
  if (!inner) return null;
  return PLACEHOLDER.test(inner) ? defaultOf(inner, at + 1) : { start: at + 1, end: at + 1 + inner.length };
}

function bareRun(line, at) {
  let i = at;
  while (i < line.length) {
    if (line[i] === "$" && (line[i + 1] === "{" || line[i + 1] === "(")) {
      const open = line[i + 1];
      const close = open === "{" ? "}" : ")";
      let depth = 0;
      let j = i + 1;
      for (; j < line.length; j++) {
        if (line[j] === open) depth++;
        else if (line[j] === close && --depth === 0) break;
      }
      i = Math.min(j + 1, line.length);
    } else if (/[\s"'`;,)}\]]/.test(line[i])) break;
    else i++;
  }
  return line.slice(at, i);
}

function bareValueAt(line, at, config) {
  const run = bareRun(line, at);
  if (!run) return null;
  if (PLACEHOLDER.test(run)) return defaultOf(run, at);
  if (KEYWORDS.has(run.toLowerCase())) return null;
  if (SCHEMES.has(run.toLowerCase())) {
    const next = /^\s+([^\s"'`;,)}\]]+)/.exec(line.slice(at + run.length));
    return next ? { start: at + run.length + next[0].length - next[1].length, end: at + run.length + next[0].length } : null;
  }
  const literal = config ? !/^[{[|>]/.test(run) : run.length >= 8 && !/[.(?+]/.test(run) && /[^A-Za-z]/.test(run) && !/^[$@]/.test(run);
  return literal ? { start: at, end: at + run.length } : null;
}

function declaredValueAt(line, at) {
  const run = bareRun(line, at);
  if (!KEYWORDS.has(run.toLowerCase())) return null;
  const equals = /^\s*=(?!=)\s*/.exec(line.slice(at + run.length));
  return equals ? at + run.length + equals[0].length : null;
}

function valueSpans(line, at, config) {
  if (/^["'`]/.test(line[at] ?? "")) {
    const span = quotedValueAt(line, at);
    return span ? [span] : [];
  }
  const span = bareValueAt(line, at, config);
  if (span) return [span];
  const typed = declaredValueAt(line, at);
  if (typed !== null) return valueSpans(line, typed, config);
  const ternary = TERNARY.exec(line.slice(at));
  if (!ternary) return [];
  const first = at + ternary.index + ternary[0].indexOf(ternary[2]);
  const second = at + ternary.index + ternary[0].lastIndexOf(ternary[4]);
  return [{ start: first, end: first + ternary[2].length }, { start: second, end: second + ternary[4].length }];
}

function insideString(line, index) {
  let quote = null;
  for (let i = 0; i < index; i++) {
    if (quote && line[i] === "\\") i++;
    else if (quote === line[i]) quote = null;
    else if (!quote && (line[i] === '"' || line[i] === "'")) quote = line[i];
  }
  return quote !== null;
}

function placeholderRanges(line) {
  const ranges = [];
  for (const start of line.matchAll(/\$[{(]/g)) {
    const open = line[start.index + 1];
    const close = open === "{" ? "}" : ")";
    let depth = 0;
    let end = start.index + 1;
    for (; end < line.length; end++) {
      if (line[end] === open) depth++;
      else if (line[end] === close && --depth === 0) break;
    }
    ranges.push([start.index, end]);
  }
  return ranges;
}

function assignmentSpans(line, { config, text }) {
  const pairs = PAIR_LIST.test(line);
  const placeholders = placeholderRanges(line);
  const spans = [];
  for (const match of line.matchAll(ASSIGNMENT)) {
    if (!credentialKey(match[1]) || placeholders.some(([from, to]) => match.index > from && match.index < to)) continue;
    const envStyle = text && match[0].endsWith("=") && !match[3];
    spans.push(...valueSpans(line, match.index + match[0].length, config || pairs || envStyle || insideString(line, match.index)));
  }
  for (const rule of [SUBSCRIPT, CALL_PAIR]) {
    for (const match of line.matchAll(rule)) if (credentialKey(match[2])) spans.push(...valueSpans(line, match.index + match[0].length, false));
  }
  for (const match of line.matchAll(PROPERTY_DEFAULT)) if (credentialKey(match[1])) spans.push(...valueSpans(line, match.index + match[0].length, false));
  for (const match of line.matchAll(AUTH_TUPLE)) spans.push(...valueSpans(line, match.index + match[0].length, false));
  return spans;
}

function applySpans(line, spans) {
  const kept = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (kept.length === 0 || span.start >= kept.at(-1).end) kept.push(span);
    else kept.at(-1).end = Math.max(kept.at(-1).end, span.end);
  }
  let out = line;
  for (const { start, end } of kept.reverse()) out = `${out.slice(0, start)}${VALUE}${out.slice(end)}`;
  return out;
}

function redactStructured(line) {
  return line
    .replace(XML_ELEMENT, (m, tag, inner) => (credentialKey(tag) && !PLACEHOLDER.test(inner.trim()) ? `<${tag}>${VALUE}</${tag}>` : m))
    .replace(ATTRIBUTE_PAIR, (m, k, q1, name, v, q2, value) => (credentialKey(name) && value && !PLACEHOLDER.test(value) ? `${k}${q1}${name}${q1}${v}${q2}${VALUE}${q2}` : m))
    .replace(LONG_FLAG, `$1${VALUE}`)
    .replace(DOCKER_LOGIN, `$1${VALUE}`)
    .replace(SQLCMD, `$1${VALUE}`)
    .replace(CURL_USER, `$1$2${VALUE}`)
    .replace(SQL_CLIENT_FLAG, `$1$2${VALUE}`);
}

function redactShapes(line, entropy) {
  let out = line.replace(USERINFO, `$1${USER}@`).replace(SCHEMELESS, `${USER}@`);
  for (const shape of SHAPES) out = out.replace(shape, TOKEN);
  return entropy ? out.replace(SEGMENT, (run) => (randomLooking(run) ? TOKEN : run)) : out;
}

function redactLine(line, { config, text = false, entropy, afterName }) {
  if (line.length > MAX_LINE) return LONG_LINE;
  const entry = afterName ? VALUE_ENTRY.exec(line) : null;
  const named = entry ? `${entry[1]}${PLACEHOLDER.test(entry[2].trim()) ? entry[2] : VALUE}` : line;
  const structured = redactStructured(named);
  return redactShapes(applySpans(structured, assignmentSpans(structured, { config, text })), entropy);
}

const namesCredential = (line) => credentialKey(NAME_ENTRY.exec(line)?.[1] ?? "");

function redactSection(section) {
  const path = pathOfSection(section);
  const config = path ? isConfigPath(path) : false;
  let inHunk = false;
  let inKey = false;
  let afterName = false;
  return section.split("\n").map((line) => {
    const hunk = /^(@@ [^@]*@@)(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      afterName = false;
      return hunk[1] + redactLine(hunk[2], { config, entropy: true, afterName: false });
    }
    const marker = line[0];
    if (!inHunk) return redactLine(line, { config: false, text: true, entropy: false, afterName: false });
    if (marker !== "+" && marker !== "-" && marker !== " ") return line;
    const content = line.slice(1);
    if (KEY_BEGIN.test(content)) inKey = true;
    if (inKey) {
      if (KEY_END.test(content)) inKey = false;
      return marker + TOKEN;
    }
    const out = marker + redactLine(content, { config, entropy: true, afterName });
    afterName = namesCredential(content);
    return out;
  }).join("\n");
}

export const redactDiff = (diff) => diff.split(/(?=^diff --git )/m).map(redactSection).join("");

export function redactText(text) {
  let afterName = false;
  return text.replace(KEY_BLOCK, TOKEN).split("\n").map((line) => {
    const out = redactLine(line, { config: false, text: true, entropy: false, afterName });
    afterName = namesCredential(line);
    return out;
  }).join("\n");
}
