const ACTIONS = {
  j: "next", down: "next", k: "previous", up: "previous",
  enter: "activate", space: "activate",
  l: "expand", right: "expand", h: "collapse", left: "collapse",
  r: "refresh", p: "picker", s: "summarize", o: "open", d: "diff",
};

function escapeIntent({ picking, hasDiff, overlay }) {
  if (picking) return "closePicker";
  if (hasDiff) return "closeDiff";
  return overlay ? "closeWindow" : null;
}

export function intentOf({ key, modifiers, picking, hasDiff, overlay }) {
  const { platform, shift, control, alt } = modifiers;
  if (platform && !shift && !control && !alt && key === "enter") return "place";
  if (platform || control || alt) return null;
  if (key === "escape") return escapeIntent({ picking, hasDiff, overlay });
  const action = ACTIONS[key] ?? null;
  return picking && action !== "picker" ? null : action;
}
