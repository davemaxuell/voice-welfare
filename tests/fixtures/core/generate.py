"""
Writes the expected values for the core package's table-driven tests by running the Python reference (77aad3e).

Run it with the Python reference environment, never with the owner's checkout:
  cd <pyref worktree> && uv run --frozen python -I <this file>
It writes one JSON file per module next to this script. The Vitest files under tests/unit read them.
"""
import ast
import inspect
import json
import sys
import textwrap
from pathlib import Path

from cheongeum.core import lexicon, places, region

OUT = Path(__file__).resolve().parent
sys.stdout.reconfigure(encoding="utf-8")

LATIN_SPECIALS = {"i": "İı", "I": "İı", "k": "K", "K": "K", "s": "ſ", "S": "ſ"}
SPACES = ["", " ", "　", "\n", "\t", "\x1f", "\x1c", " ", "﻿", "\u0085"]
TAILS = [".", "!", "。", "~", "?", " .", "?!"]


def unique(items):
    return list(dict.fromkeys(items))


def mutate_latin(text):
    """Case variants and the letters Python's IGNORECASE treats specially (İ, ı, Kelvin sign, long s)."""
    out = [text, text.upper(), text.capitalize(), text.title()]
    for position, char in enumerate(text):
        for special in LATIN_SPECIALS.get(char, ""):
            out.append(text[:position] + special + text[position + 1:])
    out.append("".join(chr(ord(c) + 0xFEE0) if "a" <= c <= "z" else c for c in text))
    return out


def variants(text, heavy=False):
    out = [text] + [text + tail for tail in TAILS]
    out += [" " + text + " ", text + "　", "\x1f" + text, text + "﻿"]
    if " " in text:
        out += [text.replace(" ", ""), text.replace(" ", "　"), text.replace(" ", "\x1f")]
    if heavy:
        for space in SPACES:
            out += [space + text, text + space]
    return out


KOREAN = [
    "승인", "모의접수 승인", "모의 접수 승인합니다", "네 승인", "예, 승인할게요", "응 승인해 줘", "승인이요", "승인했어", "승인 안 해",
    "응", "네", "예", "눌러줘", "눌러 줘", "눌러주세요", "눌러", "진행해줘", "진행해 줘", "진행해", "진행하세요", "진행", "보내줘", "보내 줘",
    "보내세요", "네, 진행해", "네 접수해", "응 좋아", "네좋아", "네 진행해 좋아", "아니", "아뇨", "아니요", "아니야", "틀렸어", "취소",
    "거절", "하지 마", "하지마", "안 할래", "안할래", "보내지 마", "보내지마", "아니 그건 좀", "이 버튼 눌러도 돼?", "응 근데 이거 뭐야",
    "알았어요", "알았어", "알겠어", "알겠어요", "알겠습니다", "알았습니다", "알았고", "오케이", "오키", "그래", "그래요", "그렇구나", "그렇군요",
    "고마워", "고마워요", "감사합니다", "네 알겠어요", "네알겠어요", "응 그래", "응그래", "응 알았어", "알았어 다음", "괜찮아", "괜찮아요",
    "아니 괜찮아", "아니괜찮아", "됐어", "아냐", "아니에요", "어", "맞아", "맞아요", "맞습니다", "네맞아요", "응맞아", "글쎄",
    "다 했어요", "다했어요", "다 했어", "했어요", "했어", "끝났어요", "끝났어", "마쳤어요", "됐어요", "완료했어요", "완료됐습니다", "완료", "끝", "다 끝",
    "인증이 끝났어요", "인증을 다 했어요", "인증 끝났어", "본인인증 완료했어", "본인 인증을 마쳤어요", "로그인했어요", "로그인 완료했어", "로그 인 했어요",
    "로그인을 다 했어요, 아니 아직이에요", "로그인 완료했어?", "다음으로", "입력했어요", "다 입력했어", "넣었어", "넣었습니다", "인증번호 입력했어요",
    "인증을 입력했어", "로그인이 입력했어요", "네, 로그인했어요", "응. 다 했어요", "네 다 입력했어요",
    "인증 취소", "취소해줘", "취소해 줘", "취소해요", "취소해", "취소하세요", "취소할게요", "그만", "그만해", "그만해줘요", "그만해주세요", "인증 그만",
    "로그인 취소", "본인인증을 취소해 줘", "인증이 취소", "취소 수수료 얼마야", "인증 취소하지 마세요", "취소했어요",
]
ENGLISH = [
    "yes", "Yes, go ahead", "yeah", "yep", "ok", "okay", "sure", "approve", "approved", "i approve", "I approve", "confirm", "confirmed",
    "go ahead", "do it", "proceed", "yes please", "yes, please approve", "yes please go ahead", "sure thing", "yes proceed", "okay proceed",
    "approve it", "no", "nope", "don't", "dont", "don’t", "cancel", "reject", "not now", "no thanks", "nothing", "note", "nope not now",
    "I'm done", "I’m done", "im done", "I am done", "all done", "done", "finished", "I'm finished with sign-in", "done with log in",
    "done with verification", "all done with login", "I am all done with signin", "apple done tree", "I'll let you know when I'm done",
    "I'm not done yet", "done done", "Please don't cancel", "What happens if I cancel?", "cancel sign in", "cancel sign-in", "cancel login",
    "please cancel the verification, please", "please cancel my log in", "cancel authentication", "Cancel.", "cancel the sign in please",
    "cancel, please", "yes ok", "yes yes", "yes,", "yes .", "yes!!", "yes?!", "Yes please.", "approve, please", "go ahead please",
    "i  approve", "i approve!", "OK!", "ok?", "okay.", "ok go ahead", "ok proceed please",
]
CHINESE = [
    "是", "是的", "好", "好的", "对", "行", "可以", "确认", "同意", "批准", "继续", "是的吧", "好的，确认", "好的吧。", "是啊", "对确认", "继续吧",
    "不", "不要", "不用", "取消", "拒绝", "算了", "不对", "不是", "不用了", "我已经完成了", "完成了。", "好了", "做完了", "弄好了", "已經完成了",
    "已经好了", "我好了", "不要取消", "别以为我已经完成了", "请取消登录", "請取消登入", "取消验证", "取消", "请取消",
]
JAPANESE = [
    "はい", "ええ", "うん", "承認します", "承認", "お願いします", "確認しました", "進めてください", "進めて", "オーケー", "オッケー", "はい、承認します",
    "はい。お願いします。", "いいえ", "いや", "やめて", "キャンセル", "拒否", "結構です", "終わりました！", "終わった", "完了しました", "できました",
    "ログインが終わりました", "認証を完了しました", "ログインは終わった", "「終わりました」とは言っていません", "キャンセルしないでください", "ログインをキャンセルします",
    "キャンセルして", "取り消し", "認証をキャンセルしてください", "取り消しします",
]


