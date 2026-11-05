export function createGate(limit) {
  let running = 0;
  const waiting = [];
  return async function run(job) {
    if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}
