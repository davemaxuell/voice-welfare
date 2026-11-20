# Official datasets for Agent B: private programs and a "where to go" answer

Status: implemented on 2026-11-18. Agent B includes private programs in discovery and answers office
questions from local snapshots. The three bundled publications and their publisher reference dates are
335 private programs (2025-11-05), 3,556 administrative offices (2025-12-31) and 140 National Pension
Service branches and centers (2026-08-01). The portal lists unrestricted use for these publications.

Mobility centers can be imported with `--csv`. The public CSV had 178 records, each with its own reference
date and booking phone number. The portal lists general usage terms for this dataset, so distribution of
the mobility snapshot with the app is deferred. The implementation strips staff contact listings, email
addresses and mobile numbers from private-program prose before publishing snapshots.

The proposal below records the original design. The shipped refresh command uses the portal's public
CSV download buttons and the date in the publisher's filename. It requires Playwright Chromium
(`uv run playwright install chromium`). CSV import and checking run offline. `DATASETS_DIR` and the CLI's
`--dir` select the snapshot directory. The default directory holds the bundled snapshots. When using
a fresh directory, refresh the three publications there before adding the mobility CSV.

## Problem

Agent B answers welfare questions from two live APIs (central 15090532, local 15108347). When an answer runs
out it says "주민센터나 129에 확인해 주세요" and stops. Two additions are wanted:

1. **More programs in 맞춤 찾기.** 335 private programs (data.go.kr 15116392), spoken as private programs with
   their own source and reference date.
2. **A "where to go / who to call" answer.** "우리 동네 주민센터 어디야?", "국민연금 지사 전화번호 알려줘",
   "장애인 콜택시 어디에 예약해?" answered with a name, an address and (when the data has one) a phone number,
   from an exact region lookup, in a sentence built by code.

What makes the shape non-obvious:

- **The data comes in two shapes.** Programs are prose, so retrieval fits. Directories are keyed by region, so
  exact lookup fits. A similarity search over offices returns "a similar dong", which is a guess a blind user
  cannot catch.
- **The data is annual.** Every file updates about once a year, each dataset needs its own usage approval for
  API access, and the file API's path changes with every yearly release. Calling out at question time adds
  failure modes and no freshness.
- **The real rows are thinner than the catalog suggested** (fetched 2026-11-18):
  - 15116392 has no id, no region column and no phone column.
  - 15059715 (행정복지센터, 3,556 rows) has **no phone number**, a short 시도 ("서울") and the office name in
    the 읍면동 column ("개포1동 주민센터").
  - 15010814 (국민연금 지사, 140 rows) has a phone number but no region columns and no jurisdiction.
  - One 법정동 has several offices (개포동 → 개포1·2·3동), and the same dong name exists in many cities.
- **The existing code resists both additions.**
  - Catalog entries are `provider: central|local`, `_detail_of` dispatches on that string, and discovery
    citations are hard-wired to 복지로 / 한국사회보장정보원.
  - Six existing rules already capture place sentences (POLICY_QUESTION, READ_FIELD, SEARCH, CURRENT_STEP,
    DESCRIBE_SCREEN, ABOUT_SITE), and a pending discovery question takes any sentence with a 시도 word as its answer.
  - `agents.welfare` may import only `core` and `safety`, so it cannot use `josa`.
  - The "short" speech setting cuts any reply of 100 characters or more to two sentences.
  - Vault values stay behind the consent gate (owner decision 2026-11-18).

## Usage (caller's view)

```bash
uv run python scripts/sync_datasets.py --csv 15059715=읍면동.csv --reference-date 15059715=2025-12-31
uv run python scripts/sync_datasets.py            # refresh three public CSVs without an API key
uv run python scripts/sync_datasets.py --check    # reference date, row count and age of each dataset
uv run cheongeum-server                           # reads the snapshots at start-up; never calls the portal for them
```

**Wiring** (`server/runtime.py`), once per process:

```python
open_data = OpenData.load(config.datasetsDir, today_iso)   # never raises; a missing dataset is a status, not an error
agent = WelfareInformationAgent(provider, llm, shelf=open_data.programs)   # shelf defaults to empty
deps  = OrchestratorDeps(..., places=open_data.places)
```

**(a) The orchestrator handler.** The intent has no parameters; the handler reads the user's own words, the
same way DISCOVER does today.