KEY_TEXTS = [
    "네", "예", "응", "어", "맞아", "맞아요", "맞습니다", "그래", "그래요", "좋아", "네 맞아요", "응 맞아", "yes", "YES", "Yes.", "yeah", "はい", "是", "是的", "对",
    "아니", "아니요", "아뇨", "아니야", "아냐", "아니에요", "틀렸어", "no", "NO", "nope", "いいえ", "不是", "不对", "不用了", " 네 ", "네 .", "네\t.", "네!!", "네？", "네！",
    "ｙｅｓ", "Ｙｅｓ", "yeſ", "YEſ", "ſ", "ß", "ẞ", "STRASSE", "Straße", "ς", "Σ", "σ", "ı", "İ", "i", "I", "ǅ", "ﬁ", "ﬂ", "ΐ", "ᾳ", "µ", "μ", "Ꭰ", "ꭰ", "Ᏸ", "ᏸ", "K", "k", "yesK",
    "네　.", "네\x1f", "네\x1c.", "네 ", "﻿네", "네﻿", "네\u0085", "", " ", ".", "...", "。", "！？", "네 네", "아 니", "yes ok", "Y E S", "😀", "네😀",
    "İstanbul", "ISTANBUL", "ıstanbul", "TITLE", "ǈ", "ŉ", "ǰ", "ΰ", "ᾈ", "ﬃ", "ẛ", "ⅷ", "Ⅷ", "ⓐ", "Ⓐ", "ㅤ", "ᅟ",
]


def ack_sources():
    """ack_kind builds its patterns inline, so read the string literals from its source."""
    tree = ast.parse(textwrap.dedent(inspect.getsource(lexicon.ack_kind)))
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.startswith("^")]


def lexicon_cases():
    texts = []
    for index, text in enumerate(KOREAN + CHINESE + JAPANESE):
        texts.extend(variants(text, heavy=index % 9 == 0))
    for index, text in enumerate(ENGLISH):
        texts.extend(mutate_latin(text))
        texts.extend(variants(text, heavy=index % 9 == 0))
        # a word character glued to the end decides the ASCII boundary (B); under IGNORECASE ı, İ, ſ and the Kelvin sign count as word characters
        texts.extend(text + glued for glued in ("ı", "İ", "ſ", "\u212a", "é", "_", "1", "-"))
    texts.extend(["", " ", "\n", "。", "...", "ㅇㅇ", "네\n", "\n네", "네 \n .", "응\u0000", "😀", "네😀", "yes😀", "yesé", "yesé", "yeşs"])
    texts = unique(texts)
    cases = []
    for text in texts:
        row = {}
        approvals = {lang: lexicon.approval(text, lang) for lang in ("ko", "en", "zh", "ja")}
        approvals = {lang: value for lang, value in approvals.items() if value}
        if approvals:
            row["a"] = approvals
        whole = [lang for lang in ("ko", "en", "zh", "ja") if lexicon.whole_rejection(text, lang)]
        if whole:
            row["w"] = whole
        for key, value in (("g", lexicon.agree(text)), ("k", lexicon.ack_kind(text)), ("i", lexicon.auth_input_done(text)),
                           ("d", lexicon.done_reply(text)), ("dw", lexicon.done_reply(text, whole=True)),
                           ("c", lexicon.cancel_reply(text)), ("x", bool(lexicon.EXPLICIT_APPROVE_KO.fullmatch(text)))):
            if value:
                row[key] = value
        cases.append([text, row])
    keys = [[text, lexicon.command_key(text)] for text in unique(KEY_TEXTS)]
    sets = {"yes": sorted(lexicon._YES), "no": sorted(lexicon._NO)}
    sources = {
        "approve": {k: v.pattern for k, v in lexicon.APPROVE.items()},
        "reject": {k: v.pattern for k, v in lexicon.REJECT.items()},
        "explicitApproveKo": lexicon.EXPLICIT_APPROVE_KO.pattern,
        "plainYesKo": lexicon.PLAIN_YES_KO.pattern,
        "rejectKo": lexicon.REJECT_KO.pattern,
        "authAck": lexicon._AUTH_ACK.pattern,
        "authInputDone": lexicon._AUTH_INPUT_DONE.pattern,
        "done": [p.pattern for p in lexicon._DONE],
        "cancel": [p.pattern for p in lexicon._CANCEL],
        "ack": ack_sources(),
    }
    return {"cases": cases, "keys": keys, "sets": sets, "sources": sources}


REGION_WORDS = [
    "서울", "서울시", "서울특별시", "부산", "부산시", "부산광역시", "대구", "인천", "광주", "광주시", "광주광역시", "대전", "울산", "세종", "세종시",
    "경기", "경기도", "강원", "강원도", "강원특별자치도", "충북", "충청북", "충청북도", "충남", "충청남도", "전북", "전라북", "전라북도", "전남",
    "전라남도", "경북", "경상북도", "경남", "경상남", "제주", "제주도", "제주특별자치도", "전남광주통합특별시", "평양", "미국",
    "종로구", "사상구", "달성군", "수원시", "성남시", "분당구", "청운효자동", "삼락동", "삼성1동", "삼성제1동", "삼성일동", "삼성제일동", "삼성동",
    "상계3.4동", "상계3·4동", "성수1ㆍ2가", "종로1가", "종로가", "신사동", "가창면", "서면", "영등포읍", "중앙동입니다", "상계동이에요", "종로구에서",
    "종로구에는", "종로구의", "동네", "누구", "어디가", "있는가", "이동", "지금가", "혹시", "혹시나", "어느", "어디로", "가구", "1인", "하면", "가려면",
    "집에가면", "사시려면", "가", "구", "동", "시", "면", "읍", "군", "１동", "１２동", "삼성１동", "십이동", "0동", "10동", "9동", "삼성9동", "삼성0동",
    "제1동", "1동", "제동", "삼성제동", "ABC동", "삼성\r1동", "삼성\u20281동", "삼성\n1동", "삼성\u20291동", "abc구", "a·b동", "한글　동",
]
REGION_TEXTS = [
    "부산 사상구 삼락동에 살아요", "서울 종로구 청운효자동이에요", "경기 광주시 오포읍", "광주 광산구 월곡동", "광주시에 살아요", "제주도 제주시", "저는 서울에 사는 1인 가구예요",
    "부산 사상구 주민센터 어디야", "대구 달성군 가창면사무소", "누구 어디가 가까워", "서울특별시 종로구 청운효자동.", "서울, 종로구, 청운동!", "서울…종로구", "서울。종로구",
    "서울\x1f종로구\x1c청운동", "서울　종로구 청운동", "서울  종로구", "  서울 종로구 ", "", " ", "서울에서요", "부산에는", "부산으로", "서울의", "서울은", "서울는",
    "부산 사상구에", "사상구 부산", "1인 가구", "부산 가구", "서울 가구", "서울 1인가구", "울산 중구 학성동", "세종 어진동", "인천 부평구 부개3동", "강원 춘천시 후평1동",
    "삼성1동 주민센터", "삼성제1동 주민센터", "삼성일동 주민센터", "서울시 서울시", "서울 부산", "서울 종로구 중구 청운동 신사동", "서울 종로구 서초구", "종로구 서울", "가려면 서울", "서울 하면",
    "충북 청주시 흥덕구 복대동", "충청북도 청주시", "전북 전주시 완산구", "전남 목포시", "경남 창원시 성산구 상남동", "그냥 아무 말", "아무 말 서울", "서울 아무 말",
    "서울\n종로구", "서울\r종로구", "서울 종로구",
]


