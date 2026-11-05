export async function makeScratchDir(exec) {
  const made = await exec("mktemp", ["-d"]);
  const dir = made.stdout.trim();
  if (made.code !== 0 || !dir) throw new Error("could not create a scratch folder");
  return dir;
}

export const removeScratchDir = (exec, dir) => exec("rm", ["-rf", dir]).catch(() => null);

export async function withScratchDir(exec, work) {
  const dir = await makeScratchDir(exec);
  try { return await work(dir); } finally { await removeScratchDir(exec, dir); }
}

// One folder made on first use and kept until dispose; a failed attempt is forgotten so the next call tries again.
export function lazyScratchDir(exec) {
  let pending = null;
  return {
    get() {
      if (pending === null) {
        const attempt = makeScratchDir(exec);
        pending = attempt;
        attempt.catch(() => { if (pending === attempt) pending = null; });
      }
      return pending;
    },
    async dispose() {
      if (pending === null) return false;
      const dir = await pending.catch(() => null);
      pending = null;
      if (dir) await removeScratchDir(exec, dir);
      return true;
    },
  };
}
