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
        self.remaining: int | None = None

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
        rem = headers.get("x-requests-remaining") or headers.get("X-Requests-Remaining")
        if rem is not None:  # 실제 요금제의 남은 크레딧으로 한도를 맞춘다 (유료면 크게 늘어남)
            self.remaining = int(float(rem))
            self.monthly = self.cache.used(PROVIDER, "month") + self.remaining
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

    LINES = (2.5, 3.5, 4.5)   # 사이트에서 고를 수 있는 기준점 (11/28: 1.5 는 쓰지 않음)

    @staticmethod
    def totals_by_line(event: dict) -> dict[float, list[tuple[float, float]]]:
        """기준점별 (오버, 언더) 배당 목록. 0.25 단위(아시안) 기준점은 빼고 x.5 만."""
        books: dict[float, list[tuple[float, float]]] = {}
        for b in event.get("bookmakers", []):
            for m in b.get("markets", []):
                if m["key"] != "totals":
                    continue
                by_pt: dict[float, dict] = {}
                for o in m["outcomes"]:
                    pt = o.get("point")
                    if pt is None or float(pt) % 1 != 0.5:
                        continue
                    by_pt.setdefault(float(pt), {})[o["name"].lower()] = float(o["price"])
                for pt, pr in by_pt.items():
                    if "over" in pr and "under" in pr:
                        books.setdefault(pt, []).append((pr["over"], pr["under"]))
        return books

    @staticmethod
    def main_line(event: dict, fallback: float = 2.5) -> float:
        """언더/오버 기준점: 2.5·3.5·4.5 중 오버·언더 배당이 가장 비슷한(반반에 가까운) 기준점.
        예전(11/28 전)엔 '북메이커 수가 가장 많은 기준점'이라 거의 다 2.5 였다 (대부분 2.5 를 기본으로 냄).
        북메이커가 너무 적은 기준점(가장 많은 곳의 절반 미만)은 빼서 한두 곳의 튀는 배당에 끌려가지 않게 한다."""
        books = {pt: rows for pt, rows in OddsApi.totals_by_line(event).items() if pt in OddsApi.LINES}
        if not books:
            return fallback
        most = max(len(r) for r in books.values())
        cand = [pt for pt, r in books.items() if len(r) * 2 >= most]

        def score(pt):
            rows = books[pt]
            gap = abs(sum(o for o, _ in rows) / len(rows) - sum(u for _, u in rows) / len(rows))
            return (gap, -len(rows))

        return min(cand, key=score)

    @staticmethod
    def consensus(event: dict, line: float | None = None, fallback_line: float = 2.5) -> dict:
        """여러 북메이커의 실제 배당을 평균 낸다 (마진 포함, 실제로 받을 수 있는 수준).
        시장 확률은 분석 단계에서 이 배당의 마진을 빼서 계산한다.
        line 을 주지 않으면 그 경기의 주 기준점(main_line)을 쓴다."""
        if line is None:
            line = OddsApi.main_line(event, fallback_line)
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
        # 2.5·3.5·4.5 기준점별 평균 배당: 운영자가 기준점을 바꾸면 다시 받지 않고 이 배당을 쓴다
        allt = OddsApi.totals_by_line(event)
        totals = {str(pt): {"over": round(sum(o for o, _ in r) / len(r), 2), "under": round(sum(u for _, u in r) / len(r), 2)}
                  for pt, r in allt.items() if pt in OddsApi.LINES and r}
        if totals:
            out["totals"] = totals
        out["source"] = f"The Odds API 평균 배당 (승무패 {len(h2h)}곳, 언더/오버 {len(tot)}곳 북메이커)"
        return out
