"""API-Football (api-sports.io v3) 클라이언트: 일정, 순위, 팀 통계, 부상자, 상대 전적.

무료 플랜은 하루 100회라서, 모든 요청을 캐시하고 하루 사용량을 세어 한도 전에 멈춘다.
"""
from __future__ import annotations

import os

from .cache import ApiCache
from .http import http_get

BASE = "https://v3.football.api-sports.io"
PROVIDER = "api_football"


class ApiFootball:
    def __init__(self, cache: ApiCache, daily_limit: int = 100, cache_hours: float = 6,
                 api_key: str | None = None, transport=http_get):
        self.key = api_key or os.environ.get("API_FOOTBALL_KEY")
        self.cache = cache
        self.daily_limit = daily_limit
        self.cache_hours = cache_hours
        self.transport = transport

    def get(self, path: str, cache_hours: float | None = None, **params) -> list | dict:
        ck = self.cache.key(PROVIDER, path, params)
        hit = self.cache.get(ck, self.cache_hours if cache_hours is None else cache_hours)
        if hit is not None:
            return hit
        if not self.key:
            raise RuntimeError("API_FOOTBALL_KEY 환경변수가 없습니다. api-football.com 에서 무료 키를 받을 수 있습니다.")
        self.cache.check(PROVIDER, 1, self.daily_limit, "day")
        body, _ = self.transport(BASE + path, params, {"x-apisports-key": self.key})
        self.cache.spend(PROVIDER, 1, f"{path} {params}")
        errors = body.get("errors") if isinstance(body, dict) else None
        if errors:
            raise RuntimeError(f"API-Football 오류: {errors}")
        data = body.get("response", body) if isinstance(body, dict) else body
        self.cache.put(ck, PROVIDER, data)
        return data

    # ---- 엔드포인트 -------------------------------------------------------
    def fixtures(self, league: int, season: int, date_from: str, date_to: str, timezone: str = "Asia/Seoul") -> list:
        return self.get("/fixtures", league=league, season=season, **{"from": date_from, "to": date_to}, timezone=timezone)

    def fixture(self, fixture_id: int, timezone: str = "Asia/Seoul") -> dict | None:
        res = self.get("/fixtures", id=fixture_id, timezone=timezone)
        return res[0] if res else None

    def standings(self, league: int, season: int) -> list:
        res = self.get("/standings", cache_hours=20, league=league, season=season)
        return res[0]["league"]["standings"][0] if res else []

    def team_stats(self, league: int, season: int, team: int) -> dict:
        return self.get("/teams/statistics", cache_hours=20, league=league, season=season, team=team)

    def injuries(self, fixture_id: int) -> list:
        return self.get("/injuries", cache_hours=3, fixture=fixture_id)

    def h2h(self, home: int, away: int, last: int = 5) -> list:
        return self.get("/fixtures/headtohead", cache_hours=72, h2h=f"{home}-{away}", last=last)

    def last_fixture(self, team: int, timezone: str = "Asia/Seoul") -> dict | None:
        res = self.get("/fixtures", cache_hours=20, team=team, last=1, timezone=timezone)
        return res[0] if res else None
