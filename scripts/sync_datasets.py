"""공공데이터포털 스냅샷 동기화. 사용법: uv run python scripts/sync_datasets.py --help"""
import os
from pathlib import Path

from dotenv import dotenv_values

from cheongeum.agents.welfare.open_data.sync import main


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    configured = os.environ.get("DATASETS_DIR", dotenv_values(root / ".env").get("DATASETS_DIR"))
    default_dir = root / Path(configured.strip()).expanduser() if configured and configured.strip() else None
    raise SystemExit(main(default_dir=default_dir))
