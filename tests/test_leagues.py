"""리그 고르기·호출 절약·1차 분석 배당 가림."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from aa.collect import collect
from aa.daily import default_leagues, due_matches
from aa.ledger import Ledger
from aa.llm import MockClient
from aa.models import Match
from aa.pipeline import BLIND_MARKET, analyze
from aa.web.app import create_app, league_of
from test_collect import FakeAF, company, fake_odds  # noqa: F401 (pytest fixture)

KST = ZoneInfo("Asia/Seoul")


def test_light_collect_uses_only_league_calls(company):
    af = FakeAF()
    paths = collect(company, days=7, leagues=[39], light=True, af_transport=af, odds_transport=fake_odds,
                    today=datetime(2026, 11, 24), log=lambda *_: None)
    assert {p for p, _ in af.calls} == {"/fixtures", "/standings"}  # 경기별 호출 없음
    m = json.loads(paths[0].read_text(encoding="utf-8"))
    assert m["league_id"] == 39 and m["league_name"] == "프리미어리그" and m["collected_detail"] == "light"
    assert m["stats"]["home"]["played"] == 5 and m["stats"]["home"]["raw_goals_for"] == 2.0
    # 자세히 모은 뒤 가볍게 다시 모아도 자세한 자료는 남는다
    collect(company, days=7, leagues=[39], af_transport=FakeAF(), odds_transport=fake_odds,
            today=datetime(2026, 11, 24), log=lambda *_: None)
    collect(company, days=7, leagues=[39], light=True, af_transport=FakeAF(), odds_transport=fake_odds,
            today=datetime(2026, 11, 24), log=lambda *_: None)
    m = json.loads(paths[0].read_text(encoding="utf-8"))
    assert m["collected_detail"] == "full" and m["lineup"]["home_absent"]


def test_due_matches_by_league_and_saved_default(company):
    collect(company, days=7, leagues=[39], af_transport=FakeAF(), odds_transport=fake_odds,
            today=datetime(2026, 11, 24), log=lambda *_: None)
    now = datetime(2026, 11, 29, 9, 0, tzinfo=KST)
    assert len(due_matches(company, now, 48, leagues=[39])) == 1
    assert due_matches(company, now, 48, leagues=[140]) == []
    assert default_leagues(company) == [39, 2]
    (company.base_dir / "data" / "settings.json").write_text(json.dumps({"leagues": [140, 3]}), encoding="utf-8")
    assert default_leagues(company) == [140, 3]


def test_first_round_hides_market_except_for_contrarian(company, tmp_path):
    collect(company, days=7, leagues=[39], af_transport=FakeAF(), odds_transport=fake_odds,
            today=datetime(2026, 11, 24), log=lambda *_: None)
    seen = {}
    inner = MockClient()

    class Rec:
        label = inner.label

        def complete(self, system, prompt, ctx):
            seen[(ctx["member_id"], ctx["stage"])] = prompt
            return inner.complete(system, prompt, ctx)

    p = company.base_dir / "data" / "matches" / "AF-9001.json"
    analyze(company, Match.load(p), Rec(), Ledger(tmp_path / "l.sqlite"))
    assert BLIND_MARKET in seen[("kim_data", "initial")] and "마진" not in seen[("kim_data", "initial")]
    assert BLIND_MARKET in seen[("park_field", "initial")]
    assert "마진" in seen[("lee_contra", "initial")]          # 역발상 담당은 처음부터 본다
    assert "마진" in seen[("kim_data", "debate")]             # 토론 때는 모두 본다


def test_leagues_api_and_league_names(company):
    c = create_app(company).test_client()
    j = c.get("/api/leagues").get_json()
    ids = [x["id"] for x in j["leagues"]]
    assert 39 in ids and 3 in ids and j["defaults"] == [39, 2]
    assert {x["group"] for x in j["leagues"]} >= {"유럽 5대 리그", "유럽 대회"}
    assert league_of(company, {"league": "챔피언스리그 League Stage - 5"}) == (2, "챔피언스리그")
    assert league_of(company, {"league": "x", "source_ids": {"league": 140}}) == (140, "라리가")
