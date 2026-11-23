# How Cheongeum handles a public-service request

A local Hono server runs the TypeScript service, and one `SessionOrchestrator` per session owns the current task and its permissions. The user can switch between speech and text, correct a service name, change languages, or stop an action. Every model is hosted by OpenAI.

| Role | Model | What it does |
| --- | --- | --- |
| Voice | `gpt-live-1.1` | Conversation mode and every spoken output |
| Agent (Sol) | `gpt-6.2-sol` | Understanding, planning, browsing goals and file answers |
| Utility (Luna) | `gpt-6-luna` | The effort rating for a voice request and the research coverage check |
| Vision (Terra) | `gpt-6.1-terra` | Masked screenshots |
| Recovery (Astra) | `gpt-6.2-astra` | One recovery attempt after repeated failures |
| Transcription | `gpt-transcribe` | One-shot microphone input and recorded files |
| Embedding | `text-embedding-3-small` | Saved notes |
| Moderation | `omni-moderation-latest` | Delegated research |

Environment settings can override each role. [Model roles](../src/core/model_stack.ts) · [Runtime](../src/server/runtime.ts)

## The path from speech to an answer

| User request | What runs | What the user gets |
| --- | --- | --- |
| Say hello in conversation mode | The app sends microphone audio to GPT-Live over WebRTC. The API key stays in the local server. | GPT-Live answers directly in speech. |
| “국가장학금 신청 서류만 알려줘. 로그인은 건너뛰고.” | GPT-Live delegates the request to the session. Sol receives the request, language, recent public-service turns and exclusions. The session selects the catalog, the official API when one is configured, or the browser. | An answer based on observed evidence. Missing evidence can lead to a targeted question, a partial answer, or an incomplete result. |
| “Did you mean 등본 or 초본?” followed by “초본” | The session carries the pending question and the selected document into the next decision. Korean, English, Chinese, Japanese and mixed-language requests use the same decision schema. | The lookup continues for the selected document. The user can also change agency or cancel. |
| Explain the current page or a part of it | After consent, Cheongeum checks the question against the page text, accessible labels, and the selected or pointed-at item. When the answer needs visual evidence, it sends Terra a masked screenshot with the page text, the question and up to three recent requests. Users can ask for text only. | A spoken answer about the relevant item, or a question that identifies which part the user means. |
| Read the page aloud or repeat the guide | The app reads the requested passage or guide. | The user can continue reading from the previous passage. |
| A public page has two links and the useful one cannot be identified from its text | The visual path asks for one-time permission to send a masked screenshot to Terra. A proposed choice must map to one observed control. The browser checks the target again before it acts. | A verified next step, or a handoff when the same control cannot be found. |
| A lookup repeatedly fails to support its answer | After repeated failures to ground an answer or find the next useful step, Sol can hand the evidence to Astra for one recovery attempt within the original allowance. | A sourced result or an account of what is still missing. |
| Transcribe a recording | The user chooses a file and sends it to `POST /api/audio/transcribe`. The endpoint checks session consent and returns redacted text. | A transcript to read or copy. Sending a recording does not run the spoken commands. |

GPT-Live handles natural conversation and interruptions. One-shot microphone input goes through the local server to `gpt-transcribe`. Every spoken output uses GPT-Live with the Coral profile in `src/core/voice_profile.json`, including read-aloud, the first-use guide and the setup recordings bundled for use before a key exists. For government data, an enabled official welfare API or the packaged public directory can answer a suitable request before the browser runs. The browser path prefers page text and accessibility controls. Stagehand v4 finds and acts on page elements by default (`BROWSER_DRIVER`), and Playwright launches Chromium and manages contexts. [Voice edge](../src/server/voice_edge.ts) · [Public intake](../src/orchestrator/public_task.ts) · [Browser worker](../src/agents/web/autopilot.ts)

## Review before speaking

