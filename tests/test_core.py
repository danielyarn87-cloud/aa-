import json
import shutil
from pathlib import Path

import pytest
import yaml

from aa.config import Policy, load_company
from aa.ledger import Ledger
from aa.llm import MockClient
from aa.models import Match, Opinion, extract_json
from aa.odds import implied_probs
from aa.pipeline import analyze
from aa.sports.base import score_matrix, summarize_matrix
from aa.voting import decide

ROOT = Path(__file__).resolve().parents[1]


def op(mid, pick, probs=(0.5, 0.3, 0.2), over=0.55, ou="over"):
    return Opinion.from_dict(
        mid, mid, "debate",
        {"probs": dict(zip(("home", "draw", "away"), probs)), "pick_1x2": pick, "over_prob": over, "pick_ou": ou},
    )


ODDS = {"home": 1.8, "draw": 3.6, "away": 4.5, "over": 1.9, "under": 1.9}


@pytest.mark.parametrize(
    "picks, expected",
    [
        (["home", "home", "home"], "home"),  # 3:0 확정
        (["home", "draw", "home"], "home"),  # 2:1 확정
        (["home", "draw", "away"], None),  # 1:1:1 관망
        (["home", "home", "draw", "draw"], None),  # 4명 2:2 관망
        (["away", "away", "away", "home"], "away"),  # 4명 3:1 확정
    ],
)
def test_vote_rules(picks, expected):
    ops = [op(f"m{i}", p) for i, p in enumerate(picks)]
    one, _ = decide(ops, {}, Policy(), ODDS, {}, {})
    assert one.pick == expected


def test_weights_can_break_tie():
    ops = [op("a", "home"), op("b", "draw")]
    one, _ = decide(ops, {"a": 1.5, "b": 1.0}, Policy(), ODDS, {}, {})
    assert one.pick == "home"
    assert one.dissent == ["b"]


def test_value_flags():
    ops = [op("a", "draw", (0.4, 0.35, 0.25))]
    one, _ = decide(ops, {}, Policy(value_threshold=0.05), ODDS, {}, {})
    assert one.edges["draw"] == pytest.approx(0.35 * 3.6 - 1)
    assert one.value_pick and "draw" in one.value_alerts


def test_opinion_normalizes_and_fixes_bad_picks():
    o = Opinion.from_dict("x", "x", "initial", {"probs": {"home": 50, "draw": 30, "away": 30}, "pick_1x2": "??", "over_prob": 0.4})
    assert sum(o.probs.values()) == pytest.approx(1.0)
    assert o.pick_1x2 == "home" and o.pick_ou == "under"


def test_implied_probs_removes_margin():
    p, margin = implied_probs({"home": 2.0, "draw": 3.5, "away": 3.8}, ("home", "draw", "away"))
    assert sum(p.values()) == pytest.approx(1.0)
    assert margin > 0


def test_poisson_matrix():
    probs, over = summarize_matrix(score_matrix(1.5, 1.1), 2.5)
    assert sum(probs.values()) == pytest.approx(1.0)
    assert probs["home"] > probs["away"]
    assert 0.4 < over < 0.6


def test_extract_json_from_noisy_text():
    assert extract_json('설명입니다\n```json\n{"a": 1}\n```')["a"] == 1
    assert extract_json('앞 글 {"a": {"b": 2}} 뒤 글')["a"]["b"] == 2


@pytest.fixture
def company_dir(tmp_path):
    for name in ("company.yaml", "personas", "prompts", "data"):
        src = ROOT / name
        (shutil.copytree if src.is_dir() else shutil.copy)(src, tmp_path / name)
    return tmp_path


def test_adding_a_member_needs_no_code(company_dir):
    """인원 추가 = 설정 한 줄 + 페르소나 파일 하나."""
    cfg = yaml.safe_load((company_dir / "company.yaml").read_text(encoding="utf-8"))
    (company_dir / "personas" / "jung_new.md").write_text("# 정신입\n신입 분석가", encoding="utf-8")
    (company_dir / "personas" / "choi_lead.md").write_text("# 최팀장\n팀장", encoding="utf-8")
    cfg["members"].append({"id": "jung_new", "name": "정신입", "title": "주니어", "department": "soccer",
                           "role": "analyst", "persona": "personas/jung_new.md"})
    cfg["members"].append({"id": "choi_lead", "name": "최팀장", "title": "팀장", "department": "soccer",
                           "role": "lead", "votes": False, "persona": "personas/choi_lead.md"})
    (company_dir / "company.yaml").write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf-8")

    company = load_company(company_dir / "company.yaml")
    assert len(company.voters("soccer")) == 4
    assert company.lead("soccer").name == "최팀장"

    match = Match.load(company_dir / "data" / "sample_match.json")
    run = analyze(company, match, MockClient(), Ledger(company_dir / "ledger.sqlite"))
    assert len(run.final) == 4
    assert sum(int(x) for x in run.decision.one_x_two.tally.split(":")) == 4
    assert run.decision.headline  # 팀장 코멘트가 붙음


def test_unknown_department_is_rejected(company_dir):
    cfg = yaml.safe_load((company_dir / "company.yaml").read_text(encoding="utf-8"))
    cfg["members"][0]["department"] = "nowhere"
    (company_dir / "company.yaml").write_text(yaml.safe_dump(cfg, allow_unicode=True), encoding="utf-8")
    with pytest.raises(ValueError):
        load_company(company_dir / "company.yaml")


def test_settle_review_and_weights(company_dir):
    company = load_company(company_dir / "company.yaml")
    company.policy.min_samples_for_weight = 3
    ledger = Ledger(company_dir / "ledger.sqlite")
    base = json.loads((company_dir / "data" / "sample_match.json").read_text(encoding="utf-8"))
    for i, score in enumerate([(2, 0), (1, 1), (0, 1), (3, 1)]):
        base["id"] = f"T-{i}"
        path = company_dir / f"m{i}.json"
        path.write_text(json.dumps(base, ensure_ascii=False), encoding="utf-8")
        match = Match.load(path)
        run = analyze(company, match, MockClient(), ledger)
        ledger.record(match, run.decision, run.initial + run.final, mock=False, report_path="")
        ledger.settle(match.id, *score)

    stats = ledger.member_stats("soccer")
    assert len(stats) == 3 and all(s["n"] == 4 for s in stats)
    w = ledger.weights(company, "soccer")
    lo, hi = company.policy.weight_bounds
    assert all(lo <= v <= hi for v in w.values())
    assert len(set(round(v, 6) for v in w.values())) > 1  # 성적 차이가 비중에 반영됨
    assert ledger.company_stats("soccer")["settled"] == 4


def test_mock_runs_are_excluded_from_review(company_dir):
    company = load_company(company_dir / "company.yaml")
    ledger = Ledger(company_dir / "ledger.sqlite")
    match = Match.load(company_dir / "data" / "sample_match.json")
    run = analyze(company, match, MockClient(), ledger)
    ledger.record(match, run.decision, run.initial + run.final, mock=True, report_path="")
    ledger.settle(match.id, 1, 0)
    assert ledger.member_stats("soccer") == []
    assert len(ledger.member_stats("soccer", include_mock=True)) == 3
