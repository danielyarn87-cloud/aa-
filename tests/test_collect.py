"""API 연동 테스트: 실제 네트워크 대신 API 문서 형식의 가짜 응답을 넣는다."""
import json
import shutil
from datetime import datetime
from pathlib import Path

import pytest

from aa.collect import collect, sync_results
from aa.config import load_company
from aa.ledger import Ledger
from aa.llm import MockClient
from aa.models import Match
from aa.pipeline import analyze
from aa.sources.cache import ApiCache, BudgetExceeded
from aa.sources.odds_api import OddsApi, norm_team

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = {
    "fixture": {"id": 9001, "date": "2026-11-29T16:30:00+00:00", "venue": {"name": "Emirates Stadium"}, "status": {"short": "NS"}},
    "league": {"id": 39, "name": "Premier League", "round": "Regular Season - 12"},
    "teams": {"home": {"id": 42, "name": "Arsenal"}, "away": {"id": 50, "name": "Manchester City"}},
    "goals": {"home": None, "away": None},
}


def standing(tid, name, rank, pts, hp, hgf, ap, agf):
    return {"rank": rank, "team": {"id": tid, "name": name}, "points": pts, "goalsDiff": 8,
            "all": {"played": hp + ap, "win": 7, "draw": 1, "lose": 3},
            "home": {"played": hp, "goals": {"for": hgf, "against": 3}},
            "away": {"played": ap, "goals": {"for": agf, "against": 4}}}


def team_stats(played_h, played_a, gfh, gah, gfa, gaa, form):
    return {"form": form,
            "fixtures": {"played": {"home": played_h, "away": played_a}, "wins": {"home": 4, "away": 3},
                         "draws": {"home": 1, "away": 0}, "loses": {"home": 0, "away": 2}},
            "goals": {"for": {"average": {"home": str(gfh), "away": str(gfa)}},
                      "against": {"average": {"home": str(gah), "away": str(gaa)}}}}


class FakeAF:
    def __init__(self):
        self.calls = []

    def __call__(self, url, params, headers):
        assert headers.get("x-apisports-key") == "test"
        path = url.split(".io")[1]
        self.calls.append((path, params))
        if path == "/fixtures" and ("league" in params or "date" in params):
            return {"errors": [], "response": [FIXTURE]}, {}
        if path == "/fixtures" and "id" in params:
            done = json.loads(json.dumps(FIXTURE))
            done["fixture"]["status"]["short"] = "FT"
            done["goals"] = {"home": 1, "away": 1}
            done["score"] = {"fulltime": {"home": 1, "away": 1}}
            return {"errors": [], "response": [done]}, {}
        if path == "/fixtures" and "last" in params:
            return {"errors": [], "response": [{"fixture": {"date": "2026-11-24T20:00:00+00:00"}, "league": {"name": "UEFA Champions League"}}]}, {}
        if path == "/standings":
            rows = [standing(42, "Arsenal", 1, 28, 5, 10, 6, 7), standing(50, "Manchester City", 3, 22, 6, 12, 5, 10)]
            return {"errors": [], "response": [{"league": {"standings": [rows]}}]}, {}
        if path == "/teams/statistics":
            if params["team"] == 42:
                return {"errors": [], "response": team_stats(5, 6, 2.0, 0.4, 1.17, 0.83, "WWWWD")}, {}
            return {"errors": [], "response": team_stats(6, 5, 2.0, 1.33, 2.0, 1.2, "WLLLD")}, {}
        if path == "/injuries":
            return {"errors": [], "response": [
                {"player": {"name": "B. Saka", "type": "Missing Fixture", "reason": "Thigh Injury"}, "team": {"id": 42}},
                {"player": {"name": "D. Raya", "type": "Questionable", "reason": "Shoulder"}, "team": {"id": 42}},
                {"player": {"name": "A. Semenyo", "type": "Missing Fixture", "reason": "Knee"}, "team": {"id": 50}},
            ]}, {}
        if path == "/fixtures/headtohead":
            return {"errors": [], "response": [{"fixture": {"date": "2026-04-19T15:30:00+00:00"},
                                                 "teams": {"home": {"name": "Manchester City"}, "away": {"name": "Arsenal"}},
                                                 "goals": {"home": 2, "away": 1}}]}, {}
        raise AssertionError(path)


