"""AI 가상 배팅 게임과 여러 리그를 날짜별로 한 번에 받기."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from aa import betting
from aa.collect import collect
from test_collect import FakeAF, company, fake_odds  # noqa: F401

KST = ZoneInfo("Asia/Seoul")


def _run(mid, day, hour, probs, over, odds, engine="Claude"):
    ko = datetime(2026, 11, day, hour, 0, tzinfo=KST)
    ops = [{"member_id": m, "probs": dict(zip(("home", "draw", "away"), probs)), "over_prob": over}
           for m in ("kim_data", "park_field", "lee_contra")]
    return {"match": {"id": mid, "home": f"H{mid}", "away": f"A{mid}", "kickoff": ko.strftime("%Y-%m-%d %H:%M KST"),
                      "odds": dict(odds, line=2.5), "data": {"kickoff_iso": ko.isoformat()}},
            "decision": {"line": 2.5}, "final": ops, "engine": engine}


ODDS = {"home": 1.8, "draw": 3.6, "away": 4.5, "over": 1.9, "under": 1.9}


def test_slips_follow_rules(company):
    now = datetime(2026, 11, 24, 18, 0, tzinfo=KST)
    runs = [_run(f"M{i}", 24 if i < 4 else 25, 22, (0.6, 0.25, 0.15), 0.55, ODDS) for i in range(8)]
    runs.append(_run("LATE", 26, 20, (0.9, 0.05, 0.05), 0.5, ODDS))                 # 사흘째 → 못 씀
    runs.append(_run("MOCK", 24, 23, (0.9, 0.05, 0.05), 0.5, ODDS, engine="모의"))    # 모의 → 못 씀
    runs.append(_run("NOODDS", 24, 23, (0.9, 0.05, 0.05), 0.5, {}))                  # 배당 없음 → 못 씀
    book = {"start_bankroll": 1_000_000, "accounts": {}, "slips": []}
    assert betting.place(company, book, runs, now, log=lambda *_: None) == 9         # 3명 × 3·5·7폴더
    for s in book["slips"]:
        assert 5_000 <= s["stake"] <= 100_000 and s["stake"] % 1000 == 0
        ids = [l["match_id"] for l in s["legs"]]
        assert len(ids) == len(set(ids)) == s["size"]                                 # 경기당 하나
        assert not {"LATE", "MOCK", "NOODDS"} & set(ids)
        assert set(s["days"]) <= {"2026-11-24", "2026-11-25"}                         # 이틀 안
        assert all(l["prob"] >= betting.MIN_LEG_PROB for l in s["legs"])
    acc = book["accounts"]["kim_data"]
    spent = sum(s["stake"] for s in book["slips"] if s["member_id"] == "kim_data")
    assert acc["bankroll"] == 1_000_000 - spent
    # 열린 배팅이 있으면 같은 크기는 다시 걸지 않는다
    assert betting.place(company, book, runs, now, log=lambda *_: None) == 0


def test_settle_win_and_loss(company):
    now = datetime(2026, 11, 24, 18, 0, tzinfo=KST)
    runs = [_run(f"M{i}", 24, 22, (0.6, 0.25, 0.15), 0.55, ODDS) for i in range(7)]
    book = {"start_bankroll": 1_000_000, "accounts": {}, "slips": []}
    betting.place(company, book, runs, now, log=lambda *_: None)
    s3 = next(s for s in book["slips"] if s["member_id"] == "kim_data" and s["size"] == 3)
    results = {}
    for l in s3["legs"]:                                   # 3폴더의 선택이 모두 맞게 결과를 만든다
        results[l["match_id"]] = {"home_goals": 2, "away_goals": 1} if l["pick"] in ("home", "over") else {"home_goals": 0, "away_goals": 0}
    before = book["accounts"]["kim_data"]["bankroll"]
    betting.settle(book, results, now, log=lambda *_: None)
    assert s3["status"] == "won" and s3["payout"] == int(s3["stake"] * s3["combined_odds"])
    assert book["accounts"]["kim_data"]["bankroll"] == before + s3["payout"]
    # 하나라도 틀리면 나머지 경기를 기다리지 않고 실패
    s5 = next(s for s in book["slips"] if s["member_id"] == "park_field" and s["size"] == 5)
    first = s5["legs"][0]
    betting.settle(book, {first["match_id"]: {"home_goals": 0, "away_goals": 3}}, now, log=lambda *_: None)
    assert s5["status"] == "lost" and s5["payout"] == 0


def test_many_leagues_use_one_call_per_day(company):
    af = FakeAF()
    collect(company, days=1, leagues=[39, 140, 2], af_transport=af, odds_transport=fake_odds,
            today=datetime(2026, 11, 28), light=True, log=lambda *_: None)
    fx = [p for p, q in af.calls if p == "/fixtures"]
    assert len(fx) == 2 and all("date" in q for p, q in af.calls if p == "/fixtures")  # 리그 3개라도 날짜 2번


def test_real_plan_limit_from_status(company):
    from aa.collect import _clients
    from aa.sources.cache import ApiCache

    def af(url, params, headers):
        assert url.endswith("/status")
        return {"errors": [], "response": {"subscription": {"plan": "Pro", "active": True},
                                           "requests": {"current": 120, "limit_day": 7500}}}, {}
    a, _ = _clients(company, ApiCache(company.base_dir / "data" / "c.sqlite"), af_transport=af)
    assert a.daily_limit == 7380 and a.plan["plan"] == "Pro"                 # 남은 실제 횟수만큼
    assert json.loads((company.base_dir / "data" / "api_plan.json").read_text(encoding="utf-8"))["limit_day"] == 7500


def test_odds_limit_follows_remaining_header(company):
    from aa.sources.cache import ApiCache
    from aa.sources.odds_api import OddsApi

    o = OddsApi(ApiCache(company.base_dir / "data" / "c2.sqlite"), monthly_credits=500, api_key="k",
                transport=lambda u, p, h: ([], {"x-requests-last": "2", "x-requests-remaining": "19800"}))
    o.odds("soccer_epl")
    assert o.remaining == 19800 and o.monthly == 2 + 19800


def test_topups_are_added_once_and_not_counted_as_profit(company):
    p = betting.topups_path(company)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"topups": [{"id": "t1", "member_id": "hogu", "amount": 500000},
                                        {"id": "t2", "member_id": "없는사람", "amount": 9}]}), encoding="utf-8")
    book = betting.load(company)
    assert book["accounts"]["hogu"]["bankroll"] == 1_500_000 and book["accounts"]["hogu"]["deposited"] == 500_000
    betting.save(company, book)
    book = betting.load(company)                    # 다시 읽어도 두 번 넣지 않는다
    assert book["accounts"]["hogu"]["bankroll"] == 1_500_000
    acc = next(a for a in betting.summary(company)["accounts"] if a["member_id"] == "hogu")
    assert acc["value"] == 1_500_000 and acc["profit"] == 0 and acc["deposited"] == 500_000