def region_cases():
    words = unique(REGION_WORDS)
    texts = unique(REGION_TEXTS + words)
    out = {
        "mention": [[t, _mention(region.parse_region_mention(t)), _mention(region.parse_region_mention(t, bare=True))] for t in texts],
        "afterProvince": [[t, region.district_after_province(t)] for t in texts],
        "dongForms": [[w, sorted(region.dong_forms(w))] for w in words],
        "province": [[w, region.province_name(w)] for w in words],
        "ctpv": region.CTPV,
        "sources": {"particle": region._PARTICLE.pattern, "area": region._AREA.pattern},
    }
    return out


def _mention(m):
    return {"province": m.province, "districts": list(m.districts), "dong": m.dong, "present": bool(m)}


PLACE_TEXTS = [
    "우리 동네 주민센터 어디야?", "국민연금 지사 전화번호 알려줘", "장애인 콜택시 예약 전화", "내 주소지 주민센터에 가야 해?", "어디서 본 정보야? 주민센터", "주소는 서울시 종로구 입력해줘",
    "이 화면의 주민센터 누르기", "기초연금 주민센터 어디", "국민연금 지사 위치", "행정복지센터 위치", "동사무소 전화", "읍 사무소 어디", "면사무소 연락처", "읍사무소 주소", "행정 복지 센터 어디", "주민 센터 전화번호",
    "국민연금공단 강남지사 전화", "국민연금 강남 지사 어디", "국민연금 상담센터 연락", "국민연금 지역본부 위치", "국민 연금 공단 어디", "국민연금공단", "국민연금 어디서 받아", "기초연금 어디서 신청해",
    "장애인콜택시 예약", "장애인 콜 택시 전화", "교통약자 이동지원센터 어디야", "교통약자 이동 지원 센터", "이동지원센터 전화", "이동 지원 센터 예약", "콜택시 어디", "택시 전화",
    "주민센터 버튼 눌러줘", "주민센터 링크 클릭", "주민센터 누르고 전화", "이 페이지 주민센터 어디", "이화면 주민센터 위치", "주소는 부산 주민센터", "내 주소는 서울 주민센터 어디", "주소는 서울이야 주민센터 전화",
    "이름은 홍길동 주민센터 저장", "전화번호는 010 주민센터 넣어줘", "주소는 서울\n입력 주민센터", "주소는 서울\r입력 주민센터 위치", "주소는 서울 입력 주민센터 위치", "주소는\x1f주민센터 어디",
    "주소는 주민센터 어디", "내주소는 주민센터 어디", "우리 집 주소는 서울 입력 주민센터 위치", "우리 집 주소는 서울\r입력 주민센터 위치", "우리 집 주소는 서울\u2028입력 주민센터 위치", "우리 집 주소는 서울\n입력 주민센터 위치", "우리 집 이름은 서울\u2029저장 주민센터 위치", "내 주소는 부산 주민센터", "주민센터 가는 길", "주민센터 가는길", "주민센터 가는\x1f길", "주민센터 찾아줘", "가까운 주민센터", "주민센터 예약",
    "주민센터 문의", "주민센터", "어디 주민센터", "어디", "전화 국민연금 지사", "주민센터 기초생활수급 전화", "주민센터 장애수당 전화", "주민센터 에서 장애인연금 문의", "주민센터 바우처 문의",
    "주민센터 지원사업 어디", "주민센터 어디 지원금", "주민센터 어디 연금", "주민센터 어디 국민연금", "국민연금 지사 어디 장애인연금", "주민센터 어디 한 연금", "주민센터 어디 두글자연금",
    "주민센터 어디서 본", "주민센터 어디서 봤어", "주민센터 어디서 확인했어", "주민센터 어디서 찾은", "주민센터 어디서 나온", "주민센터 어디서 읽은", "주민센터 주소지", "주소지 주민센터", "주민센터 주소지 어디",
    "주민\x1f센터 어디", "주민　센터 어디", "주민센터어디", "행정복지센터문의", "주민센터\n어디", "", " ", "주민", "센터", "어디서 본 주민센터", "어디서 본 주민센터 어디",
]


def _kind_value(kind):
    return kind.value if kind else None


def places_cases():
    texts = unique(PLACE_TEXTS)
    kinds = {k.name: k.value for k in places.PlaceKind}
    return {
        "kinds": kinds,
        "labels": {k.value: v[0] for k, v in places.KINDS.items()},
        "order": [k.value for k in places.KINDS],
        "sources": {k.value: v[1].pattern for k, v in places.KINDS.items()}
        | {"cue": places._CUE.pattern, "screen": places._SCREEN.pattern},
        "cases": [[t, _kind_value(places.place_kind(t)), places.is_place_request(t)] for t in texts],
        "replace": [[t, places.KINDS[k][1].sub(" ", t), k.value] for t in texts for k in places.KINDS if places.KINDS[k][1].search(t)],
    }


