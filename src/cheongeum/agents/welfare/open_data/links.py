"""중앙부처 복지서비스 공식 CSV(15083323)의 복지로 상세 주소와 관련 사이트 색인."""
from __future__ import annotations

import re
from datetime import date

from cheongeum.core.jsutil import try_url

from .datasets import DATASETS, RelatedSite, ServiceLink

_SITE_SUFFIX = re.compile(r"(?:홈페이지|웹\s*사이트|사이트|누리집)$")
_SPACE = re.compile(r"\s+")


def _key(text: str) -> str:
    return _SPACE.sub("", text).casefold()


def _url_key(url: str) -> str:
    u = try_url(url)
    if not u:
        return url.casefold().rstrip("/")
    host = u.hostname.removeprefix("www.")
    path = "" if u.pathname == "/" else u.pathname.rstrip("/")
    return f"{host}{path}{u.search}".casefold()


class ServiceLinkShelf:
    def __init__(self, records: tuple[ServiceLink, ...] = (), reference_date: str | None = None):
        self.records = records
        self.reference_date = date.fromisoformat(reference_date) if reference_date else None
        self._by_id: dict[str, ServiceLink] = {}
        self._by_name: dict[str, list[ServiceLink]] = {}
        self._site_labels: dict[str, list[RelatedSite]] = {}
        for record in records:
            self._by_id[record.serv_id] = record
            self._by_name.setdefault(_key(record.name), []).append(record)
            for site in record.sites:
                if not site.name:
                    continue
                keys = {_key(site.name)}
                bare = _SITE_SUFFIX.sub("", site.name).strip()
                if bare and len(_key(bare)) >= 2:
                    keys.add(_key(bare))
                for k in keys:
                    if k:
                        self._site_labels.setdefault(k, []).append(site)

    def citation(self, note: str = "") -> dict | None:
        if not self.reference_date:
            return None
        return DATASETS["15083323"].citation(self.reference_date, note)

    def by_id(self, serv_id: str) -> ServiceLink | None:
        return self._by_id.get(serv_id)

    def by_name(self, name: str) -> ServiceLink | None:
        matches = self._by_name.get(_key(name), [])
        return matches[0] if len(matches) == 1 else None

    def match_in_text(self, text: str) -> ServiceLink | None:
        """문장에 공식 서비스 이름이 뚜렷하고 유일하게 들어 있을 때만 돌려준다."""
        if not self.records or not text.strip():
            return None
        direct = self.by_name(text)
        if direct:
            return direct
        compact_text = _key(text)
        found: list[tuple[int, str, ServiceLink]] = []
        for k, rows in self._by_name.items():
            if len(rows) != 1 or len(k) < 4:
                continue
            if k in compact_text:
                found.append((len(k), k, rows[0]))
        if not found:
            return None
        found.sort(key=lambda item: -item[0])
        kept: list[tuple[str, ServiceLink]] = []
        for _, k, rec in found:
            if any(k in existing for existing, _ in kept):
                continue
            kept.append((k, rec))
        return kept[0][1] if len(kept) == 1 else None

    def related_site(self, query: str) -> RelatedSite | None:
        """관련 사이트 이름과 정확히 일치하고 가리키는 주소가 하나뿐일 때만 돌려준다."""
        cleaned = _SITE_SUFFIX.sub("", query.strip()).strip()
        for candidate in (query, cleaned):
            k = _key(candidate)
            if not k or len(k) < 2:
                continue
            hits = self._site_labels.get(k)
            if not hits:
                continue
            unique = {_url_key(site.url): site for site in hits}
            if len(unique) == 1:
                return next(iter(unique.values()))
            return None
        return None
