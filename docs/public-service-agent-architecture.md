# How Cheongeum handles a request in desktop 0.4.0

Cheongeum uses the voice, reasoning, visual, transcription and memory models from the reference stack. A local FastAPI session owns the current task and its permissions. The user can switch between speech and text, correct a service name, change languages, or stop an action. [Model registry](../src/cheongeum/core/model_stack.py) · [Reference stack](pickle_like_agent_model_stack.md)

## The path from speech to an answer

| User request | What runs | What the user gets |
| --- | --- | --- |
| Say hello in conversation mode | Electron sends microphone audio to GPT-Live over WebRTC. The API credential stays in the local backend. | GPT-Live answers directly in speech. |
| “국가장학금 신청 서류만 알려줘. 로그인은 건너뛰고.” | GPT-Live delegates. Its private backend connection matches the delegation to transcript events. Sol receives the request, language, recent public-service turns and applicable exclusions. The local session selects the catalog, official API when configured, or browser. | A response based on observed evidence. Missing evidence can lead to a targeted question, a partial answer, or an incomplete result. |
| “Did you mean 등본 or 초본?” followed by “초본” | The session carries the pending question and the selected document into the next decision. Korean, English, Chinese, Japanese and mixed-language requests use the same decision schema. | The lookup continues for the selected document. The user can also change agency or cancel. |
| Explain the current page or a part of it | After consent, Cheongeum checks the question against the page text, accessible labels, and the selected or pointed-at item. When the answer needs visual evidence, it sends Terra a masked full-page screenshot with page text, the question and up to three recent user requests. Users can ask for text only. | A spoken answer about the relevant item, or a question to identify which part the user means. |
| Read the page aloud or repeat the guide | The app reads the requested passage or guide. | The user can continue reading from the previous passage. |
| A public page has two links and the useful one cannot be identified from its text | The visual path asks for one-time permission to send a masked screenshot to Terra. A proposed choice must map to a unique observed control. The driver checks the target again before acting. | A verified next step, or a handoff when the same control cannot be found. |
| A lookup repeatedly fails to support its answer | After repeated failures to ground an answer or discover the next useful step, Sol can hand the evidence to Astra for one recovery attempt within the original allowance. | A sourced result or an account of what is still missing. |
| Transcribe a recording | The user chooses a file and explicitly sends it to GPT-Transcribe. The dedicated recording endpoint checks session consent and returns redacted text. | A transcript to read or copy. Sending a recording does not execute the spoken commands. |

GPT-Live handles natural conversation and interruptions. One-shot microphone input uses keyed GPT-Live-Transcribe. The first-use guide and exact confirmations use the configured keyed speech synthesizer. For government data, an enabled official welfare API or packaged public directory can answer a suitable request before browser automation. The browser path favors page text and accessibility controls. Luna handles bounded tasks such as rephrasing. [Voice edge](../src/cheongeum/server/voice_edge.py) · [Public intake](../src/cheongeum/orchestrator/public_task.py) · [Browser worker](../src/cheongeum/agents/web/autopilot.py)

## Review before speaking

Sol can choose `review_before_output` for a sequence of browser actions or a question that needs several sources. The session keeps the original request, its conditions, verified action receipts, observed pages and quoted source passages. After each work pass, Sol checks the requested outcomes against that evidence. A missing item can go back to the browser, welfare information, the public directory or quiet search. Each retry draws on the same allowance. The session speaks the verified final answer, asks for required input, or reports what it could not verify.

GPT Live's Decisions channel supplies a per-request effort rating. The session maps low, medium and high to the limits below. For typed requests or a missing voice rating, Sol rates the reviewed task during intake. The default is medium. One review round is one evaluation of accumulated evidence. Browser iterations include planning decisions that read or search the current page without clicking.

| Difficulty | Maximum review rounds | Total browser iterations | Total browser actions |
| --- | ---: | ---: | ---: |
| Easy | 2 | 8 | 8 |
| Medium | 3 | 16 | 16 |
| Hard | 5 | 32 | 32 |

