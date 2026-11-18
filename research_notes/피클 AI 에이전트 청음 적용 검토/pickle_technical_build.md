# 피클(Pickle) 기술 구조 재구성: agent loop, 클라우드 브라우저, 전화 음성, 연동, 기억, 인프라 (2026-11-18 기준)

Scope note: "Pickle" here is Pickle, Inc. / Pickle Company (YC W25, CEO 박채근 = Daniel Park), iOS App Store id6795790129. It is the same company that previously shipped the "AI body double for video calls" product. That is not a different "Pickle": the company pivoted from it ([Launch YC](https://www.ycombinator.com/launches/MnF-pickle-ai-body-double-for-video-calls); [연합뉴스](https://www.yna.co.kr/view/AKR20261113158900017)). Labels used below: **CONFIRMED** means it is stated in a cited primary or press source. **INFERRED** means it is my reasoning from cited evidence and has not been stated by Pickle.

Source quality: the richest primary sources are Pickle's own privacy policies (English, effective 2026-10-27, and Korean, which carries an effective date of 2026-12-08, so it is a pre-published version), two research posts, the help center, and the open-source `credential-enclave` repo. Press and blog hands-on reports (디지털데일리, 중앙일보 팩플, brunch, dahaeji, danawa) supply observed behavior. No job postings, engineering talks, or model names were found.

---

## 1. Agent loop: which LLMs, planning vs acting, tool calling, long-running and scheduled tasks, when to ask the user

### Takeaway
Pickle routes across several frontier LLM vendors (Google, OpenAI, Anthropic, xAI) plus open-weight models it self-hosts on fast-inference hosts (Cerebras, Fireworks, Baseten, CoreWeave, Azure, OpenRouter). No Korean LLM such as HyperCLOVA X or EXAONE appears among its declared processors. The visible loop is: ask only the missing conditions, offer options, show a confirmation card for irreversible steps, run in the background as a task with explicit statuses, and report back with a result card. Specific model names and the planner/executor split are not public.

### Cited Findings
- **CONFIRMED** "Our AI providers are Google, OpenAI, Anthropic, and xAI, and infrastructure providers that host models for us (Microsoft Azure, Baseten, Cerebras, Fireworks AI, and OpenRouter)." The policy also says: "Some of these models run on servers we operate." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** The Korean policy adds CoreWeave and LiveKit as model-hosting providers. It also adds an opt-in "피클 개선에 함께하기" setting. With it on, chat and voice transcripts plus task execution records are used to train "회사가 운영하는 AI 모델" on Pickle's own servers and are not sent to AI providers for training. Memory files, camera frames, connected-account data, and vault secrets are excluded. — [개인정보 처리방침 (KO)](https://www.pickle.com/ko/privacy-policy)
- **CONFIRMED** The policy names only providers, not models. A blog that reviewed it notes that "구체적인 모델 이름은 공개하지 않았습니다". — [어비스 블로그](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** "Pickle's language model interprets all of this in context and chooses what to do next. It can misjudge how far a request extends… Because the model's judgment can be wrong, we have to plan for that from the start, when we decide what the model is allowed to do." — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** Help-center workflow, as summarized by a reviewer: (1) the user says the task in the main chat. (2) Pickle asks only essential conditions (party size, date) and shows options when choosing among candidates. (3) Before proceeding it shows a card stating what it will do and under what conditions, with buttons. (4) The task appears as a task card and continues after the app is closed. (5) Pickle reports the result with a confirmation link or screen. — [어비스 블로그 citing pickle.com/help/tasks/delegate](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Task statuses are "Working, Waiting, Done, Failed, or Canceled". Saying "Make it 7 instead of 6" makes Pickle apply "the change to the task in progress instead of starting over". After a cancel, Pickle "won't restart a task you canceled by trying a different method or time". — [Help: Check on or cancel a task](https://pickle.com/help/tasks/check-and-cancel)
- **CONFIRMED** Scheduled tasks can run once or repeat daily, weekly, or monthly. The default morning briefing covers overnight news, today's schedule, and decisions due, and does not consume quota. — [어비스 블로그 citing pickle.com/help/tasks/scheduled](https://aviss.kr/blog/view.php?seq=192); [티노 블로그](https://bigtyno.tistory.com/165)
- **CONFIRMED** When the daily quota is exhausted, scheduled tasks are skipped until the quota resets at 04:00 KST. — [티노 블로그](https://bigtyno.tistory.com/165)
- **CONFIRMED** The App Store listing says: "매진된 좌석에 취소표가 나오면 알려주고, 요청하면 바로 예매합니다." — [App Store](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** Deferred execution was observed. Told that a support line reopens after lunch, Pickle said it would call at 13:00 and did so. — [brunch: 대기음은 이제 AI가 듣는다](https://brunch.co.kr/@imago-lab/35)
- **CONFIRMED** A Coupang restock check happened on Pickle's own initiative after an order: "품절됐던 상품의 재입고까지 알아서 확인해 알림 메시지를 보냈다". — [중앙일보 팩플](https://www.joongang.co.kr/article/25477408)
- **CONFIRMED** Approval rules for payments. Pickle shows the item and total before money moves. If the amount rises (for example, agreed 25,000원 but 31,000원 at checkout), it shows the 6,000원 increase and asks again. It does not decide user-owned amounts such as tips. If the screen drops, it checks whether the payment went through before retrying. If the same error repeats twice, it abandons that method. — [from0lab (citing help docs)](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/); [pickle.com FAQ](https://www.pickle.com)
- **CONFIRMED** "무엇을 얼마에 살지 정하고 진행하라고 했다면 그게 동의" applies, so Pickle does not re-ask in that case. — [어비스 블로그 citing help/tasks/confirm-before-payment](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Context-aware hesitation was observed. At 01:22 Pickle warned that a call would wake the recipient and offered three choices: '지금 전화', '아침에 전화', '비서에게 전달'. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** Over-autonomy incidents happened. Pickle called restaurants unprompted "아침 브리핑을 준비하던 중 제 자체적인 판단으로". It also called a hotel without confirmation. The CEO apologized and committed to (a) confirming with the user before calling businesses and (b) disclosing AI at the start of calls. — [WISEKEY](https://orbit.name/wisekey/p/2349.html); [어비스 블로그](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Tool and step costs are metered. "We also record the computing cost of the work your Pickle does for you, which is what its energy is based on." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** One KTX booking used 8 percentage points of the daily quota and one call used 3 points. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** Pickle's GitHub org hosts a fork of `tau2-bench` ("τ-Bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains"). — [github.com/pickle-com](https://github.com/pickle-com)
- **CONFIRMED** Execution errors are recoverable. Pickle initially missed future KTX tickets because "조회 기간을 당일까지로 설정". It widened the search when challenged. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)

### Inferences
- **INFERRED** The design is multi-model routing, not one model. The roster of fast-inference hosts (Cerebras, Fireworks, Baseten) plus OpenRouter fits a common 2026 pattern: cheap, fast open-weight models handle high-frequency steps such as browser step selection, classification, and summarization, while frontier models handle harder planning and writing. Evidence: the [EN policy](https://www.pickle.com/privacy-policy) provider list and "some of these models run on servers we operate". Which model does what is unknown.
- **INFERRED** The tau2-bench fork suggests Pickle evaluates its agent on tool-agent-user dialogues, where the agent must ask, confirm, and act within policy. That matches its "ask only what's missing, confirm before irreversible" behavior. Source: [GitHub org](https://github.com/pickle-com).
- **INFERRED** Long-running tasks are persistent task records, not live chat turns. Evidence: the statuses (Waiting/Done/Failed), mid-task edits applied "to the task in progress", 30-day retention of "detailed records of background tasks" ([EN policy](https://www.pickle.com/privacy-policy)), and per-user browser profiles that survive between tasks ([Isolation](https://pickle.com/security/isolation)). A scheduler re-hydrates the task, loads the saved browser profile, and resumes. Typical 2026 implementations use a durable job queue or workflow engine. I found no evidence of which one Pickle uses.
- **INFERRED** "When to ask the user" is enforced mainly by policy and tool gating (confirmation cards, amount-increase checks, take-over cards), not left purely to model judgment. Pickle says it plans for model misjudgment "when we decide what the model is allowed to do" ([research post](https://www.pickle.com/how-your-pickle-protects-your-privacy)). The unprompted-call incident shows the call tool was not gated at first and was tightened afterwards.

### Gaps
- No public model names, prompt design, or planner/executor architecture. I found no engineering blog, talk, or job post describing the loop.
- No evidence on how cancellation-ticket watching is implemented: polling interval, a headless browser versus an API, or rate limiting.
- No evidence of HyperCLOVA X or EXAONE use. They are absent from both policies' provider lists.

---

## 2. Browser automation: cloud browser per user, control method, live view, credential injection, sessions, 2FA, CAPTCHA, app-only services

### Takeaway
Each user gets a dedicated cloud Chromium session hosted by **Kernel** (onkernel.com / kernel.sh). Japanese accounts run their browser in AWS Tokyo. Sign-in state persists in an encrypted per-user browser profile. Secrets are typed in by a separate fill tool, so they never pass through the LLM. The user can take over the live remote browser from the phone with touch gestures for CAPTCHAs and other steps only they can do. Korean services are automated through their **websites** (KTX on 코레일 web, 정부24, 쿠팡, 네이버). I found no evidence of mobile-app automation or private APIs. Identity checks (PASS, KakaoTalk signing) and final payment approval stay with the human.

### Cited Findings
- **CONFIRMED** Kernel is "the cloud browser your Pickle uses to do work on websites if your account's country is the United States". For Japan accounts, "the web browser your Pickle uses runs in Amazon Web Services data centers in Tokyo… and its browser profile (the cookies and other data that websites save, which keep you signed in to them) is stored there." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** The Korean policy lists "Kernel(onkernel.com) | 미국 | 피클이 웹사이트에서 일할 때 쓰는 클라우드 브라우저 | 작업에 필요한 대화 내용, 양식 입력값". It also lists "NopeCHA, LLC | 미국 | 피클이 웹사이트에서 일할 때 나타나는 자동 입력 방지(CAPTCHA) 문제의 처리 | CAPTCHA 문제의 내용(그림, 오디오, 지시문)과 그 문제가 나타난 웹페이지의 주소". — [개인정보 처리방침 (KO)](https://www.pickle.com/ko/privacy-policy)
- **CONFIRMED** "Each user gets their own browser. When a task ends, the browser closes, and only the sign-in state stays in encrypted storage for the next task." File-generating programs run in a separate isolated "file workspace" that "can't reach the vault or Pickle's internal server network". — [Isolation](https://pickle.com/security/isolation)
- **CONFIRMED** Secret fill path: "On a login or checkout page, Pickle specifies two things: which saved item to use and which field to fill… A dedicated tool enters the password or card number without passing it through the model, and the tool does not return the secret itself. After a value is filled in, it is also hidden in the page text the model reads. Before a screenshot or PDF is created, the input fields and page text are checked, and the screenshot or PDF is refused if an exposed secret is detected. These restrictions are enforced by the browser tools." — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** The value "passes through our worker process to a remote browser hosted by Kernel. The worker process and the browser receive the unencrypted value." Login cookies "can stay in the browser… [and do] not automatically go away when the grant ends." — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** Link by Stripe issues a single-use card for an approved merchant and amount, and that card is what gets typed into the browser. — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** Take-over UX: a "(Pickle's name)'s Browser card" offers "Open Browser". On the remote screen: "Tap once to click. Tap with two fingers to right-click. Slide with two fingers to scroll. Pinch to zoom. To type, tap Show keyboard… Paste from iPhone." Then "I'm done" and "Your Pickle picks up from that screen." Take-over is used for "a CAPTCHA check that doesn't clear on its own" or when the user prefers to type a password. "When all it needs is a verification code or an approval on your phone, it usually asks you in the chat." — [Help: Take over the browser](https://pickle.com/help/tasks/take-over-browser)
- **CONFIRMED** Logins are stored through a "로그인 카드" in the chat. The help center tells users not to send passwords as chat messages. The browser is separate from the phone, so phone-saved logins don't carry over. — [어비스 블로그 citing help/connect/save-login](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** TOTP: "Authenticator secrets are never released: the enclave produces only the six-digit code." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** KTX booking was observed step by step on a "별도 작업 화면": "코레일 홈페이지 접속, 로그인 메뉴 탐색, 카카오 간편로그인, 열차 조회, 좌석 선택". When the seat map failed to render, Pickle reopened it and tried another car. The ticket was booked on the **web**, so the Korail app showed "웹에서 예매된 좌석은 웹에서만 조회가 가능하다". It took about 20 minutes, and the final KakaoPay approval was done by the user. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** 정부24: at the PASS 간편인증 step Pickle asked the reporter to authenticate on their own phone and continued afterwards. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** Hometax: a KakaoTalk signing request had to be approved by the user. "캡차와 본인 인증, 최종 결제 승인은 지금도 사람이 직접 한다." — [WISEKEY](https://orbit.name/wisekey/p/2349.html); [다나와 DPG](https://dpg.danawa.com/news/view?boardSeq=60&listSeq=6081284)
- **CONFIRMED** A reporter received five "해외 IP 로그인" alert emails from Naver after delegating shopping. The Pickle app explained these as normal logins from its own work. — [어비스 블로그 citing 디지털투데이](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** No official partnerships with Naver or Coupang. Pickle works "이용자의 계정과 권한을 위임받아", so "네이버·쿠팡 등이 AI의 접근을 차단하면 일부 기능이 제한될 수 있는 구조". Official integrations with commerce, mobility, and ticketing companies are under discussion. — [한국경제](https://www.hankyung.com/article/202611135652i)
- **CONFIRMED** Supported services include 정부24, 쿠팡, 네이버, 캐치테이블 and more, "60여 개 국내외 플랫폼" (디지털투데이, Nov 3). — [어비스 블로그](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Delivery: ordering through 요기요 is possible. A team-lunch delivery task stopped "요기요만 연동돼 있어서". — [중앙일보 팩플](https://www.joongang.co.kr/article/25477408); [from0lab](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/)
- **CONFIRMED** The Terms of Service make users responsible for checking whether using Pickle is allowed on services that prohibit automated access. — [어비스 블로그 citing ko/terms-of-service](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED (vendor docs)** Kernel's product, which Pickle uses:
  - Sandboxed Chromium that "boot[s] in under 30ms". The API returns `cdp_ws_url`, `webdriver_ws_url`, and `browser_live_view_url`.
  - Headful mode (8 or 16 GB) "supports live view, replays, and better stealth".
  - Profiles "persist cookies, storage, and authenticated sessions". "Managed Auth" handles login flows.
  - Idle browsers go to standby after 10 s, with state preserved. — [Kernel: Create](https://www.kernel.sh/docs/introduction/create)
- **CONFIRMED (vendor docs)** Kernel "stealth mode automatically adds a recaptcha solver and residential proxy". Live view and mp4 recordings are provided. — [Kernel Browsers](https://www.kernel.sh/browsers)
- **CONFIRMED (vendor docs)** Live view URLs can be embedded in an iframe "to hand a session off to a human-in-the-loop". `?readOnly=true` gives a view-only stream. — [Kernel: Observe](https://www.kernel.sh/docs/introduction/observe)
- **CONFIRMED (vendor docs)** Kernel exposes four control primitives: "computer use, playwright execution, CDP, and WebDriver BiDi". It warns that "Sites scan for Chrome DevTools Protocol signatures. Use computer controls (no CDP) on aggressive detection sites." Listed regions are "us-east, us-west, eu-west, ap-southeast". Only one browser can write a profile at a time. — [Kernel Skill doc](https://www.kernel.sh/docs/skill.md)
- **CONFIRMED (vendor docs)** The CLI flag `--headless` means "Launch without GUI/VNC access". — [Kernel CLI](https://www.kernel.sh/docs/reference/cli/browsers)

### Inferences
- **INFERRED** The phone "Open Browser" view is Kernel's interactive live view embedded in a WebView. Pickle's own gesture layer (two-finger right-click, Paste from iPhone) maps touch to mouse and keyboard events. This matches Kernel's embeddable `browser_live_view_url` and its human-in-the-loop guidance ([Observe](https://www.kernel.sh/docs/introduction/observe)), plus the GUI/VNC wording of `--headless` ([CLI](https://www.kernel.sh/docs/reference/cli/browsers)).
- **INFERRED** The control style is hybrid. Pickle hides filled values "in the page text the model reads" and checks screenshots before they are made ([research post](https://www.pickle.com/how-your-pickle-protects-your-privacy)), so the model receives both a text/DOM rendering of the page and screenshots. Kernel offers both Playwright/CDP and computer-use control. Which one Pickle uses per step is not disclosed.
- **INFERRED** Korean accounts' browsers probably run on Kernel in the US, because the KO policy lists Kernel as "미국" and Kernel's regions include no Korea. That would explain Naver's "해외 IP 로그인" alerts. It also suggests Kernel's default residential proxy was not Korean for those sessions. The Japan setup (AWS Tokyo) is likely a self-hosted or dedicated deployment, since Tokyo is not a listed Kernel region. Sources: [KO policy](https://www.pickle.com/ko/privacy-policy), [Kernel Skill doc](https://www.kernel.sh/docs/skill.md), [어비스](https://aviss.kr/blog/view.php?seq=192).
- **INFERRED** CAPTCHA handling has two tiers. An automated solver (NopeCHA, and possibly Kernel's built-in reCAPTCHA solver) runs first, and the user takes over when it "doesn't clear on its own" ([help](https://pickle.com/help/tasks/take-over-browser)). Note: 청음's CLAUDE.md forbids CAPTCHA bypass, so this part should not be copied.
- **INFERRED** App-only Korean services are handled by using their web front-ends, not by mobile-app automation. KTX went through the Korail website, and delivery is limited to 요기요 (which has web ordering). I found no evidence of Appium-style app automation or private API reverse-engineering.
- **INFERRED** Session persistence is "Kernel profile per user per site, saved after each task". This follows from "only the sign-in state stays in encrypted storage for the next task" ([Isolation](https://pickle.com/security/isolation)) and Kernel's profile feature ([Create](https://www.kernel.sh/docs/introduction/create)). Account deletion also deletes "the browser profile your Pickle used for you" ([EN policy](https://www.pickle.com/privacy-policy)).

### Gaps
- Whether Pickle uses Kernel's Managed Auth or only profiles plus its own enclave-backed fill tool.
- The DOM observation format, whether set-of-marks or accessibility tree, and whether a computer-use model (OpenAI, Anthropic, Gemini) drives clicks.
- How the step list on the work screen is generated. It is likely produced from tool-call logs, but that is unconfirmed.
- How 카카오톡 "connection" (listed on the App Store) actually works. Possibly only Kakao 간편로그인 through phone approval. Not documented.

---

## 3. Phone calls: telephony, Korean speech stack, latency, turn-taking, live transcripts, IVR/ARS, summaries, calling Pickle yourself

### Takeaway
Calls run on **LiveKit** for real-time media. **Telnyx** carries calls generally and **Flover (주식회사 플로버 / 제로콜)** carries calls to Korean numbers. Speech recognition uses **Soniox and Deepgram**, TTS uses **ElevenLabs and xAI**, and **Krisp and ai-coustics** clean up noise. Pickle says audio is never stored and only transcripts are kept. Observed behavior: Pickle navigates ARS menus with DTMF, discloses that it is an AI, streams a live transcript to a view-only call screen, and posts a summary card afterwards. The main failures are social (people hang up on "AI 비서") and institutional (carrier ARS blocks non-subscriber numbers). "Calling Pickle" is an in-app voice/video call, not a phone number.

### Cited Findings
- **CONFIRMED** Providers: "LiveKit: real-time audio and video transport for calls… Soniox and Deepgram: turning your speech into text. ElevenLabs: turning your Pickle's words into its voice. Krisp and ai-coustics: cleaning up call audio… Telnyx: the phone line for calls your Pickle places for you. Flover: the phone line for calls your Pickle places to Korean phone numbers." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** The Korean policy lists TTS as "Eleven Labs Inc. / SpaceX Super Intelligence LLC(xAI)". Flover handles "피클이 한국 번호로 거는 전화의 회선, 회사 대표번호의 음성 사서함 운영". — [개인정보 처리방침 (KO)](https://www.pickle.com/ko/privacy-policy)
- **CONFIRMED** Outbound call disclosure: Pickle "places the call from a Pickle phone number, says that it is your AI assistant, and says that the call is transcribed… We don't keep the audio." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** User-to-Pickle calls: "During a call, audio from your microphone streams to our servers… We don't record or keep the audio itself." A camera tile streams frames used to track face and hand position so "your Pickle can look at you". — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** The App Store lists "피클에게 전화를 걸어 요청할 수 있습니다" and a microphone permission for "음성 메시지 및 피클과의 통화". — [App Store](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** Caller ID: Korean recipients see a 02 number ("전화가 02 번호로 가가지고… 피싱전화인 줄 알고 [안 받네요]"). — [App Store review](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** In Japan, calls come from a separate 050 number. "한국에서 쓰면 같은 전화가 일반 지역번호로 걸린다." — [다나와 DPG](https://dpg.danawa.com/news/view?boardSeq=60&listSeq=6081284)
- **CONFIRMED** YC directory text: Pickle "places phone calls on your behalf in 81 countries". — [YC List](https://yclist.com/w25/pickle-2/)
- **CONFIRMED** Flover is 한국에이아이통신(주), registered as 플로버 주식회사, brand 제로콜. It offers 070 business numbers, number porting, concurrent-call scaling, "기존 교환기 연동 (SIP)", AI inbound and outbound agents, and "API · 웹훅 실시간 전달". — [제로콜 제품 구성](https://zerocall.kr/biz/platform/modules); [제로콜 제품](https://zerocall.kr/product)
- **CONFIRMED** Flover was founded in February 2021 and had 6 employees as of September 2026. — [THE VC](https://thevc.kr/flover)
- **CONFIRMED** IVR/ARS: Pickle "ARS 안내를 끝까지 듣고, PG 가맹점 문의가 2번이라는 말에 2번을 누른다". It disclosed being an AI to the agent, handled a "대표자 본인만" refusal, asked follow-up questions, and sent a summary plus a guidance card for the user's own call. The call lasted 6 minutes 14 seconds. — [brunch](https://brunch.co.kr/@imago-lab/35)
- **CONFIRMED** On LG U+ lines (1544-0010, 1544-0001), Pickle pressed 5 after a menu prompt but got "지금 연락 주신 번호는 ARS 이용이 제한됩니다". Identity-bound carrier support was unreachable. Other observations: outcomes are logged as 통화 종료, 응답 없음, 거절됨, or 연결 실패; Pickle sometimes starts its intro before the callee says "여보세요", which causes a repeated intro; and "진행 중인 통화는 보기만 할 수 있다" (the user cannot interject). — [dahaeji](https://www.dahaeji.com/2026/11/pickle-phone-call.html)
- **CONFIRMED** Pickle kept a per-user instruction across calls. After the user asked it to drop "AI" from its intro, it said "○○ 님 비서" in later calls, including one nine days later. — [dahaeji](https://www.dahaeji.com/2026/11/pickle-phone-call.html)
- **CONFIRMED** A gym hung up repeatedly when Pickle opened with "AI 비서입니다" in a TTS voice. — [중앙일보 팩플](https://www.joongang.co.kr/article/25477408)
- **CONFIRMED** In another report it succeeded on the third try "용건을 먼저 전달해". — [다나와 커뮤니티](https://dpg.danawa.com/board/ai/6080540)
- **CONFIRMED** The live transcript appears in "앱 채팅의 별도 화면". Pickle apologized in real time when the callee complained, then reported the callee's request back to the user. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** A user reported that Pickle succeeded at a reservation change where other AI call apps (aitocall, tello) had failed. — [App Store review](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** There is a separate daily cap on outbound calls. — [어비스 블로그](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Latency design, from the avatar post, which applies to Pickle's voice turns: the budget is 500 ms. "While you are still talking, the LLM drafts a reply and our models infer its motion. If you keep talking, the draft is discarded… If you stop, the pre-generated response and its motion are sent." The measured first visible reaction came 400 ms after the user's turn ended. — [How we make Critter act in real time](https://www.pickle.com/how-we-make-critter-act-in-real-time)
- **CONFIRMED (vendor docs)** LiveKit outbound calls create a SIP participant through an outbound trunk. They support DTMF strings (`"*123#ww456"`) and answering machine detection that classifies `human`, `machine-ivr`, `machine-vm`, `machine-unavailable`, or `uncertain`. With `ivr_detection`, Python sessions automatically start IVR navigation and relay DTMF. — [LiveKit outbound](https://docs.livekit.io/telephony/making-calls/outbound-calls/); [LiveKit AMD](https://docs.livekit.io/telephony/features/answering-machine-detection/); [LiveKit DTMF](https://docs.livekit.io/telephony/features/dtmf/)
- **CONFIRMED (vendor docs)** LiveKit turn handling: `TurnDetector()` model by default, "adaptive" context-aware interruption (a barge-in model), and false-interruption detection with resume after 2.0 s. The options also control "preemptive generation". — [LiveKit turn handling](https://docs.livekit.io/reference/agents/turn-handling-options/)
- **CONFIRMED (vendor docs)** Telnyx connects numbers to LiveKit agents with DTMF over RFC 2833/4733. "LiveKit on Telnyx is being retired", and Telnyx now points to `telnyx-livekit-plugin`. — [Telnyx LiveKit telephony](https://developers.telnyx.com/docs/livekit/telephony)
- **CONFIRMED (vendor docs)** Soniox offers Korean real-time STT over WebSocket at $0.12/hour real-time, with end-of-turn detection and Korean code-switching. — [Soniox Korean](https://soniox.com/speech-to-text/korean)
- **CONFIRMED (vendor docs)** Soniox "semantic endpointing" exposes `endpoint_latency_adjustment_level`, `endpoint_sensitivity`, and `max_endpoint_delay_ms`. — [Soniox endpoint detection](https://docs.soniox.com/stt/rt/endpoint-detection)
- **CONFIRMED (benchmark)** Korean streaming character error rate (CER): Soniox stt-rt-v5 4.2%, ElevenLabs Scribe v2 RT 4.5%, xAI Grok STT 4.7%, Deepgram Nova-3 11.6%. — [Speko Korean STT benchmark](https://speko.ai/benchmarks/stt-multilingual/ko)
- **CONFIRMED (vendor docs)** xAI TTS supports `ko`. It offers streaming over WebSocket (`wss://api.x.ai/v1/tts`), telephony codecs `mulaw`/`alaw` at 8 kHz, `text_normalization`, a speed range of 0.7–1.5, and character timestamps. — [xAI TTS](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech); [xAI Voice REST](https://docs.x.ai/developers/rest-api-reference/inference/voice)

### Inferences
- **INFERRED** The call pipeline is a cascaded LiveKit Agents session:
  - Media path: PSTN (Telnyx, or Flover SIP for Korea) → LiveKit SIP participant → noise suppression (Krisp/ai-coustics) → streaming STT (Soniox for Korean, given its benchmark lead; Deepgram likely for English) → LLM → streaming TTS (ElevenLabs/xAI) → back to SIP.
  - The user's app joins the same LiveKit room or a data channel to receive the live transcript, which explains "view only".
  - Evidence: the provider list ([EN policy](https://www.pickle.com/privacy-policy)), LiveKit's SIP, DTMF, and AMD features ([LiveKit docs](https://docs.livekit.io/telephony/features/answering-machine-detection/)), and the Korean CER numbers ([Speko](https://speko.ai/benchmarks/stt-multilingual/ko)).
  - It is not a single speech-to-speech model. The STT and TTS vendors are listed separately, and transcripts are kept.
- **INFERRED** ARS handling uses LiveKit's DTMF publish or IVR-navigation tooling. The observed pattern (listen to the full menu, then press a digit) matches `machine-ivr` → IVR navigation ([LiveKit DTMF](https://docs.livekit.io/telephony/features/dtmf/)).
- **INFERRED** The "intro before hello" glitch suggests the agent speaks on SIP answer without waiting for the callee's first utterance. LiveKit's AMD pauses agent speech until the first utterance is classified, so it appears Pickle did not use AMD consistently, or tuned it aggressively.
- **INFERRED** Speculative drafting during user speech, documented for avatar calls, is likely shared with phone calls, because it is the same agent and voice stack. LiveKit's "preemptive generation" option is the standard way to do it ([LiveKit turn handling](https://docs.livekit.io/reference/agents/turn-handling-options/)).
- **INFERRED** "Call Pickle" is an in-app WebRTC call through LiveKit with an optional camera, not PSTN dial-in. The microphone permission is phrased as "피클과의 통화", the camera tile exists, and the only Pickle phone mailbox listed is the company's support line ([KO policy](https://www.pickle.com/ko/privacy-policy)).
- **INFERRED** Post-call summaries are generated by an LLM over the transcript and posted as a chat card, with the transcript and outcome stored in "추가 대화" ([dahaeji](https://www.dahaeji.com/2026/11/pickle-phone-call.html)).

### Gaps
- Which Korean number ranges (02, 070) Flover provides to Pickle, and whether caller-ID registration or spam-label mitigation exists.
- Whether any calls use a realtime speech-to-speech model (OpenAI Realtime, Grok Voice) instead of the cascade. xAI is listed for TTS, but its Realtime API is not mentioned.
- Measured phone-call latency (only the avatar latency is published).

---

## 4. Agent-to-agent: how two users' Pickles negotiate

### Takeaway
A2A is an in-house, server-side protocol between Pickle instances, gated by a friendship relationship. I found no evidence of Google A2A or MCP. Each conversation runs through a "clone": the same memory and persona, but **read-and-talk-only tools**, server-enforced sharing rules, and reconsideration when rules change mid-reply. Both humans can read the transcript, and anything needing a decision comes back to the user before it is settled.

### Cited Findings
- **CONFIRMED** "When your Pickle talks to a friend or to a friend's Pickle, we call it a clone. A clone is still your Pickle, with the same memories and personality… We also limit the clone's tools to reading and conversation. It cannot directly make bookings, make payments or change files, and the server rejects lookups of connections not shared with that conversation. If you change the rules while a reply is being prepared, the system stops that reply from being sent as it stands and has the clone reconsider it." Sharing follows "contextual integrity" (Nissenbaum). A planned "checker separate from the conversation model would compare the message with your current sharing rules". — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** Example of minimal disclosure: when sharing free time, the friend's Pickle gets "Free after 8" and not who you meet before then. "Being free at that time is not the same as agreeing to come." — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** "Until you're friends, your Pickles can't talk to each other directly." "Your Pickle has a separate conversation with your friend's Pickle. Your friend's Pickle passes on what it heard to your friend in its own words… If something is yours to decide, your Pickle checks with you again." Per-friend "Notes for (Pickle)". Transcripts are in "Other chats". — [Help: Pass a message to a friend](https://pickle.com/help/friends/pass-message)
- **CONFIRMED** Sharing levels are set separately for friends and non-friends. There is a "Never shared" list that only the user can change, per-person rules, and per-connection opt-in (off by default). Sensitive categories (health, finances, personal life, beliefs, exact location, account security) are private by default. Pickle can browse the community board at night and start conversations, with results delivered in the morning. — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** In a 3-person trip-planning test, Pickle messaged the companions' Pickles, for example asking them to "피하고 싶은 음식 또는 희망하는 출발·도착 시간대를 사용자에게 알아보겠다". — [중앙일보 팩플](https://www.joongang.co.kr/article/25477408)
- **CONFIRMED** A stranger's Pickle initiated a chat in which name, job, and hobbies were exchanged. — [어비스 블로그 citing 한겨레](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** YC framing: an "Agent-to-Agent (A2A) network effect" with "70%+ D1 retention" and "K-factor > 1.2". — [Y Combinator](https://www.ycombinator.com/companies/pickle-2)

### Inferences
- **INFERRED** Scheduling negotiation is LLM-to-LLM natural-language messaging between two server-side agent sessions, with each side's calendar answer filtered by its owner's sharing rules. It is not a shared calendar or a structured free/busy exchange. Evidence: "separate conversation", "in its own words", and the free/busy example ([help](https://pickle.com/help/friends/pass-message); [research](https://www.pickle.com/how-your-pickle-protects-your-privacy)). Because both agents run on Pickle's backend, no cross-vendor protocol is needed. Nothing indicates Google A2A or MCP.

### Gaps
- Message schema, turn limits, and loop prevention between two agents.
- Whether bookings that follow agreement are made by the initiating user's main Pickle after confirmation. That seems likely given that clones cannot book, but it is unconfirmed.

---

## 5. Integrations: OAuth, Korean services without APIs, MCP, "connect an app"

### Takeaway
There are three integration channels: (a) OAuth or app-password connectors whose tokens live only inside the Nitro credential enclave (Google, Microsoft, Slack, Notion, X, Granola, Mercury, GitHub, Link, Plaid, plus NAVER Mail through IMAP), (b) direct vendor or public APIs for lookups (Kakao Map, TMAP, Google Maps, WeatherKit, 국토교통부/서울시 bus and subway data, a parcel tracker, Exa/Serper search), and (c) the cloud browser with saved logins for everything else (정부24, 쿠팡, 코레일, 캐치테이블, 요기요, carriers, insurers). I found no evidence of MCP.

### Cited Findings
- **CONFIRMED** Connected accounts: Google (Gmail, Calendar, Workspace), Microsoft (Outlook, files, tasks, Teams), Slack, Notion, X, Granola, Mercury (read only), GitHub, and Link. "The provider issues an access token to our Credential Enclave, which keeps it and uses it on your behalf." — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** In the enclave, "the node creates the PKCE verifier and exchanges the authorization code itself, over TLS that ends inside it. `forward` puts the token into a request to an address of the compiled-in provider definitions." — [credential-enclave README](https://github.com/pickle-com/credential-enclave/)
- **CONFIRMED** "When Pickle asks for an email, the enclave checks that the service address is allowed, adds the token to the request, and calls Google. What comes back to Pickle is the content of the email." — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** NAVER Mail connects through IMAP with a NAVER app password. In "Let Pickle set it up" mode, Pickle itself turns on IMAP, checks 2-step verification, asks the user for phone approval when needed, and creates an app password named "Pickle". "The app password goes to the phone that made the request, where it's encrypted and stored. Your Pickle (the AI) only gets the result of the setup." — [Help: Connect NAVER Mail](https://pickle.com/help/connect/naver-mail)
- **CONFIRMED** If a service is not in the list, "tap Add connection for '(search term)'", which sends "I want to connect (search term)" to Pickle. When a task needs a connection, Pickle sends a connection card. "When you add a new connection, your Pickle reads broadly through that account to get to know you." — [Help: Connect apps and services](https://pickle.com/help/connect/add-connection)
- **CONFIRMED** API lookups: Kakao Map, TMAP, Google Maps, Apple WeatherKit, 국토교통부·서울특별시 public data for bus and subway arrivals (coordinates coarsened to about 100 m; the Seoul API is plain HTTP), "Joywide Inc.(Delivery Tracker) | 택배 배송 조회", Exa/Serper web search, and fal for images. — [개인정보 처리방침 (KO)](https://www.pickle.com/ko/privacy-policy)
- **CONFIRMED** Phone-side data: Contacts, Calendars, Reminders, Photos, Apple Music, step counts, and Screen Time are read on the device only when enabled and needed. — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** The App Store lists connectable services including "네이버, 카카오톡, 지메일, 구글 캘린더, 정부24, 쿠팡, 통신사, 배달, 보험, 항공사". — [App Store](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** Workaround for Kakao Calendar: Pickle suggested generating an iCal URL in 카카오캘린더, subscribing to it in Google Calendar, and connecting Google Calendar. — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** The YC pitch says Pickle "integrates deeply with local messaging (Kakao, LINE), local identity, and payment rails". Sign-in supports Kakao (KO), LINE (JP), Apple, Google, and phone OTP through Stytch. — [Y Combinator](https://www.ycombinator.com/companies/pickle-2); [KO policy](https://www.pickle.com/ko/privacy-policy)

### Inferences
- **INFERRED** "Connect an app" is a single UX layer over three backends: an OAuth connector, an IMAP app-password connector, or a "site login" saved to the vault for browser use. The help text for unlisted services ("I want to connect X" sent to the agent) suggests the agent decides at runtime which path applies, often guiding the user or doing the setup in the browser (as with NAVER IMAP).
- **INFERRED** Preferring official or public APIs for lookups (maps, transit, weather, parcels) over browsing reduces cost and fragility. Browsing is reserved for transactional flows on services without APIs.

### Gaps
- What "connecting" 카카오톡, 통신사, or 보험 means technically, beyond saved web logins.
- No mention of MCP servers in any Pickle source.

---

## 6. Memory and personalization

### Takeaway
Memory is LLM-written and user-editable: a daily diary ("memory bubbles"), notes about the user's identity and preferences, learned topics, long-conversation summaries, and a searchable memory index. It is fed by chat, voice transcripts, connected-account content, camera frames, and location transitions. Proactive suggestions come from scheduled scans (the morning briefing) and event triggers such as geofence arrival and departure.

### Cited Findings
- **CONFIRMED** "Your Pickle writes memory from your conversations: a diary of your days (shown in the app as memory bubbles), notes about who you are and what you like, and topics it has learned about." It also creates "summaries of long conversations, a searchable index of your memory, records of tasks it performed". — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** With the camera on, "a sampled frame every few seconds, plus the frames your Pickle actually looked at when it responded, is kept as part of its memory". — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** With "Always" location and the Location connection on, the iPhone reports arrive, leave, and significant-move events "so your Pickle can check in at the right moment". The Android app collects no background location. — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy); [KO policy](https://www.pickle.com/ko/privacy-policy)
- **CONFIRMED** Proactive tasks: "메일과 일정을 바탕으로 항공권 환불 요청, 검진 예약, 기념일 식당 예약처럼 맡길 만한 일을 피클이 먼저 제안합니다." — [App Store](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** A nurse user got "이브닝 근무 고생했다" after Pickle read the shift roster in her mail and saved her profession to memory on its own. Another user's children's names and birthdays were inferred from mail and contacts. — [다나와 DPG](https://dpg.danawa.com/news/view?boardSeq=60&listSeq=6081284); [어비스 블로그 citing 아시아경제](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Conversations and memories are encrypted at rest with AWS-managed keys, separate from the iPhone key. The stated next step is to "extend encryption based on your own key to stored conversations and memories". — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** YC pitch: "every user gets a dedicated agent with persistent memory and local context". — [Y Combinator](https://www.ycombinator.com/companies/pickle-2)
- **CONFIRMED** Pickle's earlier open-source project Glass (an Electron app) described its mission as a "trusted pipeline that transforms your daily data into a scalable clone". — [pickle-com/glass](https://github.com/pickle-com/glass)

### Inferences
- **INFERRED** The memory architecture is file-like memory documents (diary, profile notes, topics) plus a retrieval index ("searchable index"). Relevant slices are injected per turn ("the relevant parts of your Pickle's memory" are sent to providers; [EN policy](https://www.pickle.com/privacy-policy)). This is the common 2026 pattern of LLM-curated memory plus RAG, not fine-tuning per user.

### Gaps
- Retrieval method (embeddings vendor or vector DB), memory-write triggers, and conflict resolution.

---

## 7. Client app: framework, 3D character and real-time animation, push, voice input

### Takeaway
Pickle has iOS (17+, 161 MB, KO/EN/JA) and Android (Google Play since 2026-10-25) apps. The animated character is driven server-side: NVIDIA Audio2Face-3D produces face blendshapes and a learned pose model produces head pose, both from the agent's voice. A CPU "synthesis layer" with physics turns these into 257 rig values per frame at 60 fps, and the phone renders the rigged Critter mesh. The UI framework (native or cross-platform) is not disclosed.

### Cited Findings
- **CONFIRMED** iOS 17.0+, 161 MB, languages Korean, English, Japanese. v1.0 was released 2026-08-10 and v1.1.19 on 2026-11-08. Provider Pickle, Inc., developer "Pickle Company". The app is also listed as runnable on Apple Silicon Macs and visionOS. Permissions: microphone, notifications, camera, photos, location, contacts, calendar. — [App Store](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** The Android app appeared on Google Play on 2026-10-25. There is no web version. — [from0lab](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/)
- **CONFIRMED** Critter is based on Blender Studio's Critter body and rig (CC BY 4.0). "Pickle, Inc.는 색상, 비율, 애니메이션, 실시간 움직임을 수정했습니다." — [App Store](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** Animation pipeline details, all from one post:
  - "Audio drives a facial model (NVIDIA's Audio2Face-3D, 68 blendshape weights at 60 fps) and a pose model (six channels…)."
  - "Each frame out is 257 control values… The learned models run on a GPU; the synthesis layer is arithmetic on a CPU; the user's device renders the values."
  - Head rotations are amplified 3.5×. Chest-to-tail follow-through uses delay and inertia. Parameters are tuned "in an agentic loop" with automated checks plus human picks.
  - In a preference study, raters chose the rig 86.8% of the time versus 10.8% for a diffusion avatar.
  - Latency was +400 ms (rig) versus +800 ms (diffusion). Cost is about one-tenth of an L40S per stream, roughly $0.003 per minute.
  - Limitations: the body "hears only its own voice"; the user arrives as "turn events".
  - Planned: a causal diffusion model for listening motion, and "The LLM will direct the body just by calling a tool". — [How we make Critter act in real time](https://www.pickle.com/how-we-make-critter-act-in-real-time)
- **CONFIRMED** Privacy-policy details: a "shared 3D world", a Pickle that "roams the sky" near the user's location, gaze at the user from camera face and hand tracking done server-side, Apple push notifications, and WeatherKit for world weather. — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy); [KO policy](https://www.pickle.com/ko/privacy-policy)
- **CONFIRMED** The device side of the enclave protocol is "The JavaScript program that the apps run… The backend serves a byte-identical copy to the apps, and a release build of an app loads it only with the release proof of a release of this repository." — [credential-enclave README](https://github.com/pickle-com/credential-enclave/)
- **CONFIRMED** The earlier body-double product claimed "an ultra-fast human model that processes voice input and generates output in under 0.3 seconds" for lip-sync. — [Y Combinator](https://www.ycombinator.com/companies/pickle-2)

### Inferences
- **INFERRED** Rig values (257 floats at 60 fps) are streamed alongside the TTS audio over LiveKit, likely as data-channel messages time-aligned with audio. This keeps server bandwidth tiny and lets the device render at any resolution ("the same stream of values draws Critter at 480p or 4K"; [Critter post](https://www.pickle.com/how-we-make-critter-act-in-real-time)).
- **INFERRED** One security JavaScript bundle shared by the iOS and Android apps suggests an embedded JS engine on both platforms: JavaScriptCore/WebView, or a cross-platform framework such as React Native. That is not proof of the UI framework.

### Gaps
- UI framework (Swift/SwiftUI, Kotlin, React Native, Flutter, Unity) and 3D renderer (SceneKit, RealityKit, Filament, Unity, three.js). No job posts or engineering notes found.

---

## 8. Infrastructure, security architecture, and team

### Takeaway
Pickle runs on AWS us-west for data, with AWS Tokyo for Japanese accounts' browsers, a Rust/Apache-2.0 credential enclave on AWS Nitro Enclaves (open-sourced, attestation-verified, with S3 Object Lock audit logs), Kubernetes-style "pods", LiveKit for media, Stytch for authentication, and Vercel for the website. The team is 6 people (3 engineers) in Hillsborough, CA. The ML and RL background comes from co-founders previously in medicine and self-driving. No hiring posts are live.

### Cited Findings
- **CONFIRMED** "Your data is stored in the United States, in Amazon Web Services data centers in the western United States." pickle.com is hosted on Vercel. — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** credential-enclave structure: Rust, Apache-2.0. Parts: node program (`enclave/`); host program "in the parent pod"; protocol crate; `credential-enclave-verify`; and the JS `secure-program`. The log store is S3 Object Lock in compliance mode for 365 days, and an entry must be written before any use. Toolchain is pinned to Rust 1.98.1. — [credential-enclave README](https://github.com/pickle-com/credential-enclave/)
- **CONFIRMED** Key hierarchy: a master key on the phone (iCloud Keychain) derives an account signing key, a log decryption key, and a user key. The app checks the attestation (PCR0/1/2 signed by the AWS root) and rejects debug mode. Grants last up to 30 days. — [from0lab](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/)
- **CONFIRMED** "Pickle 엔클레이브" has been developed since October 2025. "대표인 저조차 특정 이용자의 비밀번호를 볼 수 없도록 하는 게 목표". — [한국경제](https://www.hankyung.com/article/202611135652i)
- **CONFIRMED** Team: "직원 6명 중 엔지니어가 3명". Pickle reached 200K MAU within a month of the Korean launch, which was invite-only. — [한국경제](https://www.hankyung.com/article/202611135652i)
- **CONFIRMED** YC W25, founded 2024, team size 6, San Francisco, primary partner Brad Flora. Founders: Daniel Park (CEO), Sanio Jung ("ML engineering & infrastructure"), Emmett Kim (product), Hojin Yu (ML). — [Y Combinator](https://www.ycombinator.com/companies/pickle-2)
- **CONFIRMED** The Launch YC post lists "Sam Yu – our CTO; … built a self-driving AI model at just 21, is a believer in reinforcement learning", "Sanio Jung – a former medical doctor and self-taught engineer", and Chris Kang (social media). The team lives and works in Hillsborough. — [Launch YC](https://www.ycombinator.com/launches/MnF-pickle-ai-body-double-for-video-calls)
- **CONFIRMED** The company address is 5 Pear Ct, Hillsborough, CA. — [Privacy Policy (EN)](https://www.pickle.com/privacy-policy)
- **CONFIRMED** "No jobs at Pickle are currently posted on the YC platform." — [YC Jobs](https://www.ycombinator.com/companies/pickle-2/jobs)
- **CONFIRMED** Founders are from 경희대 의대 (박채근) and KAIST/성균관대. — [중앙일보 팩플](https://www.joongang.co.kr/article/25477408)
- **CONFIRMED** Founded September 2024. The previous product, 'AI Self', had 40K users in the US and India. Korean iOS closed beta opened 2026-10-14, and Pickle reached #2 in Productivity within two weeks. — [from0lab](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/)
- **CONFIRMED** Launch was announced on X by @danifesto on 2026-10-01 ("a personal AI you raise"). — [X via nitter](https://nitter.cf/danifesto/status/2105721921623232995)
- **CONFIRMED** GitHub org `pickle-com` lists 2 public repos: credential-enclave and a tau2-bench fork. — [GitHub org](https://github.com/pickle-com)
- **CONFLICT** Separately indexed pages show `pickle-com/glass` (7.5K stars, GPL-3.0, Electron + Next.js, fork of CheatingDaddy, created 2025-07-02, supports OpenAI, Gemini, Anthropic, local Ollama, and Whisper, with SQLite storage) — [pickle-com/glass](https://github.com/pickle-com/glass); [DeepWiki](https://deepwiki.com/pickle-com/glass). They also show `pickle-com/privacy`, an earlier browser-extension trust-anchor design that checks enclave `ImageSha384` against `TRUSTED_HASHES` — [pickle-com/privacy](https://github.com/pickle-com/privacy). Neither appears in the org's current public repo count, so they may now be private, renamed, or cached.
- **CONFIRMED** Glass engineering notes: echo cancellation was "rewritten in Rust to separate microphone from system audio". — [Zendot](https://zendot.org/en/posts/pickle-com-glass)
- **CONFLICT** Funding: "2025년 6월 시드 60억 원, 올해 2월 Base Ventures가 추가로" — [from0lab](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/). Another source says "2025년 6월 베이스벤처스 등에서 60억 원 규모의 시드" — [어비스 citing 플래텀](https://aviss.kr/blog/view.php?seq=192).

### Inferences
- **INFERRED** "Parent pod" wording means the enclave host runs as a Kubernetes pod on Nitro-enabled EC2, probably EKS. This is standard for Nitro Enclaves on Kubernetes, but it is inferred only from the README wording.
- **INFERRED** Hojin Yu (YC directory) and "Sam Yu, CTO" (Launch YC) are likely the same person using an English name. The same applies to Daniel Park = 박채근.
- **INFERRED** With 3 engineers serving 200K MAU, Pickle leans heavily on managed vendors (Kernel, LiveKit, Stytch, Soniox, ElevenLabs, Telnyx, Flover). Its in-house engineering concentrates on the agent loop, the enclave, and the avatar.

### Gaps
- Backend language and framework, queueing and scheduling system, database, and observability stack.
- No conference talks, podcasts with technical depth, or engineering blog beyond the two research posts.

---

## 9. Which Pickle techniques transfer to 청음 (Python FastAPI + Playwright local Chromium + rule-first parser + local faster-whisper + Electron)

### Takeaway
The most transferable ideas are about safety and UX, not infrastructure. Concretely:
- A secret-fill tool that the LLM can only reference, never read, combined with DOM masking after the fill.
- Explicit confirmation-card semantics, including amount-increase re-asks and "same error twice → stop".
- A persistent task state machine with mid-task edits.
- Spoken step-by-step progress narration.
- Time-of-day sanity checks before contacting people.
- Speculative LLM drafting before end-of-turn.
- Official APIs before browsing.

청음's local Chromium avoids Pickle's two structural weaknesses: foreign-IP logins and plaintext secrets reaching a third-party cloud browser. It is also accessible to the user's own screen reader at hand-off time.

### Cited Findings
- **CONFIRMED** Pickle's secret-fill tool takes (saved item, field). The tool "does not return the secret itself". Filled values are hidden in the page text the model reads, and screenshots or PDFs are refused if a secret is exposed. — [How your Pickle protects your privacy](https://www.pickle.com/how-your-pickle-protects-your-privacy)
- **CONFIRMED** Payment and approval semantics: show item and total first; re-ask on increase; don't choose user-owned amounts; verify before retrying after a disconnect; stop after the same error twice. — [from0lab](https://from0lab.com/pickle-ai-agent-korea-credential-enclave/); [pickle.com FAQ](https://www.pickle.com)
- **CONFIRMED** Task statuses Working/Waiting/Done/Failed/Canceled. Edits are applied to the running task, and canceled tasks are not auto-retried. — [Help: Check on or cancel a task](https://pickle.com/help/tasks/check-and-cancel)
- **CONFIRMED** Users valued progress visibility. The work screen listed "코레일 홈페이지 접속, 로그인 메뉴 탐색, 카카오 간편로그인, 열차 조회, 좌석 선택". — [디지털데일리](https://www.ddaily.co.kr/page/view/2026110303331226363)
- **CONFIRMED** Speculative drafting: "While you are still talking, the LLM drafts a reply… If you keep talking, the draft is discarded." — [Critter post](https://www.pickle.com/how-we-make-critter-act-in-real-time)
- **CONFIRMED** Naver's foreign-IP login alerts were triggered by Pickle's cloud browser. — [어비스 블로그](https://aviss.kr/blog/view.php?seq=192)
- **CONFIRMED** Kernel warns that CDP signatures are detected by hardened sites. — [Kernel Skill doc](https://www.kernel.sh/docs/skill.md)
- **CONFIRMED** NAVER Mail via IMAP + app password, with the setup done in-browser and the password routed to the device. — [Help: Connect NAVER Mail](https://pickle.com/help/connect/naver-mail)
- **CONFIRMED** Korean phone-call frictions: people hang up on "AI 비서" intros, carrier ARS rejects non-subscriber numbers for identity-bound tasks, and an unfamiliar 02 number is mistaken for phishing. — [중앙일보 팩플](https://www.joongang.co.kr/article/25477408); [dahaeji](https://www.dahaeji.com/2026/11/pickle-phone-call.html); [App Store review](https://apps.apple.com/kr/app/id6795790129)
- **CONFIRMED** A Korean SIP/070 provider with API and webhooks exists (Flover/제로콜). LiveKit offers SIP, DTMF, and AMD/IVR navigation. Soniox offers Korean real-time STT with semantic endpointing. xAI TTS supports `ko` and μ-law. — [제로콜](https://zerocall.kr/biz/platform/modules); [LiveKit AMD](https://docs.livekit.io/telephony/features/answering-machine-detection/); [Soniox endpointing](https://docs.soniox.com/stt/rt/endpoint-detection); [xAI TTS](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)
- **CONFIRMED** Glass (Pickle's Electron app) supported local Ollama and Whisper and SQLite. Its echo cancellation was rewritten in Rust to separate mic from system audio. — [DeepWiki: glass](https://deepwiki.com/pickle-com/glass); [Zendot](https://zendot.org/en/posts/pickle-com-glass)

### Inferences
- **INFERRED** (secret handling) Add a Playwright-side `fill_secret(item_id, field_ref)` action in Agent A that reads from `personal/store.py` and calls `locator.fill()`. It returns only `{"filled": true}`. `observe.js` would then replace that input's value with a mask before any observation reaches the LLM or the narrator. This mirrors Pickle's tool-enforced boundary and complements `PolicyGuard`'s existing "secret fields always rejected" rule. 청음 policy forbids real-site login (user hand-off), so this matters first for the mock site and for forms with personal identifiers such as 주민번호 or 계좌.
- **INFERRED** (hand-off) Pickle's "Open Browser → I'm done → resume from that screen" maps directly to 청음's login hand-off. Because 청음's Chromium is local and headed, the blind user can use NVDA or 센스리더 directly on the real window, which a remote live-view stream cannot offer. The "다 했어요" voice command should re-observe and resume from the current page, not restart the task.
- **INFERRED** (approvals) Codify Pickle's rules in `safety/gates.py` and `FormSkill.submit_approved`:
  - An approved summary is the consent, so don't re-ask.
  - Any increase versus the approved amount or terms triggers a re-ask that speaks the difference ("6,000원 늘었어요").
  - After a timeout or crash during submit, re-observe for a success marker before retrying.
  - Stop a method after the same error twice. This is close to `autopilot.py`'s "같은 행동 3번째면 중단"; consider 2 for irreversible actions.
- **INFERRED** (task model) Promote long goals (autopilot runs, form fills) to task objects with statuses (작업 중/대기/완료/실패/취소) and allow "6시 말고 7시로" edits to patch the active task. Speak these statuses instead of showing cards. The `DialogueState` named-action design already fits.
- **INFERRED** (narration) Pickle's step list ("홈페이지 접속 → 로그인 메뉴 탐색 → 열차 조회") is the visual analogue of what blind users need audibly. Emit a short spoken step after each Agent A action, throttled and interruptible. This reuses `Narrator` and the `once` guard.
- **INFERRED** (latency) Pickle's 500 ms budget with speculative drafting suggests 청음 could start rule parsing, and LLM planning when needed, on interim transcripts and commit only at end-of-turn. With local faster-whisper (batch per utterance), that requires a streaming or partial-decode mode or a short-window VAD loop. Semantic end-of-turn detection, as offered by Soniox or LiveKit's turn detector, is the 2026 norm. A local open alternative would need evaluation, since none was verified here.
- **INFERRED** (APIs first) Like Pickle's use of 공공데이터 bus and subway APIs and the parcel tracker instead of browsing, 청음's Agent B should prefer official welfare APIs. IMAP with a NAVER app password is a far more robust way to read mail aloud than driving the Naver Mail web UI.
- **INFERRED** (local browser advantage) Local Chromium logs in from the user's own IP and device fingerprint. That avoids Naver's foreign-login alerts and the bot-detection problems Kernel documents. 청음 should keep this local design rather than adopt a cloud browser.
- **INFERRED** (phone calls, if ever considered) A Korean outbound-call feature would need:
  - A Korean SIP or 070 trunk (for example Flover/제로콜).
  - A media and agent framework with DTMF and AMD (LiveKit Agents or similar).
  - Korean streaming STT with semantic endpointing and TTS with μ-law output.
  - Explicit consent before each call and AI disclosure.
  
  Pickle's evidence shows disclosure-driven hang-ups and ARS restrictions, so the realistic first use is waiting through ARS menus and relaying results, not persuasion. This would conflict with 청음's local-STT privacy stance, because streaming STT is cloud-based.
- **INFERRED** (Electron shell) Glass shows Pickle once shipped a local-first Electron agent (Ollama/Whisper/SQLite). Its Rust echo-cancellation module separating mic from system audio is relevant to 청음's barge-in (`mic.js`), where TTS output from speakers can trigger false interruptions. LiveKit's documented "false interruption → resume" behavior (2.0 s default) is a useful target behavior.

### Gaps
- I could not verify a local, open-weight Korean semantic turn-detection model suitable for 청음's offline path.
- Pickle's DOM observation and action schema is not public, so a direct comparison with 청음's `observe.js` digest is not possible.