def sites_cases():
    from cheongeum.core import sites

    def site(entry):
        return {"names": entry.names, "url": entry.url, "label": entry.label, "about": entry.about, "services": list(entry.services)}

    return {
        "public": [site(s) for s in sites.PUBLIC_SITES],
        "known": [site(s) for s in sites.KNOWN_SITES],
        "agencies": {label: entry.url for label, entry in sites.PUBLIC_AGENCIES.items()},
        "origins": sorted(sites.PUBLIC_ORIGINS),
    }


def picture_cases():
    from cheongeum.core import picture

    return {
        "schemaName": picture.PICTURE_SCHEMA_NAME,
        "screens": list(picture.PICTURE_SCREENS),
        "schema": picture.PICTURE_SCHEMA,
        "system": picture.PICTURE_SYSTEM,
    }


def llm_cases():
    import base64

    from cheongeum.core import llm

    providers = [None, "", "mock", "MOCK", "openai", "OpenAI", "qwen", "Qwen", "openai-compatible"]
    urls = [None, "", "https://api.openai.com/v1", "https://api.openai.com/v1/", "https://example.com/v1", "http://localhost:8000/v1",
            "http://127.0.0.1/v1", "http://localhost.evil.test/v1", "https://example.com/?localhost"]
    rows = []
    for provider in providers:
        for model in (None, "m"):
            for url in urls:
                for key in (None, "k"):
                    cfg = llm.LlmConfig(provider=provider or "", model=model, baseUrl=url, apiKey=key)
                    text = llm.create_structured_llm(cfg)
                    sight = llm.create_vision_llm(cfg)
                    rows.append([provider, model, url, key,
                                 None if text is None else [text.name, text.base_url, text.provider],
                                 None if sight is None else [sight.name, sight.base_url, sight.detail]])
    options = []
    for provider in ("openai", "qwen", "openai-compatible"):
        for effort in (None, "", "low"):
            for timeout in (None, 0, 5000):
                cfg = llm.LlmConfig(provider=provider, model="m", baseUrl="https://example.com/v1", apiKey="k", reasoningEffort=effort, timeoutMs=timeout)
                text = llm.create_structured_llm(cfg)
                options.append(["text", provider, effort, timeout, [text.reasoning_effort, text.timeout_ms]])
    for effort in (None, "", "low"):
        for timeout in (None, 0, 5000):
            cfg = llm.LlmConfig(provider="openai", model="m", apiKey="k", reasoningEffort=effort, timeoutMs=timeout)
            sight = llm.create_vision_llm(cfg, detail="low")
            options.append(["vision", "openai", effort, timeout, [sight.reasoning_effort, sight.timeout_ms, sight.detail]])
    effort_rows = []
    for override in (None, ("gpt-6.2-sol", "low"), ("gpt-6.2-sol", "none"), ("gpt", "high")):
        token = llm.REASONING_EFFORT_OVERRIDE.set(override)
        try:
            for model in ("gpt-6.2-sol", "gpt-6.2-sol-mini", "gpt-6.2-solar", "gpt-6-luna", "gpt", "gpt-5", ""):
                for url in (llm.OPENAI_BASE_URL, llm.OPENAI_BASE_URL + "/", llm.OPENAI_BASE_URL + "//", "https://example.com/v1"):
                    for default in (None, "medium"):
                        effort_rows.append([list(override) if override else None, model, url, default, llm.resolve_reasoning_effort(model, url, default)])
        finally:
            llm.REASONING_EFFORT_OVERRIDE.reset(token)
    parts = []
    for name, mime, data in (("a.pdf", "application/pdf", b"%PDF-1.4\x00\xff"), ("b.png", "image/png", b"\x89PNG\r\n"), ("c.jpg", "image/jpeg", b""),
                             ("d", "", b"x"), ("e.PDF", "APPLICATION/PDF", b"y")):
        parts.append([name, mime, base64.b64encode(data).decode("ascii"), llm.FileAttachment(name, mime, data).content_part()])
    recipients = []
    for url in (llm.OPENAI_BASE_URL, llm.OPENAI_BASE_URL + "/", "http://localhost:11434/v1", "https://api.example.com:8443/v1", "http://[::1]:8000/v1",
                "http://USER:pw@Host.Example/v1", "not a url", "", "//host/v1", "ftp://files.example/v1", "http://127.0.0.1", "https://xn--bb-eka.example/v1",
                "https://한글.example/v1", "localhost:11434/v1", "http:/host/v1", "  https://padded.example/v1", "https://a.example\t.b/v1", "http://[2001:DB8::1]/v1",
                "https://host@evil.example@real.example/v1", "http://:80/v1", "https://example.com:/v1", "HTTP://UPPER.Example/V1"):
        try:
            recipients.append([url, llm.OpenAIStructuredLlm(model="m", base_url=url).file_recipient])
        except ValueError:
            pass
    return {"endpoints": rows, "options": options, "effort": effort_rows, "parts": parts, "recipients": recipients}


