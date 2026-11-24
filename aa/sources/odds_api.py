"""The Odds API (v4) 클라이언트: 승무패(h2h)와 언더/오버(totals) 배당.

요청 1회의 크레딧 = 시장 수 x 지역 수. 리그 하나를 한 번 부르면 그 리그 모든 경기 배당이 온다.
여러 북메이커 배당은 '시장 합의 배당'(각 북메이커의 마진 제거 확률 평균 → 소수점 배당)으로 합친다.
"""
from __future__ import annotations

import os
import re
import unicodedata

from .cache import ApiCache
from .http import http_get

BASE = "https://api.the-odds-api.com/v4"
PROVIDER = "odds_api"


_SPECIAL = str.maketrans({"ø": "o", "Ø": "O", "æ": "ae", "Æ": "AE", "ß": "ss", "đ": "d", "Đ": "D", "ł": "l", "Ł": "L", "ı": "i"})


def norm_team(name: str) -> str:
    """두 API 의 팀 이름을 비교하기 위해 단순화한다 (악센트·특수 글자·FC 같은 말 제거)."""
    s = unicodedata.normalize("NFKD", name.translate(_SPECIAL)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(fc|afc|cf|sc|ac|club|de|the)\b", " ", s)
    s = s.replace("&", "and")
    return re.sub(r"[^a-z0-9]+", "", s)


class OddsApi:
    def __init__(self, cache: ApiCache, monthly_credits: int = 500, regions: str = "eu",
                 markets: str = "h2h,totals", cache_hours: float = 3, api_key: str | None = None, transport=http_get):
        self.key = api_key or os.environ.get("ODDS_API_KEY")
        self.cache = cache
        self.monthly = monthly_credits
        self.regions = regions
        self.markets = markets
        self.cache_hours = cache_hours
        self.transport = transport

    def odds(self, sport_key: str) -> list:
        params = {"regions": self.regions, "markets": self.markets, "oddsFormat": "decimal", "dateFormat": "iso"}
        ck = self.cache.key(PROVIDER, sport_key, params)
        hit = self.cache.get(ck, self.cache_hours)
        if hit is not None:
            return hit
        if not self.key:
            raise RuntimeError("ODDS_API_KEY 환경변수가 없습니다. the-odds-api.com 에서 무료 키를 받을 수 있습니다.")
        cost = len(self.markets.split(",")) * len(self.regions.split(","))
        self.cache.check(PROVIDER, cost, self.monthly, "month")
        body, headers = self.transport(f"{BASE}/sports/{sport_key}/odds", {**params, "apiKey": self.key}, {})
        used = headers.get("x-requests-last") or headers.get("X-Requests-Last")
        self.cache.spend(PROVIDER, int(used) if used else cost, sport_key)
        self.cache.put(ck, PROVIDER, body)
        return body

    @staticmethod
    def find_event(events: list, home: str, away: str, aliases: dict | None = None) -> dict | None:
        aliases = aliases or {}
        h = norm_team(aliases.get(home, home))
        a = norm_team(aliases.get(away, away))
        for e in events:
            eh, ea = norm_team(e["home_team"]), norm_team(e["away_team"])
            if (eh == h or h in eh or eh in h) and (ea == a or a in ea or ea in a):
                return e
        return None

    @staticmethod
    def consensus(event: dict, line: float = 2.5) -> dict:
        """여러 북메이커의 실제 배당을 평균 낸다 (마진 포함, 실제로 받을 수 있는 수준).
        시장 확률은 분석 단계에서 이 배당의 마진을 빼서 계산한다."""
        home_n, away_n = event["home_team"], event["away_team"]
        h2h: list[dict] = []
        tot: list[dict] = []
        for b in event.get("bookmakers", []):
            for m in b.get("markets", []):
                if m["key"] == "h2h":
                    prices = {}
                    for o in m["outcomes"]:
                        k = "home" if o["name"] == home_n else "away" if o["name"] == away_n else "draw" if o["name"].lower() == "draw" else None
                        if k:
                            prices[k] = float(o["price"])
                    if len(prices) == 3:
                        h2h.append(prices)
                elif m["key"] == "totals":
                    prices = {o["name"].lower(): float(o["price"]) for o in m["outcomes"] if float(o.get("point", -1)) == line}
                    if "over" in prices and "under" in prices:
                        tot.append(prices)
        out: dict = {"line": line}
        for rows, keys in ((h2h, ("home", "draw", "away")), (tot, ("over", "under"))):
            for k in keys:
                if rows:
                    out[k] = round(sum(r[k] for r in rows) / len(rows), 2)
                    out[f"best_{k}"] = max(r[k] for r in rows)
        out["source"] = f"The Odds API 평균 배당 (승무패 {len(h2h)}곳, 언더/오버 {len(tot)}곳 북메이커)"
        return out