```python
"FIND_PLACE": lambda s, i, t: _ready(s._find_place(t.text, t)),

def _find_place(self, text: str, turn: Turn) -> dict:
    return self._place_draft(self.deps.places.answer(text, hint=self._region_hint()))   # hint: discovery 시도, read-only

def _place_draft(self, reply: PlaceReply) -> dict:
    if reply.ask: self.dialogue.ask_place(reply.ask)     # waiting for "어느 동이세요?"
    else:         self.dialogue.place_done()
    return draft(self.dialogue.state, reply.semantic, reply.speech, sources=list(reply.sources))

# _process_korean, before the discovery-answer block
if not forced and self.dialogue.place_ask:
    ask = self.dialogue.place_ask
    self.dialogue.place_done()                           # taken once; anything else is handled as a normal sentence
    if (await self._rules.parse(text, ctx))["type"] == "UNKNOWN":
        follow = self.deps.places.follow_up(ask, text)   # None unless the text is a bare region, "2번" or "모름"
        if follow is not None:
            turn.intentType = "FIND_PLACE"
            return self._finish(turn, self._place_draft(follow))
```

**(b) Private programs join discovery** (`WelfareInformationAgent.discover`); `match_services` is untouched:

```python
catalog = [*await self.provider.catalog(ctpv), *self._shelf.entries(today_iso())]
self._matches = match_services(catalog, profile)
```

**(c) The sync script** is a thin shell over `open_data.sync.run.main`: it resolves the folder, fetches or reads
each dataset, checks it, writes it, prints one line per dataset and exits 0 only if every dataset was written
or unchanged.

**(d) A unit test for the lookup.** Outcomes are data; sentences are tested separately.

```python
def test_same_dong_name_in_two_cities_asks_which_city_instead_of_guessing():
    out = INDEX.lookup(PlaceKind.DONG_OFFICE, RegionMention(dong="신흥1동"))
    assert isinstance(out, NeedMore) and out.missing == "region"

def test_adding_the_ward_pins_exactly_one_office():
    out = INDEX.lookup(PlaceKind.DONG_OFFICE, RegionMention(sigungu=("수정구",), dong="신흥1동"))
    assert isinstance(out, Found) and out.place.phones == ()     # this dataset has no phone; none is invented
```

**(e) Spoken answers.** Always at most two sentences, with the source inside the second.

- Found, with a phone number: "국민연금공단 서울북부지역본부는 서울특별시 서대문구 충정로 36, 충정로사옥 9층,
  13층에 있어요. 전화번호는 공이, 이일칠육, 구구사구예요 (출처: 국민연금공단 지사 및 상담센터 현황, 2026년 8월
  1일 기준)."
- Found, no phone number in the data: "개포1동 주민센터는 서울특별시 강남구 선릉로 35에 있어요. 이 자료에는
  전화번호가 없어요 (출처: 행정안전부 읍면동 하부행정기관 현황, 2026년 4월 3일 기준)."
- Ambiguous, so 청음 asks back: "강남구 개포동에는 개포1동, 개포2동, 개포3동 주민센터가 있어요. 어느 동인가요?"
- No region said: "어느 시·군·구의 어느 동인지 말씀해 주세요."
- Dataset not downloaded: "행정복지센터 자료를 아직 내려받지 않아서 확인하지 못했어요."

## Shape

### Data structures

- **`Region` and `RegionMention`** (`core/region.py`). `Region` is a full, canonical value built from data.
  `RegionMention` is what the user said and may miss any part. Only the place index turns a mention into
  places, by matching it against names derived from the dataset rows, so there is no hand-kept list of 시군구
  or 동. A 법정동 is never a region value; it is an index key read from the bracket in the address.
- **`Place` and `ProgramRecord`** (`open_data/records.py`). Normalised once, at sync time. `Place.phones` is a
  tuple that is empty for 행정복지센터. Neither has a field for a person's name.
- **`PlaceOutcome = Found | Choose | NeedMore | NotFound | Unavailable`** (`open_data/places.py`). `lookup` is
  pure and total. "Could not decide" is a value that says which level to ask for, so the no-guessing rule is in
  the return type. The sentence builder matches on it exhaustively.
- **A private program is one dict that is both a catalog entry and a detail record.** It has
  `provider="private"`, the tag lists discovery reads, the fields answers read, and its own `source`.
- **`DATASETS`** (`open_data/datasets.py`) is the single list of datasets. Sync, loading, citations and the
  health line all derive from it.

### The seven decisions

1. **Placement.** Word-level knowledge is pure and lives in `core` (`region.py`, `places.py`), because the rule
   parser, the directory and the orchestrator must share one parser and `understanding` may import nothing
   else. The data lives in one package, `agents/welfare/open_data/`, in Agent B's layer. Only five names are
   importable from outside it (`OpenData`, `DatasetStatus`, `PlaceFinder`, `PlaceReply`, `ProgramShelf`); two
   new layer tests enforce that, and that only the script imports `open_data.sync`.