def model_stack_cases():
    import asyncio

    import httpx

    from cheongeum.core import llm, model_stack

    async def run(service, method, text, status, content):
        seen = []

        def handler(request):
            seen.append({"url": str(request.url), "authorization": request.headers.get("authorization"),
                         "contentType": request.headers.get("content-type"), "body": json.loads(request.content)})
            return httpx.Response(status, content=content)

        pool = llm.ModelConnections()
        pool._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            out = await getattr(service("sk-test", "model-x", pool), method)(text)
        finally:
            await pool.close()
        return {"out": out, "requests": seen}

    embeds = [
        ("valid", "안녕", 200, '{"data":[{"embedding":[0.1,-2,3]}]}'), ("ints", "a", 200, '{"data":[{"embedding":[1,2]}]}'),
        ("empty data", "a", 200, '{"data":[]}'), ("two items", "a", 200, '{"data":[{"embedding":[1]},{"embedding":[2]}]}'),
        ("item not dict", "a", 200, '{"data":[[1]]}'), ("missing embedding", "a", 200, '{"data":[{}]}'),
        ("empty embedding", "a", 200, '{"data":[{"embedding":[]}]}'), ("bool", "a", 200, '{"data":[{"embedding":[true,1]}]}'),
        ("string", "a", 200, '{"data":[{"embedding":["a"]}]}'), ("null", "a", 200, '{"data":[{"embedding":[null]}]}'),
        ("dict", "a", 200, '{"data":[{"embedding":{"a":1}}]}'), ("list body", "a", 200, "[]"), ("500", "a", 500, '{"data":[{"embedding":[1]}]}'),
        ("not json", "a", 200, "oops"), ("data not list", "a", 200, '{"data":{"embedding":[1]}}'), ("huge", "a", 200, '{"data":[{"embedding":[1e308,2]}]}'),
        ("infinite", "a", 200, '{"data":[{"embedding":[1e999]}]}'), ("nan", "a", 200, '{"data":[{"embedding":[NaN]}]}'),
        ("blank text", "   ", 200, '{"data":[{"embedding":[1]}]}'), ("empty text", "", 200, '{"data":[{"embedding":[1]}]}'),
        ("emoji text", "한글 🎧", 200, '{"data":[{"embedding":[0.5]}]}'), ("float int mix", "a", 200, '{"data":[{"embedding":[1.0,2,-0.0]}]}'),
    ]
    screens = [
        ("flagged", "나쁜 말", 200, '{"results":[{"flagged":true}]}'), ("clean", "좋은 말", 200, '{"results":[{"flagged":false}]}'),
        ("string flag", "a", 200, '{"results":[{"flagged":"true"}]}'), ("empty results", "a", 200, '{"results":[]}'),
        ("two results", "a", 200, '{"results":[{"flagged":true},{"flagged":false}]}'), ("result list", "a", 200, '{"results":[[true]]}'),
        ("no results", "a", 200, "{}"), ("no flag", "a", 200, '{"results":[{}]}'), ("null flag", "a", 200, '{"results":[{"flagged":null}]}'),
        ("int flag", "a", 200, '{"results":[{"flagged":1}]}'), ("429", "a", 429, '{"results":[{"flagged":true}]}'),
        ("blank text", " \n", 200, '{"results":[{"flagged":true}]}'), ("list body", "a", 200, '[{"flagged":true}]'),
    ]
    out = {"stack": {k: getattr(model_stack.STACK, k) for k in ("voice", "agent", "utility", "vision", "recovery", "embedding", "transcription", "moderation")}}
    out["embed"] = [[label, text, status, content, asyncio.run(run(model_stack.EmbeddingService, "embed", text, status, content))] for label, text, status, content in embeds]
    out["screen"] = [[label, text, status, content, asyncio.run(run(model_stack.ModerationService, "screen", text, status, content))] for label, text, status, content in screens]
    return out


def intent_candidates(annotation):
    """Values to try for one intent parameter: the legal range, its edges and the wrong types."""
    import typing

    wrong = [0, 1, None, [], {}, True, 1.5]
    origin = typing.get_origin(annotation)
    if origin is typing.Union:
        inner = [a for a in typing.get_args(annotation) if a is not type(None)][0]
        return [None, "x", "", *intent_candidates(inner)]
    if origin is typing.Annotated:
        base, *meta = typing.get_args(annotation)
        low = high = None
        for item in meta:
            for bound in getattr(item, "metadata", []):
                low = getattr(bound, "min_length", low)
                high = getattr(bound, "max_length", high)
        if typing.get_origin(base) is list:
            fill = {"fieldMention": "이름", "value": "김하늘"}
            sizes = sorted({0, 1, (low or 1), (high or 5), (high or 5) + 1})
            return [[dict(fill) for _ in range(n)] for n in sizes] + [[{"fieldMention": "이름"}], [{"fieldMention": "", "value": "a"}],
                    [{"fieldMention": "이름", "value": "가" * 200}], [{"fieldMention": "이름", "value": "가" * 201}], [{**fill, "extra": 1}], "x", None]
        sizes = sorted({0, 1, low or 1, max(0, (low or 1) - 1), high or 3, (high or 3) + 1} if high else {0, 1, low or 1, max(0, (low or 1) - 1)})
        return ["가" * n for n in sizes] + ["🎧" * (low or 1), "🎧" * (high or 3), "🎧" * ((high or 3) + 1)] + wrong
    if annotation is bool:
        return [True, False, 0, 1, None, "true"]
    if annotation is str:
        return ["", "x", *wrong]
    return wrong


def intents_cases():
    from cheongeum.core.intents import HELP_GROUPS, INTENTS, help_pages
    from cheongeum.core.turn import parse_intent

    table = [{"type": i.type, "describe": i.describe, "help": i.help, "examples": [[e.text, e.state] for e in i.examples],
              "params": [[name, default is ...] for name, (_, default) in i.params.items()], "llm": i.llm, "beforeConsent": i.before_consent}
             for i in INTENTS]
    def meaningful(annotation):
        return next(x for x in intent_candidates(annotation) if x not in (None, "", [], 0, False))

    cases = []
    for spec in INTENTS:
        # a payload that parses: each parameter takes the first candidate that works with the others set to ordinary values
        base = {"type": spec.type}
        for name, (annotation, _) in spec.params.items():
            others = {n: meaningful(a) for n, (a, _) in spec.params.items() if n != name}
            base[name] = next((c for c in intent_candidates(annotation) if parse_intent({"type": spec.type, **others, name: c}) is not None), None)
        payloads = [dict(base), {"type": spec.type}, {**base, "unexpected": "x"}, {"type": spec.type.lower()}, {k: v for k, v in base.items() if k != "type"}]
        for name, (annotation, _) in spec.params.items():
            without = {k: v for k, v in base.items() if k != name}
            payloads.append(without)
            for candidate in intent_candidates(annotation):
                payloads.append({**base, name: candidate})
        for payload in payloads:
            cases.append([payload, parse_intent(payload)])
    cases += [[{"type": "NOPE"}, parse_intent({"type": "NOPE"})], [{}, parse_intent({})], [None, parse_intent(None)], ["READ_MAIN", parse_intent("READ_MAIN")], [[], parse_intent([])]]
    leads = [[], ["신청서"], ["웹 읽기"], ["시작", "복지 정보"], ["언제든"], ["복지 정보", "웹 읽기", "신청서"], ["시작"], list(HELP_GROUPS)]
    pages = [[lead, consented, help_pages(tuple(lead), consented=consented)] for lead in leads for consented in (True, False)]
    return {"table": table, "cases": cases, "pages": pages, "groups": list(HELP_GROUPS)}