An approval pauses execution with its remaining allowance. The session checks the current record and target before it acts. Users can interrupt or ask for progress throughout. A repeated search that produces no new evidence ends early.

## Work that survives a voice session

A user who has selected a personal device can delegate a public research question and see its status in the desktop workspace. The worker opens a fresh headless browser context. Its guard permits public reads and search. It has no personal browser cookies, form permissions, guardian integration or private download directory. Session closure leaves the durable job available, and reopening the application resumes eligible work. A closed desktop application resumes work when it next runs. Workers claim jobs using leases, fence late results with the claim token, and cap retries. A new user decision is required to change an incomplete request. [Workflow service](../src/cheongeum/server/workflows.py) · [Queue and notes](../src/cheongeum/server/workflow_store.py)

Explicitly saved notes are scoped to the local OS user's installation. Text embeddings support semantic retrieval across languages. Keyword matching remains available when vector retrieval is unavailable. Relevant notes can inform Sol's next decision. They provide user context only. The portal or official record still supplies the facts, and the user still grants any required permission. The user can list or delete saved notes. The original instruction, transcript and browser history do not automatically become notes. Targeted moderation screens delegated research when available. The policy guard checks every proposed browser action independently.

Before marking research complete, the worker asks Luna whether the cited passages cover the original question, then checks each supporting quote against the observed text. For example, a scholarship notice that explains how to check which documents are required gives only a partial answer to “How do I submit them?” If verification is unavailable, the user can still read the partial result and its sources.

The standalone installer uses SQLite to support personal-device jobs and notes without infrastructure. Operators can select PostgreSQL with pgvector through `CHEONGEUM_DATABASE_URL`. The same queue and workspace API run on both backends. The shipped worker lives with the app process. Outbound SIP calls and a continuously hosted worker are deployment extensions described in the reference. [Installation](install.md)

## Verification

| Check | What it establishes |
| --- | --- |
| `uv run pytest` | Approval binding, stop and reconnect behavior, multi-agency routing, visual consent, evidence checks, and local worker and recording contracts. |
| `uv run python scripts/eval_public_tasks.py --model gpt-6.2-sol` | Real-provider intake decisions, latency and token usage for a synthetic four-language corpus. The score measures intake only. |
| `npm --prefix apps/desktop run test:installed -- "<path to 청음.exe>"` | First-run configuration, quiet relaunch, explicit guide replay and keyed speech through the packaged app. |
| `npm --prefix apps/desktop run test:release` | Updater download and integrity verification against a loopback release feed. Set `CHEONGEUM_TEST_DIST` when building into a version-specific directory. |

The five portal journeys used in development are government certificates at 정부24, scholarships at 한국장학재단, civil petitions at 국민신문고, employment services at 고용24 and welfare assistance at 복지로. A successful navigation is an observed agency page. An answer about a fee, deadline or eligibility rule also needs supporting source text. A portal outage or ambiguous certificate name can still prevent completion.

The Windows 0.4.0 package passed first-run setup, a quiet restart, explicit guide replay, recorded-file transcription and spoken clarification using test audio devices. The release-feed check downloaded the installer and verified its SHA-512 digest. The primary controls and example requests were exercised in all four languages. Some specialist panels use Korean. A trial with physical microphones and screen-reader users is still needed to evaluate accessibility in everyday use.

In a November 19 development run with the 0.4.0 decision schema, Sol returned the expected first decision in 18 of the 20 cases. Both remaining cases resolved after one scripted clarification. Median first-decision latency was 2.24 seconds and p95 was 2.97 seconds. The benchmark made 22 Sol requests. These measurements exclude voice transport and portal loading. A separate Chromium test used synthetic English audio, English onboarding and the real GPT-Live connection to open 한국장학재단 and deliver the spoken result in roughly 17 seconds including session startup and navigation.