2. **Joining the catalog.** A `ProgramShelf` is injected into the agent with an empty default, so no provider
   fake breaks. One data-driven rule replaces the provider-string dispatch for these records: **an entry that
   carries its own `source` is its own detail and its own citation.** `_detail_of` returns such an entry
   as-is; the citation helpers cite `s["source"]` when present and fall back to today's hard-wired source for
   central and local entries. Private programs are spoken as "민간 사업". 제출서류 becomes one new retrieval
   section. `enfcBgngYmd`/`enfcEndYmd` stay `None`: 사업시작일·종료일 is a programme period, not an
   application window, so "지금 신청할 수 있어?" must answer "확인하지 못했어요". A programme whose end date
   has passed is left out; `2099-12-31` means open-ended.
3. **Region.** It comes from the utterance, or from the answer to an ask-back. If the user said "우리 동네" or
   "가까운" and named nothing, the discovery 시도 is a read-only hint, and the reply names it. The vault is
   never read: its commands wait behind consent while this intent runs before consent, and a road-name address
   does not contain the 행정동 anyway. When candidates differ, the reply asks for the next level (which 시도,
   then which 시군구, then which 동) and never picks. "광주시" is not resolved to 광주광역시 by alias.
4. **Fetch and storage.** Fetch ahead; no live calls for these datasets. One self-contained JSON file per
   dataset (`{meta, records}`), written to a temp file and moved into place, so a crash leaves the old file.
   On read: shape, schema version, row count and hash are checked. A sync refuses to replace a file when the
   headers changed, rows fall below a floor or shrink by half, more than 2% of rows fail to parse, or a
   banned personal column appears. The newest release of a file API is chosen by the date in its path
   description; if no date can be read the sync fails and asks for `--release`. A missing or corrupt dataset
   makes only that kind answer "아직 내려받지 않았어요". Tests point `DATASETS_DIR` at `tests/fixtures/open_data`.
5. **The intent.** One `FIND_PLACE` row, `before_consent=True`, no parameters. One rule placed right after the
   help rule, above every rule that captures place sentences today. It fires on a place-kind word plus a
   request cue, and yields when the sentence is a form value ("주소는 …"), names a click, sends the user to
   another site ("복지로 가서 …"), or names a welfare programme ("기초연금 신청은 주민센터 어디서 해?" stays a
   policy question). A new wait in `DialogueState`, `place_ask`, is cleared by 멈춰 and excludes the discovery
   wait. A pending discovery question no longer swallows a place question. New `semanticAction` `find-place`.
6. **The spoken answer.** Agent B's layer builds it (`open_data/place_speech.py`) with `josa`, a new
   `speak_phone` (digit words in groups) and `speak_date(year=True)`. Sentence one is where; sentence two is
   the phone number, or that the data has none, plus the source and reference date in parentheses. Fragments
   cannot contain a sentence terminator, so the reply is two sentences by construction and survives the short
   trim. Non-Korean sessions get plain digits so the translation number check still guards them. The raw
   number also goes in the source `note`.
7. **Change surface.** About 15 new files and 14 edited. Largest edits: `agent.py` (about +55) and
   `session.py` (about +45). Untouched: `match_services`, the provider classes and their fakes, the gates, the
   vault, the discovery-list hijack. Hand-synced lists: two removed (`discovery.CTPV`, the `SEMANTIC_ACTIONS`
   copy), none added.

### Changed constraint

`agents.welfare` may import `speech.phrasing`. The edge is acyclic (`phrasing` imports only `core.jsutil` and
`safety.privacy`), and `personal` and `agents.web` already have it. The alternative keeps the layer table but
makes the orchestrator coordinate parse, lookup and sentence, which is the shallow shape.

### Interface depth

The orchestrator sees `PlaceFinder.answer(text, hint)` and `follow_up(ask, text)`, both returning a
`PlaceReply`. The agent sees `ProgramShelf.entries(today)`. Hidden behind those: three fetch routes and
release resolution, column semantics, region resolution and the ambiguity policy, the 법정동 index, sentence
building, phone reading, the two-sentence guarantee, atomic writes and integrity checks.

### Later datasets

Each is one `PlaceKind` line, one `KIND_SPECS` line and one `DATASETS` row with its normaliser:
15155700 장애인복지관 프로그램, 15139219 장애인단체 (대표자명 is dropped at sync). The live mobility API
(15140825) would be one optional `LiveSource` passed to `PlaceFinder`, adding "지금 이용 가능한 차량" after the
snapshot answer; `answer` becomes async at that point.

