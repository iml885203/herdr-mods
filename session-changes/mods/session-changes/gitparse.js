export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function parseStatus(z) {
  const out = new Map();
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    out.set(entry.slice(3), entry.slice(0, 2));
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return out;
}

const RAW_HEADER = /^:\d{6} \d{6} /;

// `git diff --raw --numstat -z`: the raw records (`:modes shas LETTER`, then the path) come first, then the numstat ones (`added\tdeleted\tpath`).
export function parseDiffRaw(z) {
  const nameStatus = new Map();
  const numstat = new Map();
  const blobs = new Map();
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (RAW_HEADER.test(entry)) {
      const [, , , after, status] = entry.split(" ");
      const letter = status[0];
      if (i + 1 < parts.length) {
        const path = parts[++i];
        nameStatus.set(path, letter === "T" ? "M" : letter);
        // All zeros: git has not hashed the worktree file (it is not in the index), so there is no post-image id to carry.
        if (after && !/^0+$/.test(after)) blobs.set(path, after);
      }
    } else if (entry.includes("\t")) {
      const [added, deleted, ...rest] = entry.split("\t");
      numstat.set(rest.join("\t"), { added: Number(added) || 0, deleted: Number(deleted) || 0, binary: added === "-" });
    }
  }
  return { nameStatus, numstat, blobs };
}

// Each commit starts with \x01 and `<committer unix time> <subject>`; `ts` is null for a line without one.
export function parseLog(text) {
  return text.split("\x01").slice(1).map((chunk) => {
    const [first, ...rest] = chunk.split("\n");
    const stamped = /^(\d+) (.*)$/s.exec(first);
    return { subject: stamped ? stamped[2] : first, ts: stamped ? Number(stamped[1]) : null, files: rest.filter(Boolean) };
  });
}

// The probe is `HEAD|` plus one `path mtime:size` line per stat'ed file; this keeps the ones inside `root`, by relative path.
export function parseProbeStats(probe, root) {
  const stats = new Map();
  const prefix = `${root}/`;
  for (const line of probe.slice(probe.indexOf("|") + 1).split("\n")) {
    const cut = line.lastIndexOf(" ");
    const [mtime, size] = line.slice(cut + 1).split(":");
    if (cut > 0 && size !== undefined && line.startsWith(prefix)) stats.set(line.slice(prefix.length, cut), { mtime, size });
  }
  return stats;
}
