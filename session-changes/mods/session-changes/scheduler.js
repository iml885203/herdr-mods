export const SUMMARY_CONCURRENCY = 2;
// A repo is settled when its probe has not changed for this long, or when the session has not touched it for this long. Time, not a count of ticks,
// because the number of ticks per minute depends on the polling pace and on the quiet-probe skip.
export const STABLE_MS = 25000;
export const TINY_CHANGE_LINES = 3;

function statsDistance(before, after) {
  let total = 0;
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [a1, d1] = before[path] ?? [0, 0];
    const [a2, d2] = after[path] ?? [0, 0];
    total += Math.abs(a2 - a1) + Math.abs(d2 - d1);
  }
  return total;
}

export const isTinyChange = (previous, shape, stats) => {
  if (previous?.shape !== shape || !previous.stats) return false;
  const distance = statsDistance(previous.stats, stats);
  return distance > 0 && distance < TINY_CHANGE_LINES;
};

export function createScheduler({ concurrency = SUMMARY_CONCURRENCY } = {}) {
  const seen = new Map();
  const running = new Set();
  const started = new Map();
  const finished = new Map();
  const forced = new Set();
  let candidates = [];
  let dead = false;

  const wanted = () => {
    const present = new Set(candidates.map((c) => c.root));
    const byForce = [...forced].filter((root) => present.has(root) && !running.has(root));
    const eligible = candidates.filter((c) =>
      !running.has(c.root) && !forced.has(c.root) && seen.get(c.root)?.stable && c.previous?.key !== c.key
      && finished.get(c.root) !== c.key && !isTinyChange(c.previous, c.shape, c.stats));
    return [...byForce, ...eligible.map((c) => c.root)];
  };

  function pick() {
    if (dead) return { start: [] };
    const free = Math.max(0, concurrency - running.size);
    const byRoot = new Map(candidates.map((c) => [c.root, c]));
    const start = wanted().slice(0, free).map((root) => ({ root, key: byRoot.get(root).key }));
    for (const { root, key } of start) { running.add(root); forced.delete(root); started.set(root, key); }
    return { start };
  }

  function tick(list, now = Date.now()) {
    if (dead) return { start: [] };
    const roots = new Set(list.map((c) => c.root));
    for (const root of [...seen.keys()]) if (!roots.has(root)) { seen.delete(root); finished.delete(root); started.delete(root); }
    for (const { root, probe, lastTs } of list) {
      let known = seen.get(root);
      if (!known || known.probe !== probe) { known = { probe, since: now, stable: false }; seen.set(root, known); }
      known.stable = now - known.since >= STABLE_MS || (Number.isFinite(lastTs) && now - lastTs >= STABLE_MS);
    }
    candidates = list;
    return pick();
  }

  function done(root) {
    if (dead) return { start: [] };
    running.delete(root);
    finished.set(root, started.get(root));
    return pick();
  }

  function manual(root, list) {
    if (dead) return { start: [] };
    candidates = list;
    if (candidates.some((c) => c.root === root) && !running.has(root)) forced.add(root);
    return pick();
  }

  function cancel() {
    dead = true;
    running.clear();
    forced.clear();
  }

  const idle = () => running.size === 0 && wanted().length === 0 && [...seen.values()].every((s) => s.stable);

  return { tick, done, manual, cancel, idle };
}
