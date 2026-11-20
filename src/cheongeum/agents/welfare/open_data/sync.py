"""공식 CSV를 검증하고 스냅샷 한 개씩 교체한다. 서버에서는 가져오지 않는다."""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory

from urllib.parse import urlsplit

from cheongeum.core.jsutil import try_url
from cheongeum.core.places import PlaceKind
from cheongeum.core.region import CTPV, province_name

from .datasets import BUNDLED, DATASETS, Dataset, Place, Program, RelatedSite, ServiceLink, digest, load_one

_SITE_URL_RE = re.compile(
    r"(https?[:;]//[^\s,]+|"
    r"(?<![a-zA-Z0-9./-])(?:www\.[a-zA-Z0-9가-힣-]+|(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+)"
    r"\.(?:go\.kr|or\.kr|re\.kr|ac\.kr|pe\.kr|ne\.kr|co\.kr|hs\.kr|ms\.kr|es\.kr|kg\.kr|sc\.kr|kr|com|net|org|io)"
    r"(?::\d+)?(?:/[^\s,]*)?)",
    re.I,
)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}")
_MOBILE_RE = re.compile(r"(?<!\d)01[016789][-\s]?\d{3,4}[-\s]?\d{4}(?!\d)")


def _clean_public_url(raw: str) -> str | None:
    url = raw.strip().rstrip(".,);")
    if not url:
        return None
    if url.lower().startswith(("http;//", "https;//")):
        url = url.replace(";//", "://", 1)
    elif not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    parts = urlsplit(url)
    parsed = try_url(url)
    if (not parsed or parsed.protocol not in ("http:", "https:") or not parsed.hostname or "." not in parsed.hostname
            or parsed.hostname in ("localhost", "127.0.0.1") or parts.username or parts.password):
        return None
    return parsed.href


def _clean_bokjiro_detail_url(raw: str, serv_id: str) -> str:
    parsed = try_url(raw.strip())
    if (not parsed or parsed.origin not in ("https://www.bokjiro.go.kr", "https://bokjiro.go.kr")
            or not serv_id or parsed.param("wlfareInfoId") != serv_id):
        raise ValueError(f"유효하지 않은 복지로 상세 주소: {raw}")
    return parsed.href


def _parse_related_sites(raw: str) -> tuple[RelatedSite, ...]:
    text = raw.strip()
    if not text:
        return ()
    sites: list[RelatedSite] = []
    seen: dict[str, int] = {}
    pos = 0
    for match in _SITE_URL_RE.finditer(text):
        label = text[pos:match.start()].strip(" ,·ㆍ/-")
        label = _MOBILE_RE.sub("", _EMAIL_RE.sub("", label)).strip()
        pos = match.end()
        cleaned = _clean_public_url(match.group(0))
        if not cleaned:
            continue
        key = cleaned.casefold().rstrip("/")
        if key in seen:
            if label and not sites[seen[key]].name:
                sites[seen[key]] = RelatedSite(name=label, url=cleaned)
            continue
        seen[key] = len(sites)
        sites.append(RelatedSite(name=label, url=cleaned))
    return tuple(sites)


def _row(record: dict[str, str], dataset: str):
    if dataset == "15116392":
        def tags(col):
            return tuple(re.sub(r"\s*·\s*", "·", tag.strip()) for tag in record[col].split(",") if tag.strip())
        def prose(col):
            # 게시된 신청방법에 덧붙은 직원별 연락처 안내는 앱의 사업 자료에 싣지 않는다.
            content = re.split(r"담당자\s*안내", record[col], maxsplit=1)[0].rstrip(" ·ㆍ")
            content = _EMAIL_RE.sub("기관 공고의 이메일", content)
            return _MOBILE_RE.sub("기관 공고의 연락처", content)
        return Program(organization=record["기관명"], name=record["사업명"],
                       start=record["사업시작일"], end=record["사업종료일"], purpose=prose("사업목적"),
                       target=prose("지원대상"), benefit=prose("지원내용"), apply=prose("신청방법"),
                       documents=prose("제출서류"), life_stages=tags("생애주기"), targets=tags("가구상황"), themes=tags("관심주제"))
    if dataset == "15083323":
        serv_id = record["서비스아이디"].strip()
        detail_url = _clean_bokjiro_detail_url(record["서비스URL"], serv_id)
        contact = _MOBILE_RE.sub("기관 공고의 연락처", _EMAIL_RE.sub("기관 공고의 이메일", record["대표문의"])).strip()
        summary = _MOBILE_RE.sub("기관 공고의 연락처", _EMAIL_RE.sub("기관 공고의 이메일", record["서비스요약"])).strip()
        return ServiceLink(
            serv_id=serv_id,
            name=record["서비스명"].strip(),
            detail_url=detail_url,
            summary=summary,
            sites=_parse_related_sites(record["사이트"]),
            contact=contact,
            ministry=record["소관부처명"].strip(),
            department=record["소관조직명"].strip(),
            criteria_year=record["기준연도"].strip(),
            last_modified=record["최종수정일"].strip(),
        )
    if dataset == PlaceKind.DONG_OFFICE:
        name, address = record["읍면동"], record["주소"]
        dong = re.split(r"\s*(?:주민센터|행정복지센터|사무소)", name)[0].strip()
        if m := re.search(r"센터\(([가-힣]+(?:읍|면|동))\)$", name):
            dong = m[1]
        legal = re.search(r"\(([가-힣\d·.]+(?:동|가))[,)]", address)
        return Place(name=name, address=address, province=province_name(record["시도"]),
                     districts=tuple(record["시군구"].split()), dong=dong, legal_dong=legal[1] if legal else "")
    if dataset == PlaceKind.PENSION:
        name, address, phone = (record[c] for c in ("지사(센터)명", "주소", "전화번호"))
        ref = None
    else:
        name, phone, ref = (record[c] for c in ("교통약자이동지원센터명", "예약접수전화번호", "데이터기준일자"))
        address = record["소재지도로명주소"] or record["소재지지번주소"]
    province = next((v for v in sorted(set(CTPV.values()) | {"전라북도", "강원도"}, key=len, reverse=True)
                     if address.startswith(v)), "")
    districts = []
    for part in re.split(r"[\s?,]+", address.removeprefix(province).strip()):
        if not part.endswith(("시", "군", "구")):
            break
        districts.append(part)
    return Place(name=name, address=address, phone=phone, province=province_name(province),
                 districts=tuple(districts), reference_date=ref)


