import { collectDiff } from "./diff.js";
import { ownedFiles } from "./model.js";
import { withScratchDir } from "./scratch.js";
import { redactText } from "./redact.js";
import { parseSummary, summaryError, summaryFailure, summaryPrompt, summarySystem, trimDiff } from "./summary.js";
import { DEFAULT_LANGUAGE } from "./languages.js";
import { overviewPrompt, overviewSystem, parseOverview } from "./overview.js";
import { changeShapeOf, changeStats, summaryKeyOf } from "./changekey.js";

const DIFF_LIMITS = { tracked: 200, fresh: 5, lines: 60, chars: 6000, context: 2 };
const RUN_FROM_FILE = 'p=$1; shift; claude "$@" < "$p"';
const ISOLATED = ["--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--setting-sources", ""];

async function diffOf(git, state, owned) {
  const { tracked, untracked } = await collectDiff(git, { root: state.root, baseline: state.baseline, files: owned }, DIFF_LIMITS);
  return trimDiff(`${tracked}\n${untracked.join("\n")}`);
}

const ownedOf = (state) => ownedFiles(state.repo.files);

async function withPromptFile(exec, prompts, text, work) {
  await exec("mkdir", ["-m", "700", "-p", prompts.dir]);
  const file = `${prompts.dir}/prompt-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}.txt`;
  try {
    await prompts.write(file, text);
    return await work(file);
  } finally {
    await exec("rm", ["-f", file]).catch(() => null);
  }
}

export const SUMMARY_MODEL = "haiku";

const runClaude = ({ exec, prompts, model, system, prompt }) => {
  const args = ["-p", "--model", model, "--system-prompt", system, ...ISOLATED, "--tools", ""];
  return withScratchDir(exec, (dir) => withPromptFile(exec, prompts, prompt, (file) => exec("sh", ["-c", RUN_FROM_FILE, "sh", file, ...args], { cwd: dir })));
};

export async function summarizeRepo({ exec, git, state, prompts, model = SUMMARY_MODEL, language = DEFAULT_LANGUAGE }) {
  const owned = ownedOf(state);
  const key = summaryKeyOf(state, language);
  const shape = changeShapeOf(state, owned);
  const stats = changeStats(owned);
  try {
    const diff = await diffOf(git, state, owned);
    const prompt = summaryPrompt({
      name: redactText(state.repo.label),
      subjects: state.repo.subjects.map(redactText),
      files: owned.map((f) => ({ ...f, path: redactText(f.path) })),
      diff,
    });
    const reply = await runClaude({ exec, prompts, model, system: summarySystem(language), prompt });
    const parsed = reply.code === 0 ? parseSummary(reply.stdout) : undefined;
    return parsed ? { summary: { key, shape, stats, lang: language, ...parsed } } : { error: summaryFailure(reply) };
  } catch (e) {
    return { error: summaryError(e) };
  }
}

export async function summarizeOverview({ exec, prompts, model = SUMMARY_MODEL, input, language = DEFAULT_LANGUAGE }) {
  try {
    const reply = await runClaude({ exec, prompts, model, system: overviewSystem(language), prompt: redactText(overviewPrompt(input)) });
    const overview = reply.code === 0 ? parseOverview(reply.stdout) : undefined;
    return overview ? { overview } : { error: summaryFailure(reply) };
  } catch (e) {
    return { error: summaryError(e) };
  }
}
