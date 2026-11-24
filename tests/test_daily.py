import json
from datetime import datetime
from zoneinfo import ZoneInfo

from aa.daily import due_matches, next_run, run_daily
from aa.llm import MockClient
from test_collect import FakeAF, company, fake_odds  # noqa: F401 (pytest fixture)

KST = ZoneInfo("Asia/Seoul")


def test_daily_collects_and_analyzes_within_limits(company):
    now = datetime(2026, 11, 28, 12, 0, tzinfo=KST)  # 킥오프(11/30 01:30 KST) 37.5시간 전
    s = run_daily(company, client_factory=MockClient, now=now, log=lambda *_: None,
                  af_transport=FakeAF(), odds_transport=fake_odds)
    assert s["collected"] == 1 and s["analyzed"] == ["AF-9001"] and not s["errors"]
    assert (company.base_dir / "reports" / "AF-9001.json").exists()
    # 이미 분석한 경기는 다시 분석하지 않는다
    s2 = run_daily(company, client_factory=MockClient, now=now, log=lambda *_: None,
                   af_transport=FakeAF(), odds_transport=fake_odds)
    assert s2["analyzed"] == []
    log = (company.base_dir / "data" / "daily_log.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(log) == 2 and json.loads(log[0])["analyzed"] == ["AF-9001"]


def test_daily_respects_window_and_cap(company):
    early = datetime(2026, 11, 25, 12, 0, tzinfo=KST)  # 킥오프 4일 전: 수집은 하되 분석은 아직
    company.automation["collect_days"] = 7
    s = run_daily(company, client_factory=MockClient, now=early, log=lambda *_: None,
                  af_transport=FakeAF(), odds_transport=fake_odds)
    assert s["collected"] == 1 and s["analyzed"] == []
    company.automation["max_analyses_per_day"] = 0
    later = datetime(2026, 11, 29, 9, 0, tzinfo=KST)
    assert len(due_matches(company, later, 48)) == 1
    s = run_daily(company, client_factory=MockClient, now=later, log=lambda *_: None,
                  af_transport=FakeAF(), odds_transport=fake_odds)
    assert s["analyzed"] == []


def test_next_run():
    now = datetime(2026, 11, 24, 23, 0, tzinfo=KST)
    assert next_run(now, ["10:00", "22:00"]) == datetime(2026, 11, 25, 10, 0, tzinfo=KST)
    now = datetime(2026, 11, 24, 12, 0, tzinfo=KST)
    assert next_run(now, ["10:00", "22:00"]) == datetime(2026, 11, 24, 22, 0, tzinfo=KST)
