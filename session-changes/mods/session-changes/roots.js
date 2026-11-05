export const ROOTS_SCRIPT = [
  'for d; do p=$d;',
  'while [ ! -d "$p" ] && [ "$p" != / ]; do p=${p%/*}; [ -z "$p" ] && p=/; done;',
  'r=; cd -P "$p" 2>/dev/null && r=$PWD;',
  'q=$r; while [ -n "$q" ] && [ "$q" != / ] && [ ! -e "$q/.git" ]; do q=${q%/*}; [ -z "$q" ] && q=/; done;',
  'if [ -n "$q" ] && [ -e "$q/.git" ]; then printf "%s\\0%s\\0%s\\0%s\\0" "$d" "$p" "$r" "$q";',
  'else printf "%s\\0\\0\\0\\0" "$d"; fi; done',
].join(" ");

export function parseRootRecords(stdout) {
  const fields = stdout.split("\0");
  const roots = new Map();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [dir, existing, real, root] = fields.slice(i, i + 4);
    roots.set(dir, root ? { existing, real, root } : null);
  }
  return roots;
}

export function placeOf(dir, { existing, real, root }) {
  const below = real === root ? "" : real.slice(root === "/" ? 1 : root.length + 1);
  const missing = dir.slice(existing.length).split("/").filter(Boolean).join("/");
  const path = [below, missing].filter(Boolean).join("/");
  return { root, prefix: path ? `${path}/` : "" };
}
