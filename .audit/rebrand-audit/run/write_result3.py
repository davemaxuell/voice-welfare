import sys
from pathlib import Path

OUT = Path(sys.argv[1])
R = "research_notes/피클 AI 에이전트 청음 적용 검토/"
CB = R + "cheongeum_current_build.md"
FU = R + "pickle_features_ux.md"
SP = R + "pickle_safety_privacy.md"
BK = "drafts/sound-cues/bake_start_done.py"

rows = [
    (CB, "21", "ID", "consider",
     "a login *button* is refused by the read-only rule and the user is told to press it with their screen reader",
     "Dated inventory (2026-11-18) that treats the user as a screen-reader user; behavior has since changed (login pressed after '눌러'). Reused in the Pickle-fit report it misstates audience.",
     "Leave as dated record with a note: superseded; the user may have no screen reader, and 청음 now moves to the button and presses it on '눌러'."),
    (CB, "50", "GAP", "consider",
     "**Languages.** `lang` ∈ ko, en, zh, ja",
     "Records 청음's 4 languages; vs main 결혼이민자 origins (중국·베트남·필리핀·일본·캄보디아·태국) Vietnamese, Tagalog, Khmer, Thai are missing and fixed UI text stays Korean. Fix is in code.",
     "비교 보고서에 결혼이민자 언어 공백을 적고, 코드(server/app.py, language/i18n.py)에서 베트남어부터 추가 검토."),
    (CB, "55", "ID", "consider",
     "Silence during long tasks plus a closed mic during processing are the main voice-UX weaknesses for a blind user",
     "Judges voice UX against the blind user only; the same weaknesses hit older and first-time users. Dated record that feeds the Pickle comparison.",
     "\"...for users who rely on voice (blind users, older adults, first-time users)\" or keep as dated record with a note."),
    (CB, "211", "ID", "consider",
     "the virtual cursor is a sighted-observer (demo/companion) feature rather than something the blind user perceives.",
     "Assumes the user cannot see (also L197 'for demos'). For sighted 고령층·결혼이민자 the cursor is a user-facing aid showing where 청음 acts; a report built on this would undervalue it.",
     "가상 커서를 '눈으로 보는 사용자에게 청음이 어디를 누르는지 보여 주는 장치'로 다시 평가해 적기."),
    (CB, "216", "ID", "consider",
     "but real blind-user testing count is 0",
     "Frames the missing user tests as blind-only; the gap now covers every 정보취약계층 group. Dated record.",
     "\"real-user testing count is 0 (no group tested yet)\""),
    (CB, "226", "GAP", "consider",
     "plan for 3–5 participants, 12 task cards, SUS + trust ratings, crossover vs own screen reader",
     "Records a user-test plan whose baseline is the participant's own screen reader, so it fits blind users only; 고령층·결혼이민자 have no baseline. The fix belongs in docs/user-test/plan.md.",
     "기록에 한계를 적고, plan.md에 다른 집단과 그들의 비교 조건(혼자 웹으로 하기, 주민센터 도움 등)을 추가."),
    (CB, "229", "ID", "consider",
     "there is no end-user installer path for a blind user to install unaided.",
     "Developer-style install (repo + uv + Node) blocks older and non-technical users as much as blind ones; naming only blind users narrows the gap. Dated record.",
     "\"...for a 정보취약계층 user (or a helper) to install unaided.\""),
    (FU, "221", "ID", "consider",
     "A remote-screen viewer with pinch and two-finger gestures is the opposite of what a blind user can operate",
     "Forward recommendation ('청음 should lean on the latter') weighed for blind users only; sighted older users may also want a visible approval card beside the spoken hand-off.",
     "말로 하는 인계는 유지하고, 눈으로 보는 사용자를 위한 화면 표시(승인 카드)도 함께 평가해 적기."),
    (FU, "234", "GAP", "consider",
     "## 3. Accessibility — blind/low-vision and elderly users",
     "Accessibility comparison covers blind and elderly users only; 결혼이민자 (Pickle is ko/en/ja, L331), low-literacy and other disabled users are not assessed, so the comparison misses part of the audience.",
     "결혼이민자 언어·쉬운 말·청각 관점을 추가하거나, 조사 범위가 좁다고 명시."),
    (FU, "249", "ID", "consider",
     "whitespace for 청음: an agent where approvals, progress, and hand-offs are designed voice-first and screen-reader-native",
     "Positions 청음 as screen-reader-native, the old blind-only identity; under the rebrand the whitespace is voice-first help for anyone who struggles with the web.",
     "\"...voice-first and usable without reading the screen, for 정보취약계층 (blind users included).\""),
    (FU, "298", "ID", "consider",
     "Both are high-value for blind users too.",
     "Uses blind users as 청음's reference audience; the same value applies to 고령층 and 결혼이민자 who do not know where to apply. Minor; dated record.",
     "\"Both are high-value for 정보취약계층 (고령층, 시각장애인 등) too.\""),
    (SP, "329", "ID", "consider",
     "청음's blind-first design addresses a gap Pickle leaves open.",
     "Calls 청음 'blind-first', contradicting the rebrand; this inference is a recommendation likely to be copied into the Pickle-fit report. Dated record, but do not reuse the wording.",
     "\"청음's voice-first design for 정보취약계층 (screen-free use kept) addresses a gap Pickle leaves open.\""),
    (SP, "332", "GAP", "consider",
     "No evidence on how Pickle performs for blind/low-vision users (no reviews or press on accessibility found).",
     "The only audience gap searched is blind/low-vision; fit for 고령층, 결혼이민자 or low-literacy users was not looked for, so the §9 relevance lens skips most of the new audience.",
     "고령층·결혼이민자 사용 후기와 쉬운 말 여부를 조사 범위에 추가하거나, 조사하지 않았다고 명시."),
    (BK, "29", "GAP", "consider",
     "y = soft(x[start : start + int(0.022 * SR)])",
     "Shipped start/done cues (web/static/cues/start.ogg, done.ogg) are cut to 22 ms, tuned only to dodge the clap detector; older users with hearing loss or first-time users may miss or not learn them.",
     "고령층 청취자로 들리는지 확인하고, 박수 감지를 피하면서 조금 더 긴(약 0.1초) 부드러운 소리나 기본 음량을 검토."),
]

files = [
    ("drafts/sound-cues/_src/snd01.json", "full"),
    ("drafts/sound-cues/audition.html", "full"),
    (BK, "full"),
    ("drafts/sound-cues/build.py", "full"),
    ("drafts/sound-cues/manifest.js", "full"),
    ("drafts/sound-cues/synth.js", "full"),
    ("pyproject.toml", "full"),
    (CB, "full"),
    (FU, "chunks"),
    (SP, "chunks"),
]

errs = []
for r in rows:
    assert len(r) == 7
    for f in r:
        if "\t" in f or "\n" in f:
            errs.append(("tab/newline", r[0], r[1]))
    if len(r[4]) > 120:
        errs.append(("excerpt", r[0], r[1], len(r[4])))
    if len(r[5]) > 200:
        errs.append(("why", r[0], r[1], len(r[5])))
    if len(r[6]) > 200:
        errs.append(("suggestion", r[0], r[1], len(r[6])))
if errs:
    for e in errs:
        print("ERR", e)
    sys.exit(1)

lines = ["\t".join(r) for r in rows]
for path, mode in files:
    n = sum(1 for r in rows if r[0] == path)
    lines.append("\t".join([path, "-", "CHECKED", "-", str(n), mode, "-"]))
OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("wrote", len(rows), "findings,", len(files), "CHECKED rows")
