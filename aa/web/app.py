"""AA 스포츠 분석 웹 서버 (Flask).

화면(정적 파일)과 JSON API 를 함께 제공한다. 같은 API 를 나중에 모바일 앱이 그대로 쓴다.

공개 API
  GET  /api/matches               분석 완료 + 분석 대기 경기 목록
  GET  /api/matches/<id>          경기 분석 전체 (분석가 의견, 토론, 투표, 기초 모델)
  GET  /api/company               조직도
  GET  /api/record                인사평가 (회사·분석가 성적, 투표 비중)
  GET  /api/bets                  AI 3명의 가상 배팅 게임 (잔액, 3·5·7폴더 배팅 내역)
  GET  /api/leagues               고를 수 있는 리그, 기본 리그, API 사용량 (사이트의 '분석 요청' 화면)
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
from ..teams_ko import ko as ko_name

STATIC = Path(__file__).parent / "static"


def _summary(run: dict, result: dict | None) -> dict:
    d = run["decision"]
    one, ou = d["one_x_two"], d["over_under"]
    out = {
        "id": run["match"]["id"],
        "league": run["match"]["league"],
        "kickoff": run["match"]["kickoff"],
        "home": ko_name(run["match"]["home"]),
        "away": ko_name(run["match"]["away"]),
        "status": "analyzed",
        "pick_1x2": one["pick"],
        "tally_1x2": one["tally"],
        "probs": one["probs"],
        "market_probs": one["market_probs"],
        "value_alerts": one["value_alerts"] + ou["value_alerts"],
        "pick_ou": ou["pick"],
        "line": d["line"],
        "odds": run["match"].get("odds") or {},
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


def league_of(company: Company, m: dict) -> tuple[int | None, str]:
    """경기의 리그 번호와 이름. 예전 자료에는 번호가 없어 리그 이름 앞부분으로 맞춘다."""
    leagues = company.data_sources.get("leagues", [])
    lid = m.get("league_id") or (m.get("source_ids") or {}).get("league")
    if lid is not None:
        name = next((lc["name"] for lc in leagues if lc["api_football_id"] == int(lid)), None)
        if name:
            return int(lid), name
    text = str(m.get("league", ""))
    for lc in sorted(leagues, key=lambda x: -len(x["name"])):
        if text.startswith(lc["name"]):
            return lc["api_football_id"], lc["name"]
    return None, text.split(" ")[0] if text else "기타"


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
        items = []
        for r in runs:
            s = _summary(r, res.get(r["match"]["id"]))
            s["league_id"], s["league_name"] = league_of(company, r["match"])
            items.append(s)
        for p in sorted(pending_dir.glob("*.json")) if pending_dir.exists() else []:
            m = json.loads(p.read_text(encoding="utf-8"))
            if m["id"] in analyzed:
                continue
            ko = m.get("kickoff_iso")
            if ko and datetime.fromisoformat(ko) < datetime.now(timezone.utc):
                continue  # 분석하지 못하고 지나간 경기는 숨김
            lid, lname = league_of(company, m)
            items.append({"id": m["id"], "league": m["league"], "league_id": lid, "league_name": lname,
                          "kickoff": m["kickoff"], "home": ko_name(m["home"]),
                          "away": ko_name(m["away"]), "status": "pending", "odds": m.get("odds", {})})
        items.sort(key=lambda x: x["kickoff"])
        return jsonify({"company": company.name, "matches": items})

    @app.get("/api/matches/<mid>")
    def match(mid):
        p = reports / f"{mid}.json"
        if not p.exists():
            abort(404, "아직 분석하지 않은 경기입니다.")
        run = json.loads(p.read_text(encoding="utf-8"))
        for side in ("home", "away"):  # 예전 분석은 영어 이름으로 저장돼 있어 화면에서만 바꾼다
            run["match"][side] = ko_name(run["match"][side])
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

    @app.get("/api/leagues")
    def leagues():
        from ..daily import default_leagues
        from ..sources.cache import ApiCache

        ds, auto = company.data_sources, company.automation
        c = ApiCache(base / "data" / "api_cache.sqlite")
        log = base / "data" / "daily_log.jsonl"
        last = None
        if log.exists():
            lines = log.read_text(encoding="utf-8").strip().splitlines()
            last = json.loads(lines[-1]) if lines else None
        return jsonify({
            "leagues": [{"id": lc["api_football_id"], "name": lc["name"], "group": lc.get("group", "기타"),
                         "has_odds": bool(lc.get("odds_key"))} for lc in ds.get("leagues", [])],
            "defaults": default_leagues(company),
            "max_per_run": int(auto.get("max_analyses_per_day", 10)),
            "usage": {"api_football_today": c.used("api_football", "day"),
                      "api_football_limit": ds.get("api_football", {}).get("daily_limit", 100),
                      "odds_month": c.used("odds_api", "month"),
                      "odds_limit": ds.get("odds_api", {}).get("monthly_credits", 500)},
            "last_run": last,
        })

    @app.get("/api/bets")
    def bets():
        from ..betting import summary as bet_summary

        return jsonify(bet_summary(company))

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
