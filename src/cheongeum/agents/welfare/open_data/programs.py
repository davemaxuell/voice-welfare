from __future__ import annotations

import hashlib
from datetime import date

from .datasets import DATASETS, Program


class ProgramShelf:
    def __init__(self, records: tuple[Program, ...] = (), reference_date: str | None = None):
        self.records = records
        self.reference_date = date.fromisoformat(reference_date) if reference_date else None

    def entries(self, today: str) -> list[dict]:
        day = date.fromisoformat(today)
        entries = []
        for record in self.records:
            if record.end < day:
                continue
            identifier = hashlib.sha256(f"{record.organization}\n{record.name}".encode()).hexdigest()[:20]
            entries.append({
                "servId": f"private-{identifier}", "servNm": record.name, "organization": record.organization,
                "provider": "private", "dataOrigin": "official-snapshot",
                "lifeStages": list(record.life_stages), "targets": list(record.targets),
                "themes": list(record.themes), "summary": record.purpose or record.benefit,
                "target": record.target, "benefit": record.benefit, "applyMethod": record.apply,
                "documents": record.documents, "enfcBgngYmd": None, "enfcEndYmd": None,
                "source": DATASETS["15116392"].citation(self.reference_date, record.organization),
                "referenceDate": self.reference_date.isoformat(),
            })
        return entries
