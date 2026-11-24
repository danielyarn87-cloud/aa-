"""분석 결과 저장: 사람이 읽는 리포트(.md)와 웹·앱이 읽는 데이터(.json)를 함께 남긴다."""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .report import render


def run_to_dict(run) -> dict:
    m = run.match
    return {
        "match": {"id": m.id, "sport": m.sport, "league": m.league, "kickoff": m.kickoff, "home": m.home,
                  "away": m.away, "odds": m.odds, "data": m.data},
        "decision": asdict(run.decision),
        "initial": [o.to_dict() for o in run.initial],
        "final": [o.to_dict() for o in run.final],
        "base": {"probs": run.base["probs"], "over_prob": run.base["over_prob"],
                 "lambdas": list(run.base.get("lambdas", ())), "detail": run.base["detail"]},
        "market": {"1x2": run.market_1x2, "ou": run.market_ou, "margin_1x2": run.margin_1x2},
        "engine": run.engine,
        "analyzed_at": datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d %H:%M KST"),
    }


def save_run(run, reports_dir: Path) -> tuple[Path, Path]:
    reports_dir.mkdir(parents=True, exist_ok=True)
    md = reports_dir / f"{run.match.id}.md"
    js = reports_dir / f"{run.match.id}.json"
    md.write_text(render(run), encoding="utf-8")
    js.write_text(json.dumps(run_to_dict(run), ensure_ascii=False, indent=2), encoding="utf-8")
    return md, js


def load_runs(reports_dir: Path) -> list[dict]:
    out = []
    for p in sorted(reports_dir.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    return out