## Module map

| File | Owns |
|---|---|
| `core/region.py` (new) | The one 시도 table, `Region`, `RegionMention`, `parse_region_mention`, `region_of_address`. Replaces `discovery.CTPV`. |
| `core/places.py` (new) | `PlaceKind` + `KIND_SPECS` (import fails if they disagree), `PlaceQuery`, `PlaceAsk`, `is_place_request`, `parse_place_query`. |
| `agents/welfare/open_data/__init__.py` (new) | The five public names. |
| `…/open_data/datasets.py` | `DATASETS` and `cite()`. |
| `…/open_data/records.py` | `Place`, `ProgramRecord`. |
| `…/open_data/snapshot.py` | File format, checks on read, atomic write, reference date and age. |
| `…/open_data/normalize.py` | Raw row → record, one pure function per dataset. The only place that knows column names. |
| `…/open_data/places.py` | `PlaceIndex`, the outcome types, `PlaceFinder`. |
| `…/open_data/place_speech.py` | Outcome → `PlaceReply`. |
| `…/open_data/programs.py` | `ProgramShelf`. |
| `…/open_data/loader.py` | `OpenData.load / empty / from_records`. |
| `…/open_data/sync/` | Fetch routes and the sync run. Imported only by `scripts/sync_datasets.py`. |
| `core/intents.py`, `core/turn.py`, `core/dialogue.py` | One row; `find-place` and a derived `SEMANTIC_ACTIONS`; the `place_ask` wait. |
| `understanding/rules.py` | One rule. |
| `orchestrator/session.py` | `deps.places`, the handler, the follow-up block, the discovery-swallow guard, `_maybe_spoken_secret` yields to a pending place question. |
| `agents/welfare/agent.py`, `rag.py`, `discovery.py` | `shelf` argument, merge in `discover`, the entry-carries-source rule, private wording, `_service` falls back to `_picked`; the 제출서류 section; `CTPV` removed. |
| `speech/phrasing.py` | `speak_phone`, `speak_date(year=)`, `split_sentences` (shared with `_trim_speech`). |
| `server/runtime.py`, `server/app.py` | `datasetsDir`, `OpenData.load`, one health line. |
| `tests/unit/test_layers.py`, `test_registry.py` | One cell and two new tests; count 37 → 38 and `FIND_PLACE` in the before-consent set. |

## Synthesis decision

Four candidates were drafted independently from the same brief and grounding, then scored by an independent
judge against six criteria (constraints honoured, safe for a blind user, interface depth, testability, root
fixes, fetch and storage). Scores out of 30: candidate 3 scored 25, candidate 1 scored 24, candidate 2 scored
23, candidate 4 scored 12. The judge and the orchestrating session picked the same base.

- **Base: candidate 3** (one `open_data` package behind five names, vocabulary in `core`). It has the cleanest
  boundary with no new layer, an answer that is trim-proof by construction, the strongest snapshot checks, and
  the only plan that keeps the pinned discovery tests from moving. It also avoided a trap the others could
  fall into: `understanding/sites.py` lists "국민연금" as a known site, so a guard on "mentions a known site"
  would send "국민연금 지사 어디야?" to the wrong intent.
- **From candidate 1:** the intent carries no model-written text (taken further here: no parameters at all);
  a pending ask-back is consumed once and only when the rules parse the reply as UNKNOWN; the form-value
  guard on the rule; Korean-numeral dong names; `--csv` with a per-dataset reference date.
- **From candidate 2:** entries carry their own `source`; programme period is not an application window; the
  "bare reply" rule for ask-backs; `_maybe_spoken_secret` yields to a pending place question; the sync refusal
  thresholds and `--release`; plain digits for non-Korean sessions; the programme-name guard on the rule.
- **From candidate 4:** nothing structural in v1. Its typed `Origin` union for programmes is the deeper fix
  for the catalog and is recorded as a follow-up.
- **Rejected:** a new top-level `opendata` layer (candidate 2; three layer-table rows for no extra isolation);
  replacing the dict catalog with typed programmes now (candidate 4; breaks every agent test); a three-row
  sample shipped as production data (candidate 1; would answer "not in this data" for almost everyone);
  inferring a private programme's region from free text and dropping it (candidate 1); three-sentence answers
  (candidate 1; the source is cut under the short setting).

## Verified so far

Checked against the real code on 2026-11-18, read-only:

- The two-sentence answers keep both the phone number and the source through the real `_trim_speech` split;
  a three-sentence answer loses the source.