Sol can choose `review_before_output` for a sequence of browser actions or a question that needs several sources. The session keeps the original request, its conditions, verified action receipts, observed pages and quoted source passages. After each work pass, Sol checks the requested outcomes against that evidence. A missing item can go back to the browser, welfare information, the public directory or quiet search. Each retry draws on the same allowance. The session speaks the verified final answer, asks for required input, or reports what it could not verify.

For a voice request, GPT-Live's Decisions channel asks Luna to rate the effort as easy, medium or hard. The session maps that rating to the limits below. For typed requests, or when the voice rating is missing, Sol rates the task during intake. The default is medium. One review round is one evaluation of the evidence so far. Browser iterations include planning decisions that read or search the current page without a click. [Review loop](../src/orchestrator/review_loop.ts)

| Difficulty | Maximum review rounds | Total browser iterations | Total browser actions |
| --- | ---: | ---: | ---: |
| Easy | 2 | 8 | 8 |
| Medium | 3 | 16 | 16 |
| Hard | 5 | 32 | 32 |

An approval pauses execution with its remaining allowance. The session checks the current record and target again before it acts. Users can interrupt or ask for progress at any time. A repeated search that finds no new evidence ends early.

## Work that continues after a voice session

A user who chose a personal device can delegate a public research question and see its status in the desktop workspace. The worker opens its own headless browser. Its guard permits public reads and search only. It has no personal browser cookies, form permissions, guardian contact or private download folder. Closing the session leaves the job saved, and the next app start resumes eligible work. Workers claim jobs with leases, discard late results from a lost claim, and cap retries. A changed request needs a new decision from the user. [Workflow service](../src/server/workflows.ts) · [Queue and notes](../src/server/workflow_store.ts)

Saved notes belong to the local OS user's installation, and the user saves each one explicitly. Text embeddings let a note match a question in another language. Keyword matching still works when embeddings are unavailable. Relevant notes can inform Sol's next decision as user context only. The portal or official record still supplies the facts, and the user still grants any required permission. The user can list or delete saved notes. The original instruction, transcript and browser history do not become notes automatically. Moderation screens delegated research when it is available. The policy guard checks every proposed browser action on its own.

Before the worker marks research complete, Luna checks whether the cited passages answer every part of the original question, and the worker checks each quote against the observed text. For example, a scholarship notice that explains how to check the required documents is only a partial answer to “How do I submit them?” If the check is unavailable, the user can still read the partial result and its sources.

The installed app stores jobs and notes in SQLite. Operators can set `CHEONGEUM_DATABASE_URL` to use PostgreSQL with pgvector. Both backends run the same queue and workspace API. The worker runs inside the app process. [Installation](install.md)

## Verification

| Check | What it establishes |
| --- | --- |
| `npm run test:unit` and `npm run test:e2e` | Approval binding, stop and reconnect behavior, multi-agency routing, visual consent, evidence checks, and the worker and recording contracts |
| `node scripts/eval-public-tasks.ts --model gpt-6.2-sol` | Real-provider intake decisions, latency and token use for a synthetic four-language corpus. The score measures intake only. |
| `npm run test:desktop-installed -- "<path to 청음.exe>"` | A smoke test of the installed app from a new user profile |
| `npm run test:desktop-release` | Updater download and integrity check against a loopback release feed. Set `CHEONGEUM_TEST_DIST` when the build goes to a version-specific folder. |

The intake corpus covers five portal journeys: government certificates at 정부24, scholarships at 한국장학재단, civil petitions at 국민신문고, employment services at 고용24 and welfare assistance at 복지로. A successful navigation reaches an observed agency page. An answer about a fee, deadline or eligibility rule also needs supporting source text. A portal outage or an ambiguous certificate name can still prevent completion.

The English, Chinese and Japanese strings still need native review ([string review](l10n-review.md)). A trial with physical microphones and screen-reader users is also still needed ([user test plan](user-test/plan.md)).
