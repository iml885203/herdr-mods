export const POLL_STEPS = [5000, 15000, 30000];
const IDLE_TICKS = 3;
const JITTER_MS = 250;

// How often the panel reads the session: the base timer fires every step[0], and this says whether a given firing should run.
// After IDLE_TICKS ticks with no transcript growth it moves to the next, slower step; growth or a manual refresh starts over.
export function createPacer({ steps = POLL_STEPS, idleTicks = IDLE_TICKS } = {}) {
  let level = 0;
  let idle = 0;
  let last = -Infinity;
  return {
    due: (now) => now - last >= steps[level] - JITTER_MS,
    started(now) { last = now; },
    settle(grew) {
      if (grew) { level = 0; idle = 0; return; }
      if (++idle >= idleTicks && level < steps.length - 1) { level++; idle = 0; }
    },
    reset() { level = 0; idle = 0; last = -Infinity; },
    interval: () => steps[level],
  };
}
