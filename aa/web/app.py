"""AA 스포츠 분석 웹 서버 (Flask).

화면(정적 파일)과 JSON API 를 함께 제공한다. 같은 API 를 나중에 모바일 앱이 그대로 쓴다.

공개 API
  GET  /api/matches               분석 완료 + 분석 대기 경기 목록
  GET  /api/matches/<id>          경기 분석 전체 (분석가 의견, 토론, 투표, 기초 모델)
  GET  /api/company               조직도
  GET  /api/record                인사평가 (회사·분석가 성적, 투표 비중)
관리 API (헤더 X-Admin-Token = 환경변수 AA_ADMIN_TOKEN)
  POST /api/admin/collect         {"days": 3, "league": "39"}
  POST /api/admin/analyze/<id>    {"engine": "claude" | "mock"}
  POST /api/admin/sync            끝난 경기 자동 채점
  POST /api/admin/settle/<id>     {"score": "2-1"}
  GET  /api/admin/usage           API 사용량
"""
from __future__ import annotations

import hmac
import json
from datetime import datetime, timezone
import os
import threading
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

from ..config import Company
from ..ledger import Ledger, outcome_of
from ..models import Match
from ..store import load_runs, save_run

STATIC = Path(__file__).parent / "static"


def _summary(run: dict, result: dict | None) -> dict:
    d = run["decision"]
    one, ou = d["one_x_two"], d["over_under"]
    out = {
        "id": run["match"]["id"],
        "league": run["match"]["league"],
        "kickoff": run["match"]["kickoff"],
        "home": run["match"]["home"],
        "away": run["match"]["away"],
        "status": "analyzed",
        "pick_1x2": one["pick"],
        "tally_1x2": one["tally"],
        "probs": one["probs"],
        "market_probs": one["market_probs"],
        "value_alerts": one["value_alerts"] + ou["value_alerts"],
        "pick_ou": ou["pick"],
        "line": d["line"],
        "over_prob": ou["probs"]["over"],
        "engine": run["engine"],
        "mock": "모의" in run["engine"],
    }
    if result:
        res = outcome_of(result["home_goals"], result["away_goals"])
        total = result["home_goals"] + result["away_goals"]
        out["result"] = {
            "score": f"{result['home_goals']}-{result['away_goals']}",
            "outcome": res,
            "hit_1x2": None if one["pick"] is None else one["pick"] == res,
            "hit_ou": None if ou["pick"] is None else (ou["pick"] == "over") == (total > d["line"]),
        }
    return out


