const BLOCK = 65536;
const CONSUMED = "\x01CONSUMED ";

export function chunkPlan(offset, size) {
  const lead = offset % BLOCK;
  return { skip: (offset - lead) / BLOCK, count: Math.floor((lead + size) / BLOCK) + 1, lead };
}

export function parseChunk(stdout) {
  const at = stdout.lastIndexOf(CONSUMED);
  if (at < 0) return { text: "", consumed: 0 };
  return { text: stdout.slice(0, at), consumed: Number(stdout.slice(at + CONSUMED.length)) || 0 };
}

export function parseWc(output) {
  const sizes = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+) (.+)$/.exec(line);
    if (match && match[2] !== "total") sizes.set(match[2], Number(match[1]));
  }
  return sizes;
}