- `speech/phrasing.py` imports only `core.jsutil` and `safety.privacy`, so the new layer edge is acyclic.
- `understanding/sites.py:43` lists "국민연금공단" and "국민연금" as a known site.
- A prototype of the rule guard, using the real `_SERVICE_REF`, `_GO_THERE` and `mentions_known_site`,
  classified 17 of 17 sentences as intended (9 place requests, 8 that must stay with other intents).
- `DISCOVER` is an existing intent row with no parameters, so a parameter-free `FIND_PLACE` fits the registry.

Not verified: anything that needs a full file. Only the header and three rows of each file dataset were read,
and no row of the standard dataset 15028207.

## Tradeoffs accepted

- We accept answers up to a year old, with the reference date always spoken, in exchange for exact lookups,
  offline tests and no dependence on the portal during a voice turn.
- We accept more turns for the user (asking for the 동) in exchange for never choosing among several offices.
- We accept that the user must say their region once per question, in exchange for a before-consent intent
  with no personal-data path.
- We accept "a branch located in your district", not "your branch", because jurisdiction is not in the data.
- We accept private programmes listed nationwide, with a spoken note when the eligibility text names a region,
  in exchange for not inferring a region limit from free text.
- We accept that a private programme is reached through discovery and follow-ups, not by saying its name
  cold, because the programme-name pattern is left alone.
- We accept one layer-table edit in exchange for correct particles and a one-call place interface.
- We accept phone numbers written as digit words in Korean reply text, in exchange for a guaranteed reading on
  both voice paths with no change to the web UI.

## Alternatives considered

- **Live API calls plus retrieval over everything** (the starting idea). Every answer inherits key approval,
  release-path and network failures; tests need mocks for four APIs; retrieval over office names returns a
  similar dong. The interface is small but hides nothing the user cares about.
- **A third agent, or a new top-level data layer.** Stronger isolation, but the snapshot machinery is shared
  by programmes and places, and each new layer adds rows to keep in step in the layer table.
- **Extend the duck-typed provider** (`provider.places()`, a merged `catalog`). Every provider fake breaks, and
  a 6-hour cache with a process-wide error flag does not fit annual files.
- **Sentences built in `speech/` with the orchestrator as glue.** Keeps the layer table, but the orchestrator
  coordinates three calls and the outcome types move into `core`.
- **Region as a slot the model fills.** The model could write a dong name the user never said.

## Decisions for the owner

1. **Ship the data or sync on first run?** The design works either way. Recommended: commit the real, full
   snapshots of the three file datasets so the app answers out of the box and yearly changes are reviewable
   diffs. The portal records "이용허락범위 제한 없음" for 15116392, 15059715 and 15010814; the licence field
   for 15028207 was blank in the catalog and needs a look.
2. **API key or CSV first?** Recommended: start with `--csv` downloads, which need no key, and apply for API
   access per dataset later. 15028207 has not been fetched by either route yet.
3. **Phone numbers as digit words in the text?** Recommended yes. The alternative keeps "02-2176-9949" in the
   text and reads it digit by digit in `speaker.js`, which is a web UI change but keeps transcripts cleaner.
4. **Private programmes in 맞춤 찾기 by default?** Recommended yes, labelled "민간 사업", with region-limited
   ones noted, not hidden.
5. **"신청 도와줘" on a private programme.** Recommended for v1: read how to apply; do not open the
   organisation's site.
6. **Accept the layer change** (`agents.welfare → speech.phrasing`)?
7. **Vault address.** Not used in v1. Is an explicit "저장된 주소의 구로 찾을까요?" after consent ever wanted?

## Risks

- Formats the normalisers depend on are unverified: how 15059715 writes a 시군구 with a 구 ("성남시 수정구" or
  "성남시수정구"), its office-name endings, the field names of 15028207, and whether the private file's tag
  words match the labels discovery uses. Each fails loudly at sync, and one real download settles them.
- The new rule could take a sentence the user meant for the screen ("이 페이지에서 주민센터 전화번호"). The
  answer would still be official and cited.
- `today_iso()` is the UTC date, so the ended-programme check shifts by up to nine hours.
- Elliptical follow-ups after an answer ("전화번호는?") are not supported.
- The four candidate sketches, the grounding notes and the judge's report are in this session's temporary
  folder and are not in the repo.

## Verification

The refresh and import commands processed each full publication. A running server returned HTTP 200 for
`/api/health` with the three bundled counts above. A session asked for the user's region, offered five
administrative offices in 강남구 개포동, and selected 개포2동 only after the user chose option 2. A separate
request for the pension branch in 서대문구 returned its address, public phone number and reference date.
