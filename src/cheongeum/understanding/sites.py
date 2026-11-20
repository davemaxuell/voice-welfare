"""
사이트 이름 → 주소. 목록에 없는 이름은 추측하지 않고 사용자에게 주소를 묻는다.
(주소를 직접 말하면 그대로 연다: "gov.kr 열어줘") 거꾸로 주소 → 말할 사이트 이름은 site_label.
"""
from __future__ import annotations

from typing import Sequence

from cheongeum.core.sites import KNOWN_SITES, KnownSite
from cheongeum.core.jsutil import B, I, rx, try_url


def site_name_from(text: str) -> str:
    """사이트 이름만 남기기(검색어로 쓰려고): "우리동네복지관 사이트 열어줘" → "우리동네복지관" """
    t = rx(r"(홈페이지|누리집|웹\s*사이트|사이트|페이지)").sub(" ", text)
    t = rx(r"(을|를|에|로|으로|좀)?\s*(열어|접속|들어가|이동해|가|켜|띄워)\S*\s*(줘|주세요|봐)?").sub(" ", t)
    return rx(r"\s+").sub(" ", t).strip()


DOMAIN = rx(B + r"((?:https?:\/\/)?(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s]*)?)", I)


def _norm(s: str) -> str:
    return rx(r"\s").sub("", s).lower()


def service_topic(site: KnownSite, text: str) -> str:
    words = _norm(text)
    if site.label == "한국장학재단" and "국가장학금" in words:
        if "다자녀" in words:
            return "다자녀국가장학금"
        if rx(r"(?:2|Ⅱ|ⅱ|ii)유형").search(words):
            return "국가장학금2유형"
        if rx(r"(?:1|Ⅰ|ⅰ|i)유형").search(words):
            return "국가장학금1유형"
    return next((term for term in site.services if term in words), "")


def public_service_site(text: str) -> KnownSite | None:
    """명시된 기관이 우선한다. 다른 사이트나 여러 기관을 말했으면 업무 이름만으로 목적지를 정하지 않는다."""
    words = _norm(text)
    named = [s for s in KNOWN_SITES if any(_norm(n) in words for n in s.names)]
    if named:
        return named[0] if len(named) == 1 and named[0].services else None
    if DOMAIN.search(text):
        return None
    matches = [s for s in KNOWN_SITES if any(term in words for term in s.services)]
    if len(matches) == 1:
        return matches[0]
    if rx(r"^민원(?:사이트|홈페이지|누리집)?(?:에서|으로|로|에|을|좀|열|접속|들어|가|$)").search(words):
        return next(s for s in KNOWN_SITES if s.label == "정부24")
    return None


def is_site_name(text: str) -> bool:
    bare = rx(r"(?:사이트|누리집|홈페이지)?(?:요|이요)?[.!?]*$").sub("", _norm(text))
    return bare == "민원" or any(_norm(n) == bare for s in KNOWN_SITES for n in s.names)


def mentions_known_site(text: str, fuzzy: bool = True) -> bool:
    """fuzzy면 받아쓰기가 한 글자 틀린 이름(near_site)도 친다. '복지관'·'신문사'처럼 낱말이 비슷한 경우가 있어 순위를 바꾸는 규칙은 끈다."""
    t = _norm(text)
    exact = any(_norm(n) in t for s in KNOWN_SITES for n in s.names) or bool(DOMAIN.search(text))
    return exact or (fuzzy and near_site(text) is not None)


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


def near_site_guess(text: str, extra: Sequence[KnownSite] = ()) -> tuple[KnownSite, str] | None:
    """
    정확한 사이트 이름·주소 없이 한 글자 다른 이름만 있으면 (사이트, 그 낱말). '복지관'·'신문사'처럼 진짜 낱말일 수 있어
    부르는 쪽이 "'복지로' 말씀이세요?" 하고 확인한다(주인 결정 2026-11-19).
    """
    # 목적지 자리의 낱말만 본다: '…에서·…로·…가서' 또는 바로 뒤에 '열어·들어가·접속'
    sites = [*extra, *KNOWN_SITES]
    exact = {rx(r"\s").sub("", n) for s in sites for n in s.names}
    words = rx(r"\s+").split(text.strip())
    for i, raw in enumerate(words):
        after = words[i + 1] if i + 1 < len(words) else ""
        if not (rx(r"(에서|으로|로|에|가서)$").search(raw) or rx(r"^(열어|들어가|접속|가\s*줘|켜)").search(after)):
            continue
        w = rx(r"(으로|에서|가서|을|를|로|에|좀|이|가)$").sub("", rx(r"[^가-힣]").sub("", raw))
        # '복지로'는 '복지부'와 한 글자 차이지만 그 자체로 정확한 이름이다
        if w in exact:
            continue
        for s in sites:
            for n in (rx(r"\s").sub("", name) for name in s.names):
                if len(n) >= 3 and rx(r"^[가-힣]+$").search(n) and len(w) == len(n) and _one_edit_apart(w, n):
                    return s, w
    return None