def turn_cases():
    from pydantic import ValidationError

    from cheongeum.core import turn

    source = {"title": "복지로", "url": "https://www.bokjiro.go.kr/x", "lastCheckedAt": "2026-11-20"}
    base = {"sessionId": "s", "turnId": "t", "userUtterance": "응", "intentType": "PLAN(FILL>NEXT)", "state": "IDLE", "semanticAction": "none",
            "speech": "확인했어요.", "trace": [], "actions": [], "sources": [], "missingFields": [], "pendingActions": 0, "realSubmission": False,
            "flags": {"secretDetected": False, "masked": False}, "latencyMs": 0}
    review = {"status": "completed", "difficulty": "easy", "rounds": 1, "maxRounds": 3, "browserIterations": 2}
    pending = {"actionId": "a1", "purpose": "모의 접수", "site": "연습", "values": [{"label": "이름", "value": "김"}], "realSubmission": False}
    auth = {"id": "h1", "taskId": "t1", "kind": "login", "status": "waiting", "site": "www.example.org"}
    card = {"answer": "답", "serviceId": "s", "serviceName": "n", "fields": ["a"], "grounded": True, "source": source, "dataKind": "live",
            "dataOrigin": "o", "nextAction": "다음"}
    line = {"text": "안녕하세요", "pose": "welcome"}
    choice = {"key": "auth-done", "label": "로그인했어요"}
    variants = {
        "stopGeneration": [0, 3, -1, 1.5, "1", None, True, 2 ** 60],
        "localSpeechOnly": [True, False, 1, 0, None, "true", 2],
        "review": [review, {**review, "status": "failed"}, {**review, "rounds": -1}, {**review, "maxRounds": 0}, {**review, "maxRounds": 1},
                   {**review, "difficulty": "impossible"}, {**review, "extra": 1}, {k: v for k, v in review.items() if k != "rounds"}, None, [],
                   {**review, "browserIterations": 0.5}, {**review, "rounds": True}],
        "pendingConfirmation": [pending, *({**pending, "kind": k} for k in ("field-entry", "click", "file-transfer", "visual-navigation", "practice-submission",
                                                                                "public-research", "vault-save", "vault-clear", "other", None)),
                                {**pending, "description": "설명"}, {**pending, "description": None}, {**pending, "description": 1},
                                {**pending, "realSubmission": True}, {**pending, "realSubmission": 0}, {**pending, "realSubmission": 1},
                                {**pending, "values": [{"label": "이름"}]}, {k: v for k, v in pending.items() if k != "site"}, {**pending, "extra": 1}],
        "authHandoff": [auth, *({**auth, "kind": k} for k in ("verification", "captcha", "other", None)),
                        *({**auth, "status": v} for v in ("completed", "cancelled", "expired", "interrupted", "blocked", "done", None)),
                        {**auth, "extra": 1}, {k: v for k, v in auth.items() if k != "id"}],
        "answerCard": [card, {**card, "dataKind": "stored"}, {**card, "dataKind": "private-program"}, {**card, "dataKind": "other"}, {**card, "dataDate": "2026-11-17"},
                       {**card, "dataDate": None}, {**card, "source": {**source, "url": "relative"}}, {**card, "source": {**source, "version": "1", "note": "n"}},
                       {**card, "grounded": 1}, {**card, "fields": "a"}, {k: v for k, v in card.items() if k != "nextAction"}, {**card, "extra": 1}],
        "offeredChoices": [[choice], [], [{**choice, "key": "auth-cancel"}], [{**choice, "key": "read-main"}], [{**choice, "key": "approve"}],
                           [{"key": "auth-done"}], [choice, choice], None, {}, [{**choice, "label": 1}]],
        "publicSuggestions": [["서울"], ["a", "b"], ["a", "b", "c"], [], [1], "a", None],
        "introScript": [[line], [], *([{**line, "pose": p}] for p in ("welcome", "listening", "screen-reading", "confirmation", "auth-handoff", "stopped", "complete", "sleeping")),
                        [{**line, "ask": True}], [{**line, "ask": None}], [{**line, "ask": 1}], [{"pose": "welcome"}], [{"text": "a"}], None],
        "semanticAction": [*turn.SEMANTIC_ACTIONS, "review-before-output", "find-place", "describe-picture", "unknown", "", None],
        "state": [*turn.SESSION_STATES, "NOPE"],
        "lang": ["ko", "en", "zh", "ja", "fr", None],
        "accessMode": ["full", "read-only", "none", "other", None],
    }
    cases = [[dict(base), _result(turn, base, ValidationError)]]
    fields = []
    for name, values in variants.items():
        for value in values:
            outcome = _result(turn, {**base, name: value}, ValidationError)
            fields.append([name, value, {"error": True} if "error" in outcome else {"present": name in outcome["ok"], "value": outcome["ok"].get(name)}])
    for payload in ({**base, "unknownKey": 1}, {k: v for k, v in base.items() if k != "latencyMs"}, {**base, "latencyMs": -1}, {**base, "realSubmission": True},
                    {**base, "realSubmission": 0}, {**base, "flags": {"secretDetected": False}}, {**base, "speechPrefs": {"voice": None}},
                    {**base, "speechPrefs": {"rate": 0.9, "length": "short", "voice": "v", "progressSpoken": False}}, {**base, "speechPrefs": {"length": "long"}},
                    {**base, "handoff": {"from": "welfare-information-and-dialogue", "to": "web-navigation-and-execution", "taskId": "t", "goal": "g",
                                         "targetUrl": "u", "sources": [source], "requiresApprovedDomain": True, "domainApproved": True}},
                    {**base, "handoff": {"from_": "welfare-information-and-dialogue", "to": "web-navigation-and-execution", "taskId": "t", "goal": "g",
                                         "targetUrl": "u", "sources": [], "requiresApprovedDomain": 1, "domainApproved": False, "officialUrl": "x"}},
                    {**base, "sources": [source, {**source, "url": "nope"}]}, {**base, "trace": [{"phase": "p", "agent": "a", "atMs": 1, "note": None}]},
                    {**base, "observation": {"page": "p", "url": "u", "title": "t", "fields": [], "errors": []}}, {}, None, [], "x"):
        cases.append([payload, _result(turn, payload, ValidationError)])
    drafts = [["IDLE", "none", "말", {}], ["BROWSING", "read", "말", {"field": None, "value": "v", "lang": "en"}], ["IDLE", "none", "말", {"view": None, "masked": False}]]
    return {"actions": list(turn.SEMANTIC_ACTIONS), "states": list(turn.SESSION_STATES), "labels": turn.STATE_LABELS_KO, "langs": list(turn.LANGS),
            "agents": {k: getattr(turn.AGENT_IDS, k) for k in ("orchestrator", "welfare", "web", "screen", "verifier")},
            "phases": list(turn.PIPELINE_PHASES), "base": base, "fields": fields, "cases": cases, "drafts": [[*d[:3], d[3], turn.draft(*d[:3], **d[3])] for d in drafts]}


