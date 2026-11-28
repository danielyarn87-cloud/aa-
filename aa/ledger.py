"""예측 기록부와 인사평가(채점).

모든 분석가의 예측(첫 분석, 토론 후)과 회사 결론을 SQLite 에 남기고,
경기 결과가 들어오면 분석가별 성적을 계산해 다음 경기의 투표 비중에 반영한다.
모의 실행 기록은 채점에서 제외한다.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .config import Company
from .models import OUTCOMES, Decision, Match, Opinion

SCHEMA = """
CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL,
    department TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    stage TEXT NOT NULL,
    p_home REAL, p_draw REAL, p_away REAL,
    over_prob REAL, line REAL,
    pick_1x2 TEXT, pick_ou TEXT, confidence TEXT,
    mock INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
    match_id TEXT PRIMARY KEY,
    department TEXT NOT NULL,
    sport TEXT NOT NULL,
    title TEXT NOT NULL,
    kickoff TEXT,
    line REAL,
    p_home REAL, p_draw REAL, p_away REAL, over_prob REAL,
    pick_1x2 TEXT, pick_ou TEXT,
    odds_json TEXT,
    mock INTEGER NOT NULL DEFAULT 0,
    report_path TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
    match_id TEXT PRIMARY KEY,
    home_goals INTEGER NOT NULL,
    away_goals INTEGER NOT NULL,
    settled_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def outcome_of(home_goals: int, away_goals: int) -> str:
    return "home" if home_goals > away_goals else "draw" if home_goals == away_goals else "away"


def brier_1x2(probs: dict[str, float], result: str) -> float:
    return sum((probs[k] - (1.0 if k == result else 0.0)) ** 2 for k in OUTCOMES)


