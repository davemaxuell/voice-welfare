"""공공데이터포털에서 미리 내려받은 복지사업과 기관 자료."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from cheongeum.core.places import PlaceKind

from .datasets import BUNDLED, DATASETS, DatasetStatus, load_one
from .links import ServiceLinkShelf
from .places import PlaceFinder, PlaceReply, official_districts
from .programs import ProgramShelf

__all__ = ["OpenData", "DatasetStatus", "PlaceFinder", "PlaceReply", "ProgramShelf", "ServiceLinkShelf", "official_districts"]


@dataclass
class OpenData:
    programs: ProgramShelf
    places: PlaceFinder
    statuses: tuple[DatasetStatus, ...]
    links: ServiceLinkShelf = field(default_factory=ServiceLinkShelf)

    @classmethod
    def empty(cls) -> OpenData:
        return cls(ProgramShelf(), PlaceFinder({}, {}), tuple(DatasetStatus(k, error="missing") for k in DATASETS), ServiceLinkShelf())

    @classmethod
    def load(cls, folder: str | Path | None = None) -> OpenData:
        folder = Path(folder) if folder is not None else BUNDLED
        statuses, rows, dates = [], {}, {}
        programs = ProgramShelf()
        links = ServiceLinkShelf()
        for spec in DATASETS.values():
            status, records = load_one(folder, spec)
            statuses.append(status)
            if status.error:
                continue
            if spec.id == "15116392":
                programs = ProgramShelf(records, status.reference_date)
            elif spec.id == "15083323":
                links = ServiceLinkShelf(records, status.reference_date)
            else:
                kind = PlaceKind(spec.id)
                rows[kind] = records
                dates[kind] = date.fromisoformat(status.reference_date)
        return cls(programs, PlaceFinder(rows, dates), tuple(statuses), links)
