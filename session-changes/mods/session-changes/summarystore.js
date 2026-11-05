const PREFIX = "session-changes.summary.";
const INDEX = `${PREFIX}index`;
const CAP = 40;

const bestEffort = (fn, fallback) => {
  try { return fn(); } catch { return fallback; }
};

export function createSummaryStore(storage, { cap = CAP } = {}) {
  const keyOf = (session, root) => `${PREFIX}${session}.${root}`;
  // Parsed summaries by the raw text they came from. Storage is read each time, because another copy of the mod may have written the slot,
  // but the JSON is parsed only when that text changed; set writes through.
  const parsed = new Map();
  const readIndex = () => bestEffort(() => JSON.parse(storage.getItem(INDEX)) ?? [], []);

  function get(session, root) {
    const key = keyOf(session, root);
    return bestEffort(() => {
      const raw = storage.getItem(key);
      if (raw === null || raw === undefined) { parsed.delete(key); return null; }
      const known = parsed.get(key);
      if (known?.raw === raw) return known.value;
      const value = JSON.parse(raw);
      parsed.set(key, { raw, value });
      return value;
    }, null);
  }

  function set(session, root, summary) {
    const key = keyOf(session, root);
    bestEffort(() => {
      const raw = JSON.stringify(summary);
      storage.setItem(key, raw);
      parsed.set(key, { raw, value: summary });
      const index = readIndex().filter((one) => one !== key);
      index.push(key);
      while (index.length > cap) {
        const old = index.shift();
        parsed.delete(old);
        storage.removeItem(old);
      }
      storage.setItem(INDEX, JSON.stringify(index));
    });
  }

  return { get, set };
}
