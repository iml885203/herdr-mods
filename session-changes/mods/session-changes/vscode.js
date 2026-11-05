export function createVscode(exec, git) {
  async function launch(args) {
    try {
      const result = await exec("code", args);
      return result.code === 0 ? "" : `code failed: ${result.stderr.trim()}`;
    } catch (e) {
      return `code failed: ${e?.message ?? e}`;
    }
  }

  async function hasCode() {
    const found = await exec("which", ["code"]).catch(() => ({ code: 1 }));
    return found.code === 0;
  }

  const openFile = (root, path) => launch([`${root}/${path}`]);

  async function openDiff(root, baseline, file) {
    if (file.status === "D") return openFile(root, file.path);
    if (file.secret) return "Secret file: not copied to disk for a diff";
    try {
      const base = await git.baseVersionFile(root, baseline, file.path);
      return base ? launch(["--diff", base, `${root}/${file.path}`]) : "Could not read the base version";
    } catch (e) {
      return `code failed: ${e?.message ?? e}`;
    }
  }

  return { hasCode, openFile, openDiff };
}
