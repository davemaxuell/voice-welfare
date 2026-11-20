"""연간 공개 자료의 스키마, 출처와 행 수 하한."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from cheongeum.core.places import PlaceKind


class Record(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Place(Record):
    name: str = Field(min_length=1)
    address: str = Field(min_length=1)
    province: str = Field(min_length=1)
    districts: tuple[str, ...]
    dong: str = ""
    legal_dong: str = ""
    phone: str = Field(default="", pattern=r"^(?:\d{2,4}-\d{3,4}-\d{4}|\d{4}-\d{4})?$")
    reference_date: date | None = None


class Program(Record):
    organization: str = Field(min_length=1)
    name: str = Field(min_length=1)
    start: date
    end: date
    purpose: str
    target: str
    benefit: str
    apply: str
    documents: str
    life_stages: tuple[str, ...]
    targets: tuple[str, ...]
    themes: tuple[str, ...]


class RelatedSite(Record):
    name: str = ""
    url: str = Field(min_length=1)


class ServiceLink(Record):
    serv_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    detail_url: str = Field(min_length=1)
    summary: str = ""
    sites: tuple[RelatedSite, ...] = ()
    contact: str = ""
    ministry: str = ""
    department: str = ""
    criteria_year: str = ""
    last_modified: str = ""


@dataclass(frozen=True)
class Dataset:
    id: str
    title: str
    headers: tuple[str, ...]
    floor: int
    model: type[Record]

    def citation(self, ref: date, note: str = "") -> dict:
        page = "standard" if self.id == PlaceKind.MOBILITY else "fileData"
        return {"title": self.title, "url": f"https://www.data.go.kr/data/{self.id}/{page}.do",
                "lastCheckedAt": ref.isoformat(), "version": f"{ref.isoformat()} 기준", "note": note}


DATASETS = {spec.id: spec for spec in (
    Dataset("15116392", "한국사회보장정보원 민간복지서비스정보", tuple("기관명 사업명 사업시작일 사업종료일 사업목적 지원대상 지원내용 신청방법 제출서류 기타 생애주기 가구상황 관심주제".split()), 160, Program),
    Dataset("15083323", "한국사회보장정보원 복지서비스정보", tuple("서비스아이디 서비스명 서비스URL 서비스요약 사이트 대표문의 소관부처명 소관조직명 기준연도 최종수정일".split()), 200, ServiceLink),
    Dataset("15059715", "행정안전부 읍면동 하부행정기관 현황", tuple("연번 시도 시군구 읍면동 우편번호 주소".split()), 1700, Place),
    Dataset("15010814", "국민연금공단 지사 및 상담센터 현황", tuple("순번 지사(센터)명 우편번호 주소 전화번호 FAX".split()), 70, Place),
    Dataset("15028207", "전국교통약자이동지원센터정보표준데이터", tuple((
        "교통약자이동지원센터명 소재지도로명주소 소재지지번주소 위도 경도 보유차량대수 보유차량종류 슬로프형휠체어차량대수 리프트형휠체어차량대수 "
        "예약접수전화번호 예약접수인터넷주소 앱서비스명 평일예약접수운영시작시각 평일예약접수운영종료시각 주말예약접수운영시작시각 주말예약접수운영종료시각 "
        "차량평일운행시작시각 차량평일운행종료시각 차량주말운행시작시각 차량주말운행종료시각 사전예약신청기간 차량이용제한사항 차량관내운행지역 차량관외운행지역 "
        "차량이용대상 차량이용요금 관리기관명 관리기관전화번호 데이터기준일자 제공기관코드 제공기관명"
    ).split()), 80, Place),
)}

BUNDLED = Path(__file__).with_name("snapshots")


def digest(records: list, reference_date: str) -> str:
    data = json.dumps([reference_date, records], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class DatasetStatus:
    dataset_id: str
    reference_date: str | None = None
    row_count: int = 0
    error: str | None = None


def load_one(folder: Path, spec: Dataset) -> tuple[DatasetStatus, tuple]:
    path = folder / f"{spec.id}.json"
    try:
        snapshot = json.loads(path.read_bytes())
        meta, records = snapshot["meta"], snapshot["records"]
        if not isinstance(records, list) or not records or not isinstance(meta, dict):
            raise ValueError("shape")
        ref = date.fromisoformat(meta["referenceDate"]).isoformat()
        if (meta["dataset"] != spec.id or meta["schemaVersion"] != 1 or meta["rowCount"] != len(records)
                or meta["sha256"] != digest(records, ref)):
            raise ValueError("metadata")
        return DatasetStatus(spec.id, ref, len(records)), tuple(spec.model.model_validate(row) for row in records)
    except FileNotFoundError:
        return DatasetStatus(spec.id, error="missing"), ()
    except (KeyError, OSError, ValueError, TypeError, OverflowError):
        return DatasetStatus(spec.id, error="invalid"), ()