class Ledger:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # ---- 기록 --------------------------------------------------------------
    def record(self, match: Match, decision: Decision, opinions: list[Opinion], mock: bool, report_path: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM predictions WHERE match_id = ?", (match.id,))
            for o in opinions:
                self.db.execute(
                    "INSERT INTO predictions (match_id, department, member_id, member_name, stage, p_home, p_draw, p_away,"
                    " over_prob, line, pick_1x2, pick_ou, confidence, mock, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        match.id, decision.department, o.member_id, o.member_name, o.stage,
                        o.probs["home"], o.probs["draw"], o.probs["away"], o.over_prob, decision.line,
                        o.pick_1x2, o.pick_ou, o.confidence, int(mock), _now(),
                    ),
                )
            one, ou = decision.one_x_two, decision.over_under
            self.db.execute(
                "INSERT OR REPLACE INTO decisions (match_id, department, sport, title, kickoff, line, p_home, p_draw, p_away,"
                " over_prob, pick_1x2, pick_ou, odds_json, mock, report_path, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    match.id, decision.department, match.sport, match.title, match.kickoff, decision.line,
                    one.probs["home"], one.probs["draw"], one.probs["away"], ou.probs["over"],
                    one.pick, ou.pick, json.dumps(match.odds, ensure_ascii=False), int(mock), report_path, _now(),
                ),
            )

    def add_opinions(self, match_id: str, department: str, line: float, opinions: list[Opinion], mock: bool) -> None:
        """이미 기록된 경기에 분석가 의견만 더한다 (나중에 합류한 분석가). 같은 사람의 옛 기록은 바꾼다."""
        with self.db:
            for mid in {o.member_id for o in opinions}:
                self.db.execute("DELETE FROM predictions WHERE match_id = ? AND member_id = ?", (match_id, mid))
            for o in opinions:
                self.db.execute(
                    "INSERT INTO predictions (match_id, department, member_id, member_name, stage, p_home, p_draw, p_away,"
                    " over_prob, line, pick_1x2, pick_ou, confidence, mock, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (match_id, department, o.member_id, o.member_name, o.stage, o.probs["home"], o.probs["draw"],
                     o.probs["away"], o.over_prob, line, o.pick_1x2, o.pick_ou, o.confidence, int(mock), _now()),
                )

    def reline(self, run: dict) -> None:
        """운영자가 기준점을 바꾼 경기: 분석가 기록과 회사 결론의 언더/오버 부분만 새 기준점으로 고친다."""
        mid, d = run["match"]["id"], run["decision"]
        with self.db:
            for o in run.get("initial", []) + run.get("final", []):
                stage = o.get("stage") or "debate"
                self.db.execute("UPDATE predictions SET over_prob = ?, pick_ou = ?, line = ? WHERE match_id = ? AND member_id = ? AND stage = ?",
                                (o["over_prob"], o["pick_ou"], d["line"], mid, o["member_id"], stage))
            ou = d["over_under"]
            self.db.execute("UPDATE decisions SET line = ?, over_prob = ?, pick_ou = ?, odds_json = ? WHERE match_id = ?",
                            (d["line"], ou["probs"]["over"], ou["pick"], json.dumps(run["match"].get("odds") or {}, ensure_ascii=False), mid))

    def backfill_from_reports(self, reports_dir: Path) -> int:
        """기록부에 없는 분석 결과(reports/*.json)를 기록부에 다시 넣는다. 기록부를 잃어버려도 복구된다."""
        from types import SimpleNamespace as NS

        have = {r[0] for r in self.db.execute("SELECT match_id FROM decisions")}
        n = 0
        for p in sorted(Path(reports_dir).glob("*.json")):
            try:
                run = json.loads(p.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            m = run["match"]
            if m["id"] in have:
                continue
            d = run["decision"]
            match = NS(id=m["id"], sport=m["sport"], title=f"{m['home']} vs {m['away']}", kickoff=m["kickoff"], odds=m["odds"])
            dec = NS(department=d["department"], line=d["line"],
                     one_x_two=NS(probs=d["one_x_two"]["probs"], pick=d["one_x_two"]["pick"]),
                     over_under=NS(probs=d["over_under"]["probs"], pick=d["over_under"]["pick"]))
            ops = [Opinion.from_dict(o["member_id"], o["member_name"], o["stage"], o) for o in run["initial"] + run["final"]]
            self.record(match, dec, ops, mock="모의" in run.get("engine", ""), report_path=str(p.with_suffix(".md")))
            n += 1
        return n

    def settle(self, match_id: str, home_goals: int, away_goals: int) -> None:
        if not self.db.execute("SELECT 1 FROM decisions WHERE match_id = ?", (match_id,)).fetchone():
            raise KeyError(f"기록에 없는 경기입니다: {match_id}")
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO results (match_id, home_goals, away_goals, settled_at) VALUES (?,?,?,?)",
                (match_id, home_goals, away_goals, _now()),
            )

    # ---- 채점 --------------------------------------------------------------
    def member_stats(self, department: str, include_mock: bool = False, stage: str = "debate",
                     ids: set | None = None) -> list[dict]:
        """분석가별 성적. stage='debate' 는 토론 후 최종, 'initial' 은 혼자 처음 낸 1차 분석. ids 를 주면 그 경기들만."""
        rows = self.db.execute(
            "SELECT p.*, r.home_goals, r.away_goals, d.odds_json FROM predictions p"
            " JOIN results r ON r.match_id = p.match_id JOIN decisions d ON d.match_id = p.match_id"
            " WHERE p.department = ? AND p.stage = ? AND (? OR p.mock = 0)",
            (department, stage, int(include_mock)),
        ).fetchall()
        if ids is not None:
            rows = [r for r in rows if r["match_id"] in ids]
        by: dict[str, dict] = {}
        for r in rows:
            s = by.setdefault(
                r["member_id"],
                {"member_id": r["member_id"], "name": r["member_name"], "n": 0, "hit_1x2": 0, "brier_1x2": 0.0,
                 "hit_ou": 0, "brier_ou": 0.0, "profit": 0.0},
            )
            res = outcome_of(r["home_goals"], r["away_goals"])
            over = (r["home_goals"] + r["away_goals"]) > r["line"]
            probs = {"home": r["p_home"], "draw": r["p_draw"], "away": r["p_away"]}
            odds = json.loads(r["odds_json"])
            s["n"] += 1
            s["hit_1x2"] += int(r["pick_1x2"] == res)
            s["brier_1x2"] += brier_1x2(probs, res)
            s["hit_ou"] += int((r["pick_ou"] == "over") == over)
            s["brier_ou"] += (r["over_prob"] - (1.0 if over else 0.0)) ** 2
            o = odds.get(r["pick_1x2"])
            if o:
                s["profit"] += (float(o) - 1) if r["pick_1x2"] == res else -1.0
        out = []
        for s in by.values():
            n = s["n"]
            out.append(
                {
                    "member_id": s["member_id"],
                    "name": s["name"],
                    "n": n,
                    "acc_1x2": s["hit_1x2"] / n,
                    "brier_1x2": s["brier_1x2"] / n,
                    "acc_ou": s["hit_ou"] / n,
                    "brier_ou": s["brier_ou"] / n,
                    "roi_1x2": s["profit"] / n,
                }
            )
        return sorted(out, key=lambda x: x["brier_1x2"])

    def company_stats(self, department: str, include_mock: bool = False, ids: set | None = None) -> dict:
        rows = self.db.execute(
            "SELECT d.*, r.home_goals, r.away_goals FROM decisions d JOIN results r ON r.match_id = d.match_id"
            " WHERE d.department = ? AND (? OR d.mock = 0)",
            (department, int(include_mock)),
        ).fetchall()
        if ids is not None:
            rows = [r for r in rows if r["match_id"] in ids]
        n = len(rows)
        picks = [r for r in rows if r["pick_1x2"]]
        hits = profit = 0.0
        for r in picks:
            res = outcome_of(r["home_goals"], r["away_goals"])
            o = json.loads(r["odds_json"]).get(r["pick_1x2"])
            win = r["pick_1x2"] == res
            hits += win
            if o:
                profit += (float(o) - 1) if win else -1.0
        ou_picks = [r for r in rows if r["pick_ou"]]
        ou_hits = sum(((r["home_goals"] + r["away_goals"]) > r["line"]) == (r["pick_ou"] == "over") for r in ou_picks)
        return {
            "settled": n,
            "picks_1x2": len(picks),
            "passes_1x2": n - len(picks),
            "acc_1x2": hits / len(picks) if picks else None,
            "roi_1x2": profit / len(picks) if picks else None,
            "picks_ou": len(ou_picks),
            "acc_ou": ou_hits / len(ou_picks) if ou_picks else None,
        }

    def weights(self, company: Company, department: str) -> dict[str, float]:
        """성적 기반 투표 비중. 표본이 부족하면 기본 비중을 그대로 쓴다."""
        voters = company.voters(department)
        base = {m.id: m.base_weight for m in voters}
        stats = {s["member_id"]: s for s in self.member_stats(department)}
        ready = [s for mid, s in stats.items() if mid in base and s["n"] >= company.policy.min_samples_for_weight]
        if not ready:
            return base
        avg = sum(s["brier_1x2"] for s in ready) / len(ready)
        lo, hi = company.policy.weight_bounds
        out = dict(base)
        for s in ready:
            ratio = avg / s["brier_1x2"] if s["brier_1x2"] > 0 else hi
            out[s["member_id"]] = min(max(base[s["member_id"]] * ratio, lo), hi)
        return out
