"""AA 스포츠 분석 웹 서버 (Flask).

화면(정적 파일)과 JSON API 를 함께 제공한다. 같은 API 를 나중에 모바일 앱이 그대로 쓴다.

공개 API
  GET  /api/matches               분석 완료 + 분석 대기 경기 목록
  GET  /api/matches/<id>          경기 분석 전체 (분석가 의견, 토론, 투표, 기초 모델)
  GET  /api/company               조직도
  GET  /api/record                인사평가 (회사·분석가 성적, 투표 비중)
  GET  /api/bets                  AI 3명의 가상 배팅 게임 (잔액, 배팅표 3장·2~5폴더 내역)
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


def renamed(obj, company: Company):
    """이름을 바꾼 분석가: 저장된 예전 이름(글 속 언급 포함)을 지금 이름으로 바꿔 보여 준다."""
    pairs = [(old, m.name) for m in company.members for old in m.former_names if old and old != m.name]
    if not pairs:
        return obj

    def fix(x):
        if isinstance(x, str):
            for a, b in pairs:
                x = x.replace(a, b)
            return x
        if isinstance(x, list):
            return [fix(v) for v in x]
        if isinstance(x, dict):
            return {k: fix(v) for k, v in x.items()}
        return x

    return fix(obj)


RULE_START = "2026-11-27 09:45"   # 이득 거르기 규칙 시작 (킥오프 문자열 'YYYY-MM-DD HH:MM KST' 와 비교)


def _alerts(run: dict, one: dict, ou: dict, result, policy) -> list:
    """이득 표시. 규칙 전에 끝난 경기는 그때 기록 그대로(성적 기록을 바꾸지 않음),
    그 밖의 경기는 지금 규칙(기대값 5%~40%, 배당 3.5 이하)으로 다시 거른다."""
    saved = one["value_alerts"] + ou["value_alerts"]
    # 새 규칙(11/27 09:45) 전에 시작한 경기는 그때 기록 그대로. 그 뒤 경기는 화면에 보인 그대로 채점되게 새 규칙 적용
    if policy is None or (result and str(run["match"].get("kickoff", "")) < RULE_START):
        return saved
    odds = run["match"].get("odds") or {}
    edges = {**(one.get("edges") or {}), **(ou.get("edges") or {})}
    out = []
    for k in saved:
        e, o = edges.get(k), odds.get(k)
        if e is not None and o and policy.value_threshold <= e <= policy.value_max_edge and float(o) <= policy.value_max_odds:
            out.append(k)
    return out


def _summary(run: dict, result: dict | None, policy=None) -> dict:
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
        "value_alerts": _alerts(run, one, ou, result, policy),
        "pick_ou": ou["pick"],
        "line": d["line"],
        "odds": run["match"].get("odds") or {},
        "over_prob": ou["probs"]["over"],
        "engine": run["engine"],
        "mock": "모의" in run["engine"],
        "pick_history": run.get("pick_history", []),
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


def _plan_limit(base: Path, ds: dict):
    lim = ds.get("api_football", {}).get("daily_limit", "auto")
    p = base / "data" / "api_plan.json"
    if lim == "auto" and p.exists():
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            return f"{j.get('limit_day')} ({j.get('plan')})"
        except (json.JSONDecodeError, OSError):
            pass
    return 100 if lim == "auto" else lim


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
            s = _summary(r, res.get(r["match"]["id"]), company.policy)
            s["league_id"], s["league_name"] = league_of(company, r["match"])
            mp = pending_dir / f"{s['id']}.json"
            if mp.exists():  # 분석 뒤에 다시 모은 배당(지금 배당)과 처음 등록 때 배당
                mm = json.loads(mp.read_text(encoding="utf-8"))
                s["odds_now"], s["odds_first"], s["kickoff_iso"] = mm.get("odds", {}), mm.get("odds_first"), mm.get("kickoff_iso")
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
                          "away": ko_name(m["away"]), "status": "pending", "odds": m.get("odds", {}),
                          "odds_first": m.get("odds_first"), "kickoff_iso": m.get("kickoff_iso")})
        from ..daily import load_picked

        picked = load_picked(company)
        for it in items:
            it["picked"] = it["id"] in picked
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
        run["summary"] = _summary(run, r, company.policy)
        mp = pending_dir / f"{mid}.json"
        if mp.exists():  # 배당 변화 표: 처음 등록 때 배당과 지금(마지막 수집) 배당
            mm = json.loads(mp.read_text(encoding="utf-8"))
            run["odds_first"], run["odds_now"] = mm.get("odds_first"), mm.get("odds", {})
            run["odds_now_at"] = mm.get("collected_at")
        run["members"] = {m.id: {"name": m.name, "title": m.title, "color": getattr(m, "color", None)} for m in company.members}
        if r:  # 결과가 나왔으면 분석가마다 처음(1차)·최종 예측이 맞았는지
            res = outcome_of(r["home_goals"], r["away_goals"])
            over = r["home_goals"] + r["away_goals"] > run["decision"]["line"]
            for o in run.get("initial", []) + run.get("final", []):
                o["hit_1x2"] = o.get("pick_1x2") == res
                o["hit_ou"] = (o.get("pick_ou") == "over") == over
        return jsonify(renamed(run, company))

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
                      "api_football_limit": _plan_limit(base, ds),
                      "odds_month": c.used("odds_api", "month"),
                      "odds_limit": ds.get("odds_api", {}).get("monthly_credits", 500)},
            "last_run": last,
        })

    @app.get("/api/bets")
    def bets():
        from ..betting import summary as bet_summary

        return jsonify(renamed(bet_summary(company), company))

    @app.get("/api/credit")
    def credit():
        from ..credit import status

        return jsonify(status(base))

    @app.get("/api/news")
    def news_list():
        from ..news import load as load_news

        d = load_news(base)
        return jsonify({"updated": d.get("updated"), "items": d.get("items", [])})

    @app.get("/api/record")
    def record():
        lg = ledger()
        out = []
        for d in company.departments.values():
            if not d.active:
                continue
            from ..daily import load_picked

            w = lg.weights(company, d.id)
            voting = {m.id for m in company.voters(d.id)}
            mine = set(load_picked(company))
            cur = {m.id: m for m in company.members}

            def mark(rows):
                for s in rows:
                    s["weight"] = w.get(s["member_id"], 1.0)
                    s["votes"] = s["member_id"] in voting
                    if s["member_id"] in cur:  # 이름을 바꿨으면 지금 이름으로
                        s["name"] = cur[s["member_id"]].name
                        s["color"] = cur[s["member_id"]].color
                return rows

            out.append({"department": d.name, "company": lg.company_stats(d.id),
                        "company_mine": lg.company_stats(d.id, ids=mine),
                        "members": mark(lg.member_stats(d.id)),                      # 토론 후 최종
                        "members_initial": mark(lg.member_stats(d.id, stage="initial")),  # 혼자 처음 낸 1차 분석
                        "members_mine": mark(lg.member_stats(d.id, ids=mine)),       # 내가 고른 경기만
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
