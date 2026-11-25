"""API-Football (api-sports.io v3) 클라이언트: 일정, 순위, 팀 통계, 부상자, 상대 전적.

모든 요청을 캐시하고 하루 사용량을 세어 한도 전에 멈춘다.
한도는 계정의 실제 요금제에서 읽는다 (/status, 호출 횟수에 안 들어감): 무료 100회, Pro 7,500회 등.
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
        self.plan: dict | None = None

    def sync_plan(self) -> dict:
        """계정의 요금제와 오늘 실제 사용량을 읽어 한도를 맞춘다. /status 는 하루 호출 수에 들어가지 않는다."""
        if not self.key:
            raise RuntimeError("API_FOOTBALL_KEY 없음")
        body, _ = self.transport(BASE + "/status", {}, {"x-apisports-key": self.key})
        r = body.get("response") if isinstance(body, dict) else None
        if isinstance(r, list):
            r = r[0] if r else None
        if not isinstance(r, dict) or "requests" not in r:
            raise RuntimeError(f"API-Football 상태를 읽지 못함: {body.get('errors') if isinstance(body, dict) else body}")
        req, sub = r["requests"], r.get("subscription") or {}
        limit_day, current = int(req.get("limit_day") or 0), int(req.get("current") or 0)
        mine = self.cache.used(PROVIDER, "day")
        # 남은 실제 횟수만큼만 더 쓰도록: 우리 계산 사용량 + (요금제 한도 - 실제 사용량)
        self.daily_limit = mine + max(0, limit_day - current)
        self.plan = {"plan": sub.get("plan"), "active": sub.get("active"), "end": sub.get("end"),
                     "limit_day": limit_day, "current": current}
        return self.plan

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

    def fixtures_on(self, date: str, timezone: str = "Asia/Seoul") -> list:
        """그날 전 세계 모든 경기 (한 번 호출). 리그를 여러 개 고를 때 리그마다 부르는 것보다 훨씬 싸다."""
        return self.get("/fixtures", date=date, timezone=timezone)

    def fixture(self, fixture_id: int, timezone: str = "Asia/Seoul") -> dict | None:
        res = self.get("/fixtures", id=fixture_id, timezone=timezone)
        return res[0] if res else None

    def standings(self, league: int, season: int) -> list:
        """순위표의 모든 조를 읽는다 (ACL 조별·J1 동/서·MLS 콘퍼런스처럼 여러 조로 나뉜 대회).
        같은 팀이 두 번 나오면(K리그1 정규 + 파이널A/B) 뒤쪽(최신 단계) 순위를 쓴다.
        여러 조였으면 각 줄에 _multi=True 를 붙여, 화면에 'H조 1위'처럼 조 이름을 같이 보여 준다."""
        res = self.get("/standings", cache_hours=20, league=league, season=season)
        if not res:
            return []
        groups = [g for g in res[0]["league"]["standings"] if g]
        rows: dict = {}
        for g in groups:
            for r in g:
                rows[r["team"]["id"]] = dict(r, _multi=len(groups) > 1)
        return list(rows.values())

    def coverage(self, league: int, season: int) -> dict | None:
        """이 리그·시즌에 API-Football 이 주는 자료 범위 (예: injuries 가 False 면 부상자 자료 없음). 1주일 저장."""
        res = self.get("/leagues", cache_hours=168, id=league, season=season)
        for x in res or []:
            for s in x.get("seasons") or []:
                if s.get("year") == season:
                    return s.get("coverage")
        return None

    def team_stats(self, league: int, season: int, team: int) -> dict:
        return self.get("/teams/statistics", cache_hours=20, league=league, season=season, team=team)

    def injuries(self, fixture_id: int) -> list:
        return self.get("/injuries", cache_hours=3, fixture=fixture_id)

    def h2h(self, home: int, away: int, last: int = 5) -> list:
        return self.get("/fixtures/headtohead", cache_hours=72, h2h=f"{home}-{away}", last=last)

    def last_fixture(self, team: int, timezone: str = "Asia/Seoul") -> dict | None:
        res = self.get("/fixtures", cache_hours=20, team=team, last=1, timezone=timezone)
        return res[0] if res else None
