"""API 응답 캐시와 호출량 기록. 유료 크레딧을 아끼기 위해 같은 요청은 정해진 시간 안에 다시 부르지 않는다."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path


class BudgetExceeded(RuntimeError):
    pass


class ApiCache:
    def __init__(self, path: str | Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, provider TEXT, saved REAL, body TEXT);
            CREATE TABLE IF NOT EXISTS usage (provider TEXT, day TEXT, month TEXT, cost INTEGER, at TEXT, what TEXT);
            """
        )

    @staticmethod
    def key(provider: str, path: str, params: dict) -> str:
        raw = provider + path + json.dumps(params, sort_keys=True)
        return hashlib.sha1(raw.encode()).hexdigest()

    def get(self, key: str, max_age_hours: float):
        row = self.db.execute("SELECT saved, body FROM cache WHERE key = ?", (key,)).fetchone()
        if row and time.time() - row[0] < max_age_hours * 3600:
            return json.loads(row[1])
        return None

    def put(self, key: str, provider: str, body) -> None:
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO cache (key, provider, saved, body) VALUES (?,?,?,?)",
                (key, provider, time.time(), json.dumps(body, ensure_ascii=False)),
            )

    def spend(self, provider: str, cost: int, what: str) -> None:
        now = datetime.now(timezone.utc)
        with self.db:
            self.db.execute(
                "INSERT INTO usage (provider, day, month, cost, at, what) VALUES (?,?,?,?,?,?)",
                (provider, now.strftime("%Y-%m-%d"), now.strftime("%Y-%m"), cost, now.isoformat(timespec="seconds"), what),
            )

    def used(self, provider: str, period: str = "day") -> int:
        now = datetime.now(timezone.utc)
        col, val = ("day", now.strftime("%Y-%m-%d")) if period == "day" else ("month", now.strftime("%Y-%m"))
        row = self.db.execute(f"SELECT COALESCE(SUM(cost),0) FROM usage WHERE provider = ? AND {col} = ?", (provider, val)).fetchone()
        return int(row[0])

    def check(self, provider: str, cost: int, limit: int, period: str) -> None:
        if self.used(provider, period) + cost > limit:
            unit = "오늘" if period == "day" else "이번 달"
            raise BudgetExceeded(f"{provider} {unit} 호출 한도({limit})를 넘게 됩니다. 캐시된 자료만 쓰거나 한도를 올리세요.")