def _bare_host(url: str) -> str:
    u = try_url(url)
    return rx(r"^www\.").sub("", u.hostname) if u else ""


def site_label(url: str, extra: Sequence[KnownSite] = ()) -> str:
    """주소 → 말할 사이트 이름: 알려진 사이트(하위 도메인 포함)면 그 이름, 아니면 www를 뗀 호스트. 주소를 못 읽으면 ""."""
    here = _bare_host(url)
    if not here:
        return ""
    for s in [*extra, *KNOWN_SITES]:
        known = _bare_host(s.url)
        if here == known or here.endswith(f".{known}"):
            return s.label
    return here


def goal_site_request(goal: str, extra: Sequence[KnownSite] = ()) -> tuple[str | None, str]:
    """한 사이트에서 찾아 달라는 요청을 사이트 주소와 질문으로 나눈다."""
    aliases = [(_norm(alias), site.url) for site in [*extra, *KNOWN_SITES] for alias in site.names]
    aliases.sort(key=lambda entry: len(entry[0]), reverse=True)
    destinations: list[tuple[str, str]] = []
    for marker in rx(r"에서|들어가서|가서|열어서|열고|접속해서").finditer(goal):
        prefix = goal[:marker.start()].strip()
        if not prefix:
            continue
        # '복지로에서 기초연금 ...'의 제도명이나 '이 화면에서'를 목적지로 잡지 않는다.
        bare = rx(r"(?:으로|로|에|을|를)$").sub("", prefix).strip()
        bare = rx(r"\s*(?:사이트|홈페이지|누리집)$").sub("", bare).strip()
        token = (bare or prefix).split()[-1]
        if DOMAIN.fullmatch(token):
            site = _address_site(token)
            url = site["url"] if site else None
        else:
            full, short = _norm(prefix), _norm(bare)
            url = next((url for alias, url in aliases if full.endswith(alias) or short.endswith(alias)), None)
            if not url:
                near = near_site(token, extra)
                url = near.url if near else None
        if url:
            destinations.append((url, goal[marker.end():].strip()))
    if destinations:
        return destinations[0] if len(destinations) == 1 else (None, goal)
    agency = public_service_site(goal)
    return (agency.url, goal) if agency else (None, goal)


def resolve_site(target: str, extra: Sequence[KnownSite] = ()) -> dict | None:
    """이름이나 주소를 실제 URL로. 연습용 모의 사이트는 extra로 넘긴다. → {'url', 'label'}"""
    t = _norm(target)
    all_sites = [*extra, *KNOWN_SITES]
    hits = [(s, _norm(n)) for s in all_sites for n in s.names if _norm(n) in t]
    known = sorted(hits, key=lambda x: -len(x[1]))[0][0] if hits else None
    # 전체 주소를 말했으면 그 화면을 연다(주소 속 'bokjiro'로 사이트 첫 화면을 열지 않는다)
    explicit = rx(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", I).search(target)
    site = _address_site(explicit.group(0)) if explicit else None
    if site:
        # 이름은 주소의 호스트로만 정한다: 'bokjiro.go.kr.evil.example'을 복지로라고 말하지 않는다
        return {**site, "label": site_label(site["url"], extra) or site["label"]}
    if known:
        return {"url": known.url, "label": known.label}
    agency = public_service_site(target)
    if agency:
        return {"url": agency.url, "label": agency.label}
    near = near_site(target, extra)
    if near:
        return {"url": near.url, "label": near.label}
    spoken = rx(r"\s*(닷|점)\s*(컴|com)").sub(".com", target)
    spoken = rx(r"\s*(닷|점)\s*(케이알|kr)").sub(".kr", spoken)
    m = DOMAIN.search(spoken)
    return _address_site(m.group(1)) if m else None


def _address_site(address: str) -> dict | None:
    raw = rx(r"[.,)]+$").sub("", address)
    # 로컬 주소(localhost, IP)는 http, 그 외 도메인은 https로 연다.
    local = bool(rx(r"^(localhost|\d{1,3}(\.\d{1,3}){3})(:|\/|$)", I).search(raw))
    url = raw if rx(r"^https?:\/\/", I).search(raw) else f"{'http' if local else 'https'}://{raw}"
    u = try_url(url)
    return {"url": url, "label": u.host} if u else None