def create_app(company: Company) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.json.ensure_ascii = False
    base = company.base_dir
    reports = base / "reports"
    pending_dir = base / "data" / "matches"
    lock = threading.Lock()

    def ledger() -> Ledger:
        return Ledger(base / "data" / "ledger.sqlite")

    def results() -> dict:
        rows = ledger().db.execute("SELECT match_id, home_goals, away_goals FROM results").fetchall()
        return {r["match_id"]: dict(r) for r in rows}

    def admin() -> None:
        token = os.environ.get("AA_ADMIN_TOKEN")
        given = request.headers.get("X-Admin-Token", "")
        if not token:
            abort(403, "관리 기능이 꺼져 있습니다. 서버에 AA_ADMIN_TOKEN 환경변수를 설정하세요.")
        if not hmac.compare_digest(token, given):
            abort(401, "관리자 토큰이 맞지 않습니다.")

    @app.errorhandler(400)
    @app.errorhandler(401)
    @app.errorhandler(403)
    @app.errorhandler(404)
    @app.errorhandler(500)
    def err(e):
        return jsonify({"error": getattr(e, "description", str(e))}), getattr(e, "code", 500)

    # ---- 화면 --------------------------------------------------------------
    @app.get("/")
    def index():
        return send_from_directory(STATIC, "index.html")

    @app.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(STATIC, name)

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_from_directory(STATIC, "manifest.webmanifest", mimetype="application/manifest+json")

    # ---- 공개 API ----------------------------------------------------------
    @app.get("/api/health")
    def health():
        log = base / "data" / "daily_log.jsonl"
        last = None
        if log.exists():
            lines = log.read_text(encoding="utf-8").strip().splitlines()
            last = json.loads(lines[-1]) if lines else None
        return jsonify({"ok": True, "last_daily_run": last})

    @app.get("/api/matches")
    def matches():
        res = results()
        runs = load_runs(reports)
        analyzed = {r["match"]["id"] for r in runs}
        items = [_summary(r, res.get(r["match"]["id"])) for r in runs]
        for p in sorted(pending_dir.glob("*.json")) if pending_dir.exists() else []:
            m = json.loads(p.read_text(encoding="utf-8"))
            if m["id"] in analyzed:
                continue
            ko = m.get("kickoff_iso")
            if ko and datetime.fromisoformat(ko) < datetime.now(timezone.utc):
                continue  # 분석하지 못하고 지나간 경기는 숨김
            items.append({"id": m["id"], "league": m["league"], "kickoff": m["kickoff"], "home": m["home"],
                          "away": m["away"], "status": "pending", "odds": m.get("odds", {})})
        items.sort(key=lambda x: x["kickoff"])
        return jsonify({"company": company.name, "matches": items})

    @app.get("/api/matches/<mid>")
    def match(mid):
        p = reports / f"{mid}.json"
        if not p.exists():
            abort(404, "아직 분석하지 않은 경기입니다.")
        run = json.loads(p.read_text(encoding="utf-8"))
        r = results().get(mid)
        run["summary"] = _summary(run, r)
        run["members"] = {m.id: {"name": m.name, "title": m.title, "color": getattr(m, "color", None)} for m in company.members}
        return jsonify(run)

    @app.get("/api/company")
    def org():
        depts = []
        for d in company.departments.values():
            people = []
            for m in company.members:
                if m.department != d.id:
                    continue
                persona = m.persona() if m.persona_path.exists() else ""
                people.append({"id": m.id, "name": m.name, "title": m.title, "role": m.role, "votes": m.votes, "color": m.color,
                               "active": m.active, "base_weight": m.base_weight, "persona": persona})
            depts.append({"id": d.id, "name": d.name, "sport": d.sport, "active": d.active, "members": people})
        p = company.policy
        return jsonify({"name": company.name, "departments": depts,
                        "policy": {"consensus_share": p.consensus_share, "value_threshold": p.value_threshold,
                                   "min_samples_for_weight": p.min_samples_for_weight}})

    @app.get("/api/record")
    def record():
        lg = ledger()
        out = []
        for d in company.departments.values():
            if not d.active:
                continue
            w = lg.weights(company, d.id)
            members = lg.member_stats(d.id)
            for s in members:
                s["weight"] = w.get(s["member_id"], 1.0)
            out.append({"department": d.name, "company": lg.company_stats(d.id), "members": members,
                        "weights": {m.name: w.get(m.id, 1.0) for m in company.voters(d.id)}})
        return jsonify({"departments": out, "min_samples": company.policy.min_samples_for_weight})

    # ---- 관리 API ----------------------------------------------------------
    @app.post("/api/admin/collect")
    def admin_collect():
        admin()
        from ..collect import collect

        body = request.get_json(silent=True) or {}
        leagues = [int(x) for x in str(body.get("league", "")).split(",") if x.strip()] or None
        log: list[str] = []
        with lock:
            paths = collect(company, days=int(body.get("days", 3)), leagues=leagues,
                            limit=body.get("limit"), light=bool(body.get("light")), log=log.append)
        return jsonify({"collected": [p.stem for p in paths], "log": log})

    @app.post("/api/admin/analyze/<mid>")
    def admin_analyze(mid):
        admin()
        from ..llm import ClaudeClient, MockClient
        from ..pipeline import analyze

        p = pending_dir / f"{mid}.json"
        if not p.exists():
            p = base / "data" / f"{mid}.json"
        if not p.exists():
            abort(404, "경기 자료가 없습니다.")
        body = request.get_json(silent=True) or {}
        mock = body.get("engine") == "mock"
        client = MockClient() if mock else ClaudeClient(model=company.model)
        m = Match.load(p)
        with lock:
            lg = ledger()
            run = analyze(company, m, client, lg)
            md, _ = save_run(run, reports)
            lg.record(m, run.decision, run.initial + run.final, mock=mock, report_path=str(md))
        return jsonify({"ok": True, "id": mid})

    @app.post("/api/admin/sync")
    def admin_sync():
        admin()
        from ..collect import sync_results

        with lock:
            n = sync_results(company, ledger(), log=lambda *_: None)
        return jsonify({"settled": n})

    @app.post("/api/admin/settle/<mid>")
    def admin_settle(mid):
        admin()
        body = request.get_json(silent=True) or {}
        try:
            hg, ag = (int(x) for x in str(body.get("score", "")).split("-"))
        except ValueError:
            abort(400, "점수는 2-1 형식으로 보내세요.")
        try:
            ledger().settle(mid, hg, ag)
        except KeyError as e:
            abort(404, str(e))
        return jsonify({"ok": True})

    @app.get("/api/admin/usage")
    def admin_usage():
        admin()
        from ..sources.cache import ApiCache

        c = ApiCache(base / "data" / "api_cache.sqlite")
        ds = company.data_sources
        return jsonify({
            "api_football": {"used_today": c.used("api_football", "day"), "limit": ds.get("api_football", {}).get("daily_limit", 100)},
            "odds_api": {"used_month": c.used("odds_api", "month"), "limit": ds.get("odds_api", {}).get("monthly_credits", 500)},
        })

    return app