def _result(turn, payload, validation_error):
    try:
        return {"ok": turn.parse_turn_result(payload)}
    except (validation_error, TypeError, AttributeError):
        return {"error": True}


def dialogue_cases():
    import re

    from cheongeum.core import dialogue, places, region

    uuid_pattern = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    def normal(value):
        return json.loads(uuid_pattern.sub("<uuid>", json.dumps(value, ensure_ascii=False)))

    action = {"id": "act-1", "type": "click", "reason": "모의 접수", "risk": "consequential", "requiresConfirmation": True}
    fingerprint = {"page": "mock-welfare", "speech": "접수할까요?", "fields": [], "actions": []}

    def confirmation(action_id="act-1", **extra):
        return {"actionId": action_id, "purpose": "모의 접수", "site": "연습", "values": [], "realSubmission": False, **extra}

    submit = {"kind": "submit", "url": "http://localhost/apply", "action": action, "confirmation": confirmation(), "fingerprint": fingerprint}
    bare = {"action": action, "confirmation": confirmation("act-2"), "fingerprint": fingerprint}
    click = {"kind": "click", "url": "http://localhost/x", "then": "login-open", "action": action, "confirmation": confirmation("click-1", kind="click"),
             "fingerprint": fingerprint}
    assist = {"kind": "assist", "url": "http://localhost/x", "guided": True, "action": action, "actions": [action],
              "confirmation": confirmation("assist-1", kind="field-entry", description="넣을까요?"), "fingerprint": fingerprint}
    file = {"kind": "file", "record": {"name": "공고.pdf"}, "digest": "abc", "question": "기한이 언제야?",
            "confirmation": confirmation("file:1", kind="file-transfer", description="보낼까요?")}
    visual = {"kind": "visual", "goal": "신청 링크 찾기", "checkpoint": {"remaining": 3}, "confirmation": confirmation("v-1", kind="visual-navigation")}
    research = {"kind": "research", "goal": "기초연금 조사", "confirmation": confirmation("r-1", kind="public-research", site="청음")}
    vault_save = {"kind": "vault-save", "values": {"name": "김하늘", "phone": "01012345678"}}
    vault_clear = {"kind": "vault-clear"}
    contact = {"name": "김보호", "phone": "01011112222"}
    guardian = {"kind": "guardian-send", "contact": contact, "at": 12.5, "resume": "BROWSING", "message": "도움이 필요해요", "screen": "abc123"}
    region_json = {"province": "서울특별시", "districts": ["종로구"], "dong": ""}
    place = {"kind": "15059715", "region": region_json, "options": ["청운효자동", "삼청동"], "field": "dong"}
    handoff = {"id": "h-1", "session_id": "s-1", "task_id": "t-1", "browser": True, "expected_origin": "https://www.gov.kr",
               "expected_path": "/login", "kind": "login", "deadline": 600.0, "site": "www.gov.kr"}

    scenarios = {
        "approval ask, age and repeat": [["ask_approval", submit], ["tick", 90], ["ask_approval", submit], ["ask_approval", {**submit, "confirmation": confirmation("act-9")}],
                                         ["tick", 5], ["clear_approval"]],
        "approval without a kind": [["ask_approval", bare], ["ask_approval", bare], ["ask_approval", click]],
        "click then assist then file": [["ask_approval", click], ["ask_approval", assist], ["ask_approval", file], ["ask_approval", file]],
        "visual and research": [["ask_approval", visual], ["ask_approval", research], ["clear_approval"]],
        "approval then vault confirm clears approval": [["ask_approval", submit], ["ask_vault_confirm", vault_save], ["take_vault_confirm"]],
        "vault confirm then approval clears vault": [["ask_vault_confirm", vault_clear], ["ask_approval", submit]],
        "vault confirms get a fresh confirmation": [["ask_vault_confirm", vault_save], ["ask_vault_confirm", vault_save], ["ask_vault_confirm", vault_clear],
                                                    ["take_vault_confirm"], ["take_vault_confirm"]],
        "guardian confirm keeps its own fields": [["ask_vault_confirm", guardian], ["ask_vault_confirm", {"kind": "guardian-clear", "contact": contact, "at": 12.5, "resume": "BROWSING"}],
                                                  ["ask_vault_confirm", {"kind": "guardian-save", "contact": contact, "at": 1.0, "resume": "IDLE"}]],
        "profile and place exclude each other": [["ask_profile", "age"], ["ask_place", place], ["ask_profile", "income"], ["ask_place", None],
                                                  ["ask_profile", "household"], ["ask_place", place], ["take_place_ask"], ["take_place_ask"]],
        "profile done and place ask": [["ask_place", place], ["ask_profile", "age"], ["profile_done"]],
        "first run step": [["ask_first_run", "mic"], ["ask_first_run", "name-confirm"], ["end_first_run"], ["ask_first_run", "stop"], ["stop"]],
        "site guess": [["ask_site", {"text": "복지로 열어줘", "label": "복지로"}], ["take_site_guess"], ["take_site_guess"],
                       ["ask_site", {"heard": True, "label": "정부24", "text": "정부이십사"}], ["stop"]],
        "value waits": [["ask_value", "applicantName"], ["value_filled", "other"], ["value_filled", "applicantName"], ["ask_value", "x"], ["navigated", False]],
        "value wait on a form page": [["ask_value", "x"], ["ask_approval", submit], ["navigated", True]],
        "clarification": [["ask_which", "부산", [{"fieldId": "a", "label": "주소"}, {"fieldId": "b", "label": "실거주지"}]], ["clear_choice"]],
        "guided fill": [["start_guided", "https://example.org/form", ["f1", "f2"]], ["end_guided"], ["start_guided", "https://example.org/form", []]],
        "hold auth waiting": [["ask_approval", submit], ["ask_value", "x"], ["ask_vault_confirm", vault_clear], ["hold_auth", {"kind": "form"}, handoff]],
        "hold auth without handoff": [["hold_auth", {"kind": "guided"}, None], ["take_auth_resume"], ["take_auth_resume"]],
        "finish auth": [["hold_auth", {"kind": "form"}, handoff], ["finish_auth", "completed"], ["finish_auth", "cancelled"]],
        "finish auth without handoff keeps nothing": [["hold_auth", {"kind": "form"}, None], ["finish_auth", "expired"]],
        "stop cancels a waiting handoff": [["hold_auth", {"kind": "form"}, handoff], ["stop"]],
        "stop can keep the handoff": [["hold_auth", {"kind": "form"}, handoff], ["stop_preserve_auth"], ["finish_auth", "interrupted"]],
        "stop after a finished handoff": [["hold_auth", {"kind": "guided"}, {**handoff, "kind": "verification"}], ["finish_auth", "blocked"], ["stop"]],
        "clear auth resume": [["hold_auth", {"kind": "form"}, handoff], ["clear_auth_resume"], ["take_auth_resume"]],
        "stop clears every wait": [["ask_approval", submit], ["ask_value", "x"], ["ask_which", "a", ["b"]], ["ask_profile", "age"], ["ask_first_run", "mic"],
                                   ["ask_vault_confirm", vault_save], ["start_guided", "https://example.org/form", ["f1"]], ["ask_site", {"label": "x"}],
                                   ["hold_auth", {"kind": "form"}, handoff], ["stop"], ["commit", "STOPPED"]],
        "stop clears the place ask": [["ask_place", place], ["stop"]],
        "pending: approval": [["ask_approval", submit]],
        "pending: empty awaiting": [["ask_value", ""]],
        "pending: awaiting": [["ask_value", "x"]],
        "pending: clarification": [["ask_which", "a", []]],
        "pending: site guess": [["ask_site", {"label": "x"}]],
        "pending: empty profile": [["ask_profile", ""]],
        "pending: profile": [["ask_profile", "age"]],
        "pending: empty first run": [["ask_first_run", ""]],
        "pending: first run": [["ask_first_run", "intro"]],
        "pending: place": [["ask_place", place]],
        "pending: vault": [["ask_vault_confirm", vault_clear]],
        "pending: guided": [["start_guided", "u", []]],
        "pending: waiting handoff": [["hold_auth", None, handoff]],
        "pending: finished handoff": [["hold_auth", None, handoff], ["finish_auth", "completed"]],
        "state and confirmation expectation": [["commit", "WAITING_FOR_USER_CONFIRMATION"], ["commit", "IDLE"], ["ask_approval", research], ["commit", "BROWSING"]],
    }

    class Clock:
        now = 100.0

    def run(steps):
        clock = Clock()
        clock.now = 100.0
        state = dialogue.DialogueState("IDLE", lambda: clock.now)
        browser = object()
        out = []
        for step in steps:
            op, args = step[0], step[1:]
            ret = None
            if op == "tick":
                clock.now += args[0]
            elif op == "ask_place":
                raw = args[0]
                state.ask_place(None if raw is None else places.PlaceAsk(places.PlaceKind(raw["kind"]), region.RegionMention(raw["region"]["province"],
                                tuple(raw["region"]["districts"]), raw["region"]["dong"]), tuple(raw["options"]), raw["field"]))
            elif op == "hold_auth":
                raw = args[1]
                state.hold_auth(args[0], None if raw is None else dialogue.AuthHandoff(
                    id=raw["id"], session_id=raw["session_id"], task_id=raw["task_id"], browser=browser if raw["browser"] else None,
                    expected_origin=raw["expected_origin"], expected_path=raw["expected_path"], kind=raw["kind"], deadline=raw["deadline"], site=raw["site"]))
            elif op == "stop_preserve_auth":
                state.stop(preserve_auth=True)
            else:
                ret = getattr(state, op)(*args)
            handoff_now = state.auth_handoff
            place_now = state.place_ask
            out.append({
                "op": step,
                "ret": normal(_dump(ret)),
                "after": normal({
                    "state": state.state, "approval": state.approval, "age": state.approval_age, "awaiting": state.awaiting,
                    "clarification": state.clarification, "profileQuestion": state.profile_question,
                    "placeAsk": None if place_now is None else {"kind": place_now.kind.value, "region": {"province": place_now.region.province,
                                "districts": list(place_now.region.districts), "dong": place_now.region.dong}, "options": list(place_now.options), "field": place_now.field},
                    "vaultConfirm": state.vault_confirm, "guided": state.guided, "authResume": state.auth_resume,
                    "authHandoff": None if handoff_now is None else {"public": handoff_now.public(), "sessionId": handoff_now.session_id,
                                "expectedOrigin": handoff_now.expected_origin, "expectedPath": handoff_now.expected_path, "deadline": handoff_now.deadline,
                                "browserHeld": handoff_now.browser is not None},
                    "authWaiting": state.auth_waiting, "pending": state.has_pending_interaction, "firstRun": state.first_run,
                    "confirmation": state.confirmation, "expectsConfirmation": state.expects_confirmation,
                }),
            })
        return out

    return {"approvals": {"submit": submit, "bare": bare}, "scenarios": {name: [steps, run(steps)] for name, steps in scenarios.items()}}


