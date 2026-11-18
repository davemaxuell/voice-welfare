"""
사이트 이름 → 주소. 목록에 없는 이름은 추측하지 않고 사용자에게 주소를 묻는다.
(주소를 직접 말하면 그대로 연다: "gov.kr 열어줘")
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from cheongeum.core.jsutil import B, I, rx, try_url


@dataclass
class KnownSite:
    names: list[str]
    url: str
    label: str
    # "이 사이트 뭐야"에 답할 한 줄 소개(일반적으로 알려진 성격만)
    about: str | None = None


KNOWN_SITES: list[KnownSite] = [
    # 복지·공공
    KnownSite(["복지로", "bokjiro", "bokjiro.go.kr"], "https://www.bokjiro.go.kr", "복지로", "보건복지부가 운영하는 복지 포털로, 복지 제도를 찾아보고 온라인으로 신청할 수 있는 곳"),
    KnownSite(
        ["정부24", "정부 24", "정부이십사", "민원24", "민원 24", "민원이십사", "gov24", "government24", "government 24"],
        "https://www.gov.kr",
        "정부24",
        "정부 민원 포털로, 각종 증명서 발급과 민원 신청을 온라인으로 하는 곳",
    ),
    KnownSite(["홈택스", "손택스", "hometax", "home tax"], "https://www.hometax.go.kr", "홈택스", "국세청의 세금 신고·납부 사이트로, 연말정산과 종합소득세 신고 등을 하는 곳"),
    KnownSite(["국세청"], "https://www.nts.go.kr", "국세청", "세금을 담당하는 정부 기관의 누리집"),
    KnownSite(["국민신문고", "신문고"], "https://www.epeople.go.kr", "국민신문고", "정부에 민원·제안·신고를 올리는 사이트"),
    KnownSite(["고용24", "고용 24", "워크넷", "고용노동부 일자리"], "https://www.work24.go.kr", "고용24", "고용노동부의 일자리·실업급여·직업훈련 통합 사이트"),
    KnownSite(
        ["국민건강보험공단", "건강보험공단", "국민건강보험", "건강보험"],
        "https://www.nhis.or.kr",
        "국민건강보험공단",
        "건강보험과 장기요양보험을 운영하는 공단의 누리집으로, 보험료와 건강검진 등을 확인하는 곳",
    ),
    KnownSite(["건강보험심사평가원", "심평원"], "https://www.hira.or.kr", "건강보험심사평가원"),
    KnownSite(
        ["국민연금공단", "국민연금", "national pension service"],
        "https://www.nps.or.kr",
        "국민연금공단",
        "국민연금을 운영하는 공단의 누리집으로, 연금 가입 내역과 수령 안내를 보는 곳",
    ),
    KnownSite(["기초연금"], "https://basicpension.mohw.go.kr", "기초연금", "기초연금 제도를 안내하는 보건복지부 누리집"),
    KnownSite(
        ["보건복지부", "복지부", "ministry of health and welfare"],
        "https://www.mohw.go.kr",
        "보건복지부",
        "복지·보건 정책을 맡은 정부 부처의 누리집으로, 정책 소식과 보도자료가 올라오는 곳",
    ),
    KnownSite(["행정안전부", "행안부"], "https://www.mois.go.kr", "행정안전부"),
    KnownSite(["보건복지상담센터", "129"], "https://www.129.go.kr", "보건복지상담센터", "복지 제도 상담을 해 주는 보건복지상담센터 누리집"),
    KnownSite(["한국장애인고용공단", "장애인고용공단"], "https://www.kead.or.kr", "한국장애인고용공단"),
    KnownSite(["정책브리핑", "대한민국 정책브리핑"], "https://www.korea.kr", "대한민국 정책브리핑", "정부 정책 소식을 모아 알리는 정부 공식 사이트"),
    KnownSite(["서울시", "서울특별시"], "https://www.seoul.go.kr", "서울특별시"),
    KnownSite(["코레일", "레츠코레일", "korail"], "https://www.letskorail.com", "코레일", "기차표를 예매하는 한국철도공사 사이트"),
    # 포털·일반
    KnownSite(["네이버 지도", "naver map"], "https://map.naver.com", "네이버 지도", "네이버의 지도·길찾기 서비스"),
    KnownSite(["네이버 뉴스", "naver news"], "https://news.naver.com", "네이버 뉴스", "여러 언론사 기사를 모아 보여 주는 네이버의 뉴스 서비스"),
    KnownSite(
        ["네이버", "naver"],
        "https://www.naver.com",
        "네이버",
        "한국에서 가장 많이 쓰는 포털 사이트로, 검색·뉴스·날씨·쇼핑·지도 등을 한곳에서 쓸 수 있는 곳",
    ),
    KnownSite(["구글", "google"], "https://www.google.com", "구글", "세계적으로 많이 쓰는 검색 사이트"),
    KnownSite(["유튜브", "youtube", "you tube"], "https://www.youtube.com", "유튜브", "동영상을 보고 올리는 사이트"),
    KnownSite(["다음 사이트", "다음 포털", "다음넷", "daum"], "https://www.daum.net", "다음", "카카오가 운영하는 포털 사이트로, 검색·뉴스·메일 등을 쓸 수 있는 곳"),
]


def site_name_from(text: str) -> str:
    """사이트 이름만 남기기(검색어로 쓰려고): "우리동네복지관 사이트 열어줘" → "우리동네복지관" """
    t = rx(r"(홈페이지|누리집|웹\s*사이트|사이트|페이지)").sub(" ", text)
    t = rx(r"(을|를|에|로|으로|좀)?\s*(열어|접속|들어가|이동해|가|켜|띄워)\S*\s*(줘|주세요|봐)?").sub(" ", t)
    return rx(r"\s+").sub(" ", t).strip()


DOMAIN = rx(B + r"((?:https?:\/\/)?(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s]*)?)", I)


def _norm(s: str) -> str:
    return rx(r"\s").sub("", s).lower()


def mentions_known_site(text: str) -> bool:
    t = _norm(text)
    return any(_norm(n) in t for s in KNOWN_SITES for n in s.names) or bool(DOMAIN.search(text)) or near_site(text) is not None


def _one_edit_apart(a: str, b: str) -> bool:
    """글자 하나 차이"""
    if a == b or abs(len(a) - len(b)) > 1:
        return a == b
    i = j = edits = 0
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            i += 1
            j += 1
            continue
        edits += 1
        if edits > 1:
            return False
        if len(a) > len(b):
            i += 1
        elif len(b) > len(a):
            j += 1
        else:
            i += 1
            j += 1
    return edits + (len(a) - i) + (len(b) - j) <= 1


def near_site(text: str, extra: Sequence[KnownSite] = ()) -> KnownSite | None:
    """
    받아쓰기가 사이트 이름을 한 글자 틀리게 적은 경우("네이보 열어줘", "복지루")를 알려진 사이트로 맞춘다.
    세 글자 이상 한글 이름끼리, 한 글자 차이만 인정(짧은 이름은 오인 위험이 커서 제외).
    """
    tokens = [rx(r"(으로|에서|을|를|로|에|좀|이|가)$").sub("", rx(r"[^가-힣]").sub("", w)) for w in rx(r"\s+").split(text)]
    tokens = [w for w in tokens if len(w) >= 3]
    for s in [*extra, *KNOWN_SITES]:
        for n in s.names:
            name = rx(r"\s").sub("", n)
            if len(name) < 3 or not rx(r"^[가-힣]+$").search(name):
                continue
            if any(w != name and len(w) == len(name) and _one_edit_apart(w, name) for w in tokens):
                return s
    return None


def resolve_site(target: str, extra: Sequence[KnownSite] = ()) -> dict | None:
    """이름이나 주소를 실제 URL로. 연습용 모의 사이트는 extra로 넘긴다. → {'url', 'label'}"""
    t = _norm(target)
    all_sites = [*extra, *KNOWN_SITES]
    hits = [(s, _norm(n)) for s in all_sites for n in s.names if _norm(n) in t]
    if hits:
        s, _ = sorted(hits, key=lambda x: -len(x[1]))[0]
        return {"url": s.url, "label": s.label}
    near = near_site(target, extra)
    if near:
        return {"url": near.url, "label": near.label}
    spoken = rx(r"\s*(닷|점)\s*(컴|com)").sub(".com", target)
    spoken = rx(r"\s*(닷|점)\s*(케이알|kr)").sub(".kr", spoken)
    m = DOMAIN.search(spoken)
    if not m:
        return None
    raw = rx(r"[.,)]+$").sub("", m.group(1))
    # 로컬 주소(localhost, IP)는 http, 그 외 도메인은 https로 연다.
    local = bool(rx(r"^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)", I).search(raw))
    url = raw if rx(r"^https?:\/\/", I).search(raw) else f"{'http' if local else 'https'}://{raw}"
    u = try_url(url)
    return {"url": url, "label": u.host} if u else None
