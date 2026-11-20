// Writes one brief per work package from work-packages.tsv plus hand-written notes.
// Run from the repo root:  node .audit/ts-native/plan/briefs.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const countLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line !== "").length : 0);

const rows = readFileSync(".audit/ts-native/work-packages.tsv", "utf8").trim().split("\n").slice(1).map(line => {
  const [wave, wp, area, status, added, removed, path, tsModules = ""] = line.split("\t");
  return { wave: Number(wave), wp, area, status, added: Number(added), removed: Number(removed), path, tsModules };
});

const ORACLE = {
  language: ["understanding.rules", "understanding.filters", "understanding.chat", "understanding.sites", "language.i18n", "safety.privacy", "safety.verify", "safety.guard", "speech.phrasing"],
  personal: ["personal.commands"],
  welfare: ["agents.welfare.agent", "agents.welfare.discovery", "agents.welfare.rag"],
  webagent: ["agents.web.approval", "agents.web.auth_page", "agents.web.digest", "agents.web.effect"],
};

const NOTES = {
  language: {
    owned: ["src/understanding/**", "src/language/**", "src/safety/**", "src/speech/phrasing.ts", "the unit tests assigned to you"],
    notes: [
      "Everything here is regex and Korean text handling, so parity is the whole job. Follow the recipe's regex rules for every pattern, and compute expected matches by running the Python in the pyref environment.",
      "`understanding/rules.py` is the largest and most regex-dense file. `understanding/fastpath.py` is new. `understanding/llm_planner.py` and `understanding/understand.py` changed how the plan, the fast path and the rules fall back to each other. Read the Python diffs first.",
      "`safety/privacy.py`, `safety/guard.py` and `safety/verify.py` are safety rules. Port them exactly. Secret detection is rules only for PolicyGuard. Do not add the model-based PII path here, it is a separate decision. `src/safety/pii_model.ts` stays as it is.",
      "Existing oracle tests replay recordings made from the OLD Python. If one of them fails after you port a change, do not edit the fixture. Check that your port matches the Python source and tests, and list the failing oracle entries in your report. The integrator will replace the fixtures with ones regenerated from the current Python.",
      "`speech/phrasing.ts` is imported by almost every other package. Keep its exported names and signatures unless Python changed them.",
    ],
  },
  personal: {
    owned: ["src/personal/**", "src/orchestrator/first_run.ts", "src/orchestrator/speech_repair.ts", "the unit tests assigned to you"],
    notes: [
      "`personal/store.py` and `action_log.py` now write through `personal/atomic.py`. `guardian.py` is new (guardian contact and an approved SMS), and `commands.py` and `dialogue.py` changed. Read the Python diffs first.",
      "`src/personal/seal.ts` and `src/personal/credential_store.ts` are already done and tested. Do not edit them. Use the existing `Seal`.",
      "`orchestrator/first_run.py` is the first-run guide with its fixed sentences in four languages. Keep every sentence verbatim and keep the step order. It plugs into the session through `core/dialogue` state, which the core package already ported.",
      "Anything that sends a message (guardian SMS) must go through an injected sender so tests never send anything, and must run only after an approval, as in Python.",
    ],
  },
  welfare: {
    owned: ["src/agents/welfare/**", "src/evaluation/**", "welfare data files the Python package ships (copy by git, never retype)", "the unit tests assigned to you"],
    notes: [
      "`agents/welfare/open_data/` is new: datasets, places, links, programs and a sync tool. `agents/welfare/agent.py` gained regional directories, private-program datasets and the 'can I apply now' answer. `discovery.py` changed too.",
      "Welfare answers are grounded in official data only, with `usedChunkIds` and number checks. Do not loosen any of that.",
      "Data files. The Python package ships snapshots under `src/cheongeum/agents/welfare/open_data/snapshots/` and the repo has `welfare_catalog_checkpoint_2026-11-17/`. Copy what the code reads into the place the TypeScript code reads it (see `src/core/assets.ts`). Use `git show` or file copy. Never retype data.",
      "The sync tool (`open_data/sync.py`) fetches from public APIs. Port it so it takes an injected `fetch`, and test it with recorded responses. It must never run during tests.",
      "Korean dates and amounts are compared in the Korean calendar day. The TypeScript tip already has this. Keep it.",
    ],
  },
  webagent: {
    owned: ["src/agents/web/**", "src/speech/screen.ts", "src/speech/picture.ts", "the unit and browser tests assigned to you"],
    notes: [
      "This is the browser agent. `browser/__init__.py` (the Playwright adapter), `agent.py`, `autopilot.py` and `skills/browse.py` changed a lot. `link_choices.py`, `shot.py`, `visual_step.py` and `file_answer.py` are new. Port in dependency order. Leaf files first (auth_page, docs, playbook, link_choices, shot), then browser, effect, approval, downloads, then agent, visual_step, autopilot, then skills and speech/screen.",
      "The browser scripts injected into pages (`blocks.js`, `full_page.js`, the observe and cursor scripts) must be built from TypeScript at build time or loaded as the existing port does. Follow what `src/agents/web/browser/` already does.",
      "Safety rules are behavior. Approval fingerprints, the policy checks before every action, and re-observation after every action must match Python exactly.",
      "Browser tests use the shared practice-site port 5174. Run them only through the lock wrapper from the recipe.",
      "Picture and file understanding send content to a model only after the user confirms where it goes. Keep that order of checks.",
    ],
  },
  server: {
    owned: ["src/server/**, except app.ts, runtime.ts and main.ts which belong to a later package", "src/voice/**", "src/orchestrator/public_task.ts", "the unit tests assigned to you"],
    notes: [
      "These are the leaf pieces of the service: settings, key check, request policy, recovery and single writer, the workflow store with jobs and notes, public search, the live-audio and voice-edge bridges, the voice providers, and public-task routing. Build them as modules with clear inputs so the later runtime package can mount them. Do not edit `app.ts`, `runtime.ts` or `main.ts`.",
      "WebSockets. You MAY add `@hono/node-ws`. SQLite. Prefer the built-in `node:sqlite` if the Electron version this repo targets embeds a Node that has it (check `electron` in the desktop package before deciding), and say what you chose. PostgreSQL is optional, so load `pg` lazily and add it as an optional dependency. If a dependency is unavoidable, add it with `npm install --save-exact` and list it in your report.",
      "Owner decision: speech recognition is online for every language, Korean included. REMOVE `src/voice/stt_local.ts`, the `local` branch of `createVoiceProviders`, and the TypeScript tests that cover only local recognition (the six Python names in `.audit/ts-native/parity-exceptions.tsv`). Port `voice/config.py` as committed Python has it, API only. A legacy `STT_PROVIDER=local` value must use only the authenticated API, as `test_legacy_settings_use_only_authenticated_voice_apis` says. Keep `is_hallucination` and the other online-recognizer filters.",
      "Owner decision: no dedicated Ollama provider. The settings code and any provider list offer `openai` and `openai-compatible` only (`qwen` stays an alias). A stored `ollama` value is an unsupported provider, so there is no LLM.",
      "Jobs use leases, cancellation and restart. Port the store's behavior exactly, including how it opens an existing database and what it does with a corrupt one. Never create or modify a real user database in tests, always use a temp folder.",
      "Network providers must take an injected `fetch`. No test may reach the internet.",
    ],
  },
  session: {
    owned: ["src/orchestrator/session.ts", "src/orchestrator/replies.ts", "src/orchestrator/application.ts", "src/orchestrator/task_review.ts", "any new file you add under src/orchestrator/ for the session", "the tests assigned to you"],
    notes: [
      "This is the hardest package and the one everything else hangs on. `orchestrator/session.py` grew from 1,248 to 2,609 lines (154 changed hunks). The TypeScript port splits it across `session.ts`, `replies.ts` and `application.ts` (all three are mapped to `session.py` in the manifest). Keep that structure and extend it. `task_review.py` is new (381 lines).",
      "Read the repo-root `CLAUDE.md` first. Its section on `orchestrator/session.py` is the up-to-date description of the turn order and of what the session owns: redaction, stop before the queue, the call name, progress questions, secret detection, the first-run guide, vault and record commands, public-task judgment, short replies, understanding, the consent and stop gates, routing, the finish that validates a TurnResult, the offered choices, approval fingerprints and expiry, the auth hand-off resume, and the queue with its epoch. Then read the Python diff: `git diff 9842310 77aad3e -- src/cheongeum/orchestrator/session.py`, in passes, constants and routes first, then `OrchestratorDeps`, then the class body in file order.",
      "You start BEFORE the other wave-2 packages are merged. The modules you call (web skills, welfare agent, personal dialogue, first-run guide, public task, understanding, language) exist in your branch only in their OLD TypeScript form. Write your code against the Python signatures, converted by the naming rule in the recipe, and keep a list in a file `.audit/ts-native/session-needs.md` of every symbol you call that does not exist yet or whose signature you assumed. Typecheck will fail on those until the integrator merges the other packages and messages you. Do not stub them in other packages' files. A small local type in your own file is fine while you wait, but name it clearly so it can be removed.",
      "Behavior that must not drift: the order of the gates and checks in a turn, every spoken sentence, what is written to the history (secrets replaced by `[비공개]`), the epoch that voids queued turns, the two-minute approval expiry on the injected clock, and the rule that nothing risky runs without a go word.",
      "The first-run guide, public-task routing and guardian flow are separate modules owned by other packages. You own the hooks that call them and the state transitions through `core/dialogue`.",
      "`task_review.py` is the review loop for goal-mode work. Port it with its tests (`tests/unit/test_task_review.py` has 16 names to land, `tests/e2e/test_review_loop.py` 6, `tests/e2e/test_conversation.py` 5).",
      "Browser tests share port 5174. Use the lock wrapper from the recipe. The large end-to-end test set (362 names, owned by the runtime package) is ported after you and the runtime package land, but run the existing TypeScript end-to-end tests that cover the session often, and keep them green.",
    ],
  },
  runtime: {
    owned: ["src/server/runtime.ts", "src/server/app.ts", "src/server/main.ts", "src/practice_site/**", "the tests assigned to you"],
    notes: ["Wires everything. Details are written when the wave starts."],
  },
  scripts: {
    owned: ["scripts/**"],
    notes: ["Evaluation and tool scripts. Details are written when the wave starts."],
  },
};