def _dump(value):
    if hasattr(value, "kind") and hasattr(value, "region"):
        return {"kind": value.kind.value, "region": {"province": value.region.province, "districts": list(value.region.districts), "dong": value.region.dong},
                "options": list(value.options), "field": value.field}
    return value


def time_cases():
    from datetime import datetime

    from cheongeum.core import jsutil

    instants = ["2026-11-19T14:59:59+00:00", "2026-11-19T15:00:00+00:00", "2026-11-19T00:00:00+00:00", "2026-11-19T23:59:59.999+00:00",
                "2025-12-31T14:59:59+00:00", "2025-12-31T15:00:00+00:00", "2028-02-28T14:59:59+00:00", "2028-02-28T15:00:00+00:00",
                "2027-02-28T15:00:00+00:00", "2026-01-01T00:00:00+00:00", "2026-06-30T15:00:00+00:00", "1999-12-31T15:00:00+00:00",
                "2026-11-20T04:55:21.336+00:00", "2026-11-20T09:00:00+09:00", "2026-11-20T00:00:00-08:00", "2026-11-20T08:59:59-15:00"]
    rounds = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.4999999999999999, 2.675, 1e15 + 0.5, -0.0, 0, 7, 3.2, -3.7, 123456789.5]
    return {"today": [[iso, jsutil.today_iso(datetime.fromisoformat(iso))] for iso in instants],
            "rounds": [[value, jsutil.js_round(value)] for value in rounds]}


def write(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
    print(name, (OUT / name).stat().st_size)


if __name__ == "__main__":
    write("lexicon.json", lexicon_cases())
    write("region.json", region_cases())
    write("places.json", places_cases())
    write("sites.json", sites_cases())
    write("picture.json", picture_cases())
    write("llm.json", llm_cases())
    write("model_stack.json", model_stack_cases())
    write("intents.json", intents_cases())
    write("turn.json", turn_cases())
    write("dialogue.json", dialogue_cases())
    write("time.json", time_cases())