def import_csv(path: Path, spec: Dataset, ref: date, dest: Path) -> int:
    raw = path.read_bytes()
    try:
        csv_text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        csv_text = raw.decode("cp949")
    reader = csv.reader(io.StringIO(csv_text, newline=""), strict=True)
    headers = next(reader, None)
    if headers is None or Counter(headers) != Counter(spec.headers):
        raise ValueError(f"{spec.id}: CSV 헤더가 바뀌었습니다")
    records = []
    errors = 0
    for values in reader:
        try:
            row = dict(zip(headers, (v.strip() for v in values), strict=True))
            records.append(_row(row, spec.id).model_dump(mode="json"))
        except ValueError:
            errors += 1
    old, _ = load_one(dest, spec)
    count = len(records)
    if count < spec.floor or count <= old.row_count / 2 or errors > (count + errors) * .02:
        raise ValueError(f"{spec.id}: {count}개 정상 행, {errors}개 오류. 기존 자료를 보존합니다")
    if old.reference_date and ref.isoformat() < old.reference_date:
        raise ValueError(f"{spec.id}: 기존 자료보다 오래된 기준일입니다")
    meta = {"dataset": spec.id, "schemaVersion": 1, "rowCount": count,
            "referenceDate": ref.isoformat(), "sha256": digest(records, ref.isoformat())}
    dest.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=dest, delete=False, mode="w", encoding="utf-8") as f:
        tmp = Path(f.name)
    try:
        with tmp.open("w", encoding="utf-8", newline="\n") as f:
            f.write('{"meta":' + json.dumps(meta, ensure_ascii=False) + ',"records":[\n')
            f.write(",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in records))
            f.write("\n]}\n")
        tmp.replace(dest / f"{spec.id}.json")
    finally:
        tmp.unlink(missing_ok=True)
    return count


def _portal_files(folder: Path):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            page = browser.new_page(accept_downloads=True)
            page.on("dialog", lambda dialog: dialog.accept())
            for spec in DATASETS.values():
                if spec.id == PlaceKind.MOBILITY:
                    continue
                page.goto(f"https://www.data.go.kr/data/{spec.id}/fileData.do", wait_until="domcontentloaded")
                button = page.locator('[onclick^="fileDetailObj.fn_fileDataDown"]').first
                with page.expect_download(timeout=60000) as event:
                    button.click()
                download = event.value
                release = re.search(r"_(\d{8})\.csv$", download.suggested_filename, re.I)
                if not release:
                    raise ValueError(f"{spec.id}: 파일의 기준일을 확인하고 --csv와 --reference-date를 지정하세요")
                path = folder / f"{spec.id}.csv"
                download.save_as(path)
                yield spec, path, date.fromisoformat(release[1])
        finally:
            browser.close()


def _mapping(parser, values):
    out = {}
    for pair in values:
        key, eq, value = pair.partition("=")
        if key not in DATASETS or not eq or not value or key in out:
            parser.error(f"잘못된 자료 지정: {pair}")
        out[key] = value
    return out


def main(argv=None, *, default_dir: Path | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dir", type=Path, default=default_dir or BUNDLED)
    p.add_argument("--csv", action="append", default=[], metavar="ID=FILE")
    p.add_argument("--reference-date", action="append", default=[], metavar="ID=YYYY-MM-DD")
    p.add_argument("--check", action="store_true")
    args = p.parse_args(argv)
    paths = _mapping(p, args.csv)
    dates = _mapping(p, args.reference_date)
    if paths.keys() != dates.keys():
        p.error("각 CSV에 --reference-date ID=YYYY-MM-DD가 필요합니다")
    if args.check:
        result = 0
        for spec in DATASETS.values():
            status, _ = load_one(args.dir, spec)
            print(spec.id, status.error or f"{status.row_count}행 {status.reference_date} 기준 "
                  f"{(date.today() - date.fromisoformat(status.reference_date)).days}일 전")
            if status.error and (status.error != "missing" or spec.id != PlaceKind.MOBILITY):
                result = 1
        return result
    with TemporaryDirectory() as temp:
        try:
            files = ((DATASETS[key], Path(path), date.fromisoformat(dates[key])) for key, path in paths.items()) if paths else _portal_files(Path(temp))
            result = 0
            for spec, path, ref in files:
                try:
                    count = import_csv(path, spec, ref, args.dir)
                    print(spec.id, ref, f"{count}행")
                except (OSError, ValueError, csv.Error) as exc:
                    print(str(exc), file=sys.stderr)
                    result = 1
            return result
        except Exception as exc:
            print(f"자료 내려받기 실패: {exc}", file=sys.stderr)
            return 1