mkdirSync(".audit/ts-native/briefs", { recursive: true });
const wps = [...new Set(rows.map(r => r.wp))];
for (const wp of wps) {
  const mine = rows.filter(r => r.wp === wp);
  const product = mine.filter(r => r.area !== "test");
  const tests = mine.filter(r => r.area === "test");
  const note = NOTES[wp];
  if (note === undefined) continue;
  const line = r => `| \`${r.path}\` | ${r.status} | +${r.added} -${r.removed} | ${r.tsModules === "" ? "none yet" : r.tsModules.split(",").map(m => `\`${m}\``).join(", ")} |`;
  const text = [
    `# Package brief: ${wp}`,
    "",
    `Wave ${mine[0].wave}. Read \`PORT-RECIPE.md\` first. It is your contract. This brief adds to it for your package.`,
    "",
    "## Branch and worktree",
    "",
    `Worktree \`C:\\Users\\user\\Desktop\\voice-welfare-ts-${wp}\`, branch \`migration/ts-native-${wp}\`. Both exist and \`npm ci\` is done. Use your own model name in the commit attribution line.`,
    "",
    "## Owned paths",
    "",
    ...note.owned.map(p => `- ${p}`),
    "",
    "## Work list",
    "",
    `${product.length} product files, ${product.reduce((s, r) => s + r.added, 0)} added lines.`,
    "",
    "| Python file | status | lines | existing TypeScript module |",
    "| --- | --- | --- | --- |",
    ...product.map(line),
    "",
    `${tests.length} test files, ${tests.reduce((s, r) => s + r.added, 0)} added lines. Port each into Vitest with the same test titles.`,
    "",
    ...tests.map(r => `- \`${r.path}\` (${r.status}, +${r.added} -${r.removed})`),
    "",
    ...(ORACLE[wp] === undefined ? [] : [
      "## Regenerated Python behavior for your modules",
      "",
      "The Python app was run again at 77aad3e and its recorded calls are in `C:/Users/user/Desktop/voice-welfare-ts-fixtures-77aad3e/`. Read the section 'What the porters should look at first' of `REPORT.md` there before you start. It lists the real drift, such as changed wording, renamed functions and new parameters.",
      "",
      `Your oracle files are \`oracle/<module>.jsonl\` for: ${ORACLE[wp].map(m => `\`${m}\``).join(", ")}. Copy them over the files of the same name in \`tests/fixtures/oracle/\` in your branch. You own those files. Update the matching \`tests/unit/*-oracle.ts\` implementation maps for functions that were renamed, removed or added, then make the oracle tests pass for your modules. Do not edit \`oracle/inventory.json\`, and do not touch the \`regex/\`, \`observations/\` or \`transcripts/\` fixtures. The integrator replaces those once, after the merges. A recorded call you cannot reproduce is a finding. Report it, do not edit the recording.`,
      "",
    ]),
    "## Test names you must land",
    "",
    `The Python test names that still have no TypeScript title for your package are listed in \`C:/Users/user/Desktop/voice-welfare-ts/.audit/ts-native/parity/${wp}.txt\` (${countLines(`.audit/ts-native/parity/${wp}.txt`)} names, one \`file::name\` per line). A name is done when a Vitest test has exactly that title. From your worktree run \`node scripts/test-parity.ts C:/Users/user/Desktop/voice-welfare-ts/.audit/ts-native/collect-77aad3e.txt\` and look for your names. Your package is done when none of them is printed.`,
    "",
    "## Notes for this package",
    "",
    ...note.notes.map(n => `- ${n}`),
    "",
    "## Success",
    "",
    "Typecheck, lint and the whole unit project are green except the one known test. Every Python test in your list has a same-titled Vitest test. `.audit/ts-native/manifest/" + wp + ".json` is written in your branch. Your final report follows the recipe's format and stays under 300 words.",
    "",
  ].join("\n");
  writeFileSync(`.audit/ts-native/briefs/${wp}.md`, text);
  console.log(`${wp}: ${product.length} product, ${tests.length} test rows`);
}