def fake_odds(url, params, headers):
    assert params["apiKey"] == "test"
    ev = {"home_team": "Arsenal", "away_team": "Manchester City", "bookmakers": [
        {"key": "a", "markets": [
            {"key": "h2h", "outcomes": [{"name": "Arsenal", "price": 2.0}, {"name": "Manchester City", "price": 3.5}, {"name": "Draw", "price": 3.7}]},
            {"key": "totals", "outcomes": [{"name": "Over", "price": 1.8, "point": 2.5}, {"name": "Under", "price": 2.0, "point": 2.5}]}]},
        {"key": "b", "markets": [
            {"key": "h2h", "outcomes": [{"name": "Arsenal", "price": 2.1}, {"name": "Manchester City", "price": 3.4}, {"name": "Draw", "price": 3.8}]}]},
    ]}
    return [ev], {"x-requests-last": "2"}


@pytest.fixture
def company(tmp_path, monkeypatch):
    for name in ("company.yaml", "personas", "prompts"):
        src = ROOT / name
        (shutil.copytree if src.is_dir() else shutil.copy)(src, tmp_path / name)
    monkeypatch.setenv("API_FOOTBALL_KEY", "test")
    monkeypatch.setenv("ODDS_API_KEY", "test")
    return load_company(tmp_path / "company.yaml")


def test_collect_builds_analyzable_match(company):
    af = FakeAF()
    paths = collect(company, days=7, leagues=[39], af_transport=af, odds_transport=fake_odds,
                    today=datetime(2026, 11, 24), log=lambda *_: None)
    assert len(paths) == 1
    m = json.loads(paths[0].read_text(encoding="utf-8"))
    assert m["id"] == "AF-9001" and m["kickoff"] == "2026-11-30 01:30 KST"
    assert m["odds"]["home"] == 2.05 and m["odds"]["over"] == 1.8  # 북메이커 평균
    assert m["lineup"]["home_absent"] == ["B. Saka (Thigh Injury)"]
    assert m["lineup"]["home_doubtful"] == ["D. Raya (Shoulder)"]
    assert m["schedule"]["home_days_rest"] == 4
    # 표본이 작으면 리그 평균 쪽으로 당겨진다
    assert m["stats"]["home"]["raw_goals_against"] == 0.4 < m["stats"]["home"]["xg_against"]

    # 수집한 자료 그대로 분석이 돌아간다
    run = analyze(company, Match.load(paths[0]), MockClient(), Ledger(company.base_dir / "l.sqlite"))
    assert run.decision.one_x_two.market_probs

    # 다시 수집하면 캐시를 써서 API 를 부르지 않는다
    before = len(af.calls)
    collect(company, days=7, leagues=[39], af_transport=af, odds_transport=fake_odds,
            today=datetime(2026, 11, 24), log=lambda *_: None)
    assert len(af.calls) == before


def test_sync_results_settles_finished_match(company):
    af = FakeAF()
    paths = collect(company, days=7, leagues=[39], af_transport=af, odds_transport=fake_odds,
                    today=datetime(2026, 11, 24), log=lambda *_: None)
    match = Match.load(paths[0])
    ledger = Ledger(company.base_dir / "data" / "ledger.sqlite")
    run = analyze(company, match, MockClient(), ledger)
    ledger.record(match, run.decision, run.initial + run.final, mock=False, report_path="")
    assert sync_results(company, ledger, af_transport=af, log=lambda *_: None) == 1
    assert ledger.company_stats("soccer")["settled"] == 1


def test_budget_guard(tmp_path):
    cache = ApiCache(tmp_path / "c.sqlite")
    cache.spend("api_football", 99, "x")
    cache.check("api_football", 1, 100, "day")
    with pytest.raises(BudgetExceeded):
        cache.check("api_football", 2, 100, "day")


def test_team_name_matching():
    assert norm_team("Brighton & Hove Albion") == norm_team("Brighton and Hove Albion")
    assert norm_team("Bayern München") == "bayernmunchen"
    assert norm_team("Bodø/Glimt") == norm_team("Bodo/Glimt")
    assert OddsApi.find_event([{"home_team": "Bodø/Glimt", "away_team": "LASK"}], "Bodo/Glimt", "Lask Linz")
    assert OddsApi.find_event([{"home_team": "ŠK Slovan Bratislava", "away_team": "Real Betis"}], "Slovan Bratislava", "Real Betis")
    events = [{"home_team": "Wolverhampton Wanderers", "away_team": "Tottenham Hotspur"}]
    assert OddsApi.find_event(events, "Wolves", "Tottenham", {"Wolves": "Wolverhampton Wanderers"})
