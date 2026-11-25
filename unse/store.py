"""날짜별 운세 JSON과 배치 진행 상태를 파일로 저장한다.

data/unse/2026-11-27.json  그날 화면에 내보낼 운세 (검사 통과한 것만)
data/unse/state.json       제출한 배치와 날짜별 시도 횟수
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

DATA_DIR = Path(os.environ.get("UNSE_DATA_DIR", "data/unse"))


class Store:
    def __init__(self, root: Path | str = DATA_DIR):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _write(self, path: Path, obj) -> None:
        fd, tmp = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def _read(self, path: Path, default):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def day(self, iso: str) -> dict | None:
        return self._read(self.root / f"{iso}.json", None)

    def save_day(self, iso: str, data: dict) -> None:
        self._write(self.root / f"{iso}.json", data)

    def state(self) -> dict:
        return self._read(self.root / "state.json", {"pending": {}, "attempts": {}})

    def save_state(self, st: dict) -> None:
        self._write(self.root / "state.json", st)
