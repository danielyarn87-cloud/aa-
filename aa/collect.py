"""API 자료로 경기 자료(JSON)를 자동으로 만들고, 끝난 경기 결과를 자동으로 채점한다.

경기 하나당 API-Football 호출: 팀 통계 2 + 부상자 1 + 상대 전적 1 + 직전 경기 2 = 6회
(리그마다 일정 1회 + 순위 1회 추가, 모두 캐시됨). --light 면 상대 전적과 직전 경기를 건너뛰어 3회.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import Company
from .ledger import Ledger
from .sources.api_football import ApiFootball
from .sources.cache import ApiCache
from .sources.odds_api import OddsApi

SHRINK_GAMES = 3  # 경기 수가 적을 때 리그 평균 쪽으로 당기는 강도 (가상의 리그 평균 경기 3개를 섞음)


def _f(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _shrink(avg: float, n: int, league: float) -> float:
    return round((avg * n + league * SHRINK_GAMES) / (n + SHRINK_GAMES), 3)


def league_averages(standings: list) -> dict:
    hg = hp = ag = ap = 0.0
    for row in standings:
        hg += _f(row["home"]["goals"]["for"])
        hp += _f(row["home"]["played"])
        ag += _f(row["away"]["goals"]["for"])
        ap += _f(row["away"]["played"])
    home = hg / hp if hp else 1.5
    away = ag / ap if ap else 1.2
    return {"설명": "이번 시즌 리그 평균 경기당 득점 (순위표 기준)", "home_goals": round(home, 3), "away_goals": round(away, 3)}


def _row(standings: list, team_id: int) -> dict | None:
    return next((r for r in standings if r["team"]["id"] == team_id), None)


def _venue_stats(ts: dict, side: str, league_avg: dict) -> dict:
    played = int(_f(ts["fixtures"]["played"][side]))
    gf = _f(ts["goals"]["for"]["average"][side])
    ga = _f(ts["goals"]["against"]["average"][side])
    lf = league_avg["home_goals"] if side == "home" else league_avg["away_goals"]
    la = league_avg["away_goals"] if side == "home" else league_avg["home_goals"]
    return {
        "설명": f"{'홈' if side == 'home' else '원정'} 경기 경기당 득실 ({played}경기, 리그 평균 쪽으로 {SHRINK_GAMES}경기만큼 보정)",
        "xg_for": _shrink(gf, played, lf),
        "xg_against": _shrink(ga, played, la),
        "raw_goals_for": gf,
        "raw_goals_against": ga,
        "played": played,
        "record": f"{ts['fixtures']['wins'][side]}승 {ts['fixtures']['draws'][side]}무 {ts['fixtures']['loses'][side]}패",
        "form": (ts.get("form") or "")[-5:],
    }


def _injuries(items: list, team_id: int) -> tuple[list[str], list[str]]:
    out, doubt = [], []
    for it in items:
        if it["team"]["id"] != team_id:
            continue
        p = it["player"]
        text = f"{p['name']} ({p.get('reason') or '사유 미상'})"
        (doubt if (p.get("type") or "").lower().startswith("question") else out).append(text)
    return out, doubt


def _days_between(a: str, b: str) -> int | None:
    try:
        return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).days
    except ValueError:
        return None


def build_match(af: ApiFootball, league_cfg: dict, fixture: dict, odds_events: list | None, aliases: dict,
                line: float, light: bool = False, tz: str = "Asia/Seoul") -> dict:
    fx, lg, teams = fixture["fixture"], fixture["league"], fixture["teams"]
    home, away = teams["home"], teams["away"]
    season = league_cfg["season"]
    standings = af.standings(league_cfg["api_football_id"], season)
    lavg = league_averages(standings)
    ts_h = af.team_stats(league_cfg["api_football_id"], season, home["id"])
    ts_a = af.team_stats(league_cfg["api_football_id"], season, away["id"])
    inj = af.injuries(fx["id"])
    h_out, h_doubt = _injuries(inj, home["id"])
    a_out, a_doubt = _injuries(inj, away["id"])

    kickoff = datetime.fromisoformat(fx["date"]).astimezone(ZoneInfo(tz))
    data: dict = {
        "id": f"AF-{fx['id']}",
        "sport": "soccer",
        "league": f"{league_cfg['name']} {lg.get('round', '')}".strip(),
        "kickoff": kickoff.strftime("%Y-%m-%d %H:%M KST"),
        "kickoff_iso": kickoff.isoformat(),
        "home": home["name"],
        "away": away["name"],
        "odds": {"line": line},
        "league_avg": lavg,
        "stats": {
            "basis": "venue",
            "metric": "goals",
            "설명": "API-Football 팀 통계의 홈/원정 경기당 득실 (xG 아님)",
            "home": _venue_stats(ts_h, "home", lavg),
            "away": _venue_stats(ts_a, "away", lavg),
        },
        "lineup": {"home_absent": h_out, "home_doubtful": h_doubt, "away_absent": a_out, "away_doubtful": a_doubt,
                   "confirmed": False, "설명": "API-Football 부상자 목록 기준, 라인업 미발표"},
        "venue": (fx.get("venue") or {}).get("name"),
        "source_ids": {"api_football_fixture": fx["id"], "home_team": home["id"], "away_team": away["id"],
                       "league": league_cfg["api_football_id"], "season": season},
    }
    rh, ra = _row(standings, home["id"]), _row(standings, away["id"])
    if rh and ra:
        def t(r):
            a = r["all"]
            return f"{r['rank']}위 {r['points']}점 ({a['win']}승{a['draw']}무{a['lose']}패, 득실 {r['goalsDiff']:+d})"
        data["table"] = f"{home['name']} {t(rh)} / {away['name']} {t(ra)}"

    if not light:
        h2h = af.h2h(home["id"], away["id"])
        data["head_to_head"] = [
            f"{x['fixture']['date'][:10]} {x['teams']['home']['name']} {x['goals']['home']}-{x['goals']['away']} {x['teams']['away']['name']}"
            for x in h2h
        ] or "자료 없음"
        sched = {}
        for side, team in (("home", home), ("away", away)):
            last = af.last_fixture(team["id"])
            if last:
                sched[f"{side}_prev"] = f"{last['fixture']['date'][:10]} {last['league']['name']}"
                d = _days_between(last["fixture"]["date"], fx["date"])
                if d is not None:
                    sched[f"{side}_days_rest"] = d
        data["schedule"] = sched or "자료 없음"

    if odds_events is not None:
        ev = OddsApi.find_event(odds_events, home["name"], away["name"], aliases)
        if ev:
            data["odds"] = OddsApi.consensus(ev, line)
        else:
            data["odds"]["note"] = "The Odds API 에서 이 경기를 찾지 못함 (팀 이름 별칭을 확인하세요)"
    data["sources"] = ["API-Football (일정·순위·팀 통계·부상자·상대 전적)"] + (["The Odds API (배당)"] if odds_events is not None else [])
    data["collected_at"] = datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d %H:%M KST")
    return data


def _clients(company: Company, cache: ApiCache, af_transport=None, odds_transport=None):
    ds = company.data_sources
    afc, oc = ds.get("api_football", {}), ds.get("odds_api", {})
    kw_af = {"transport": af_transport} if af_transport else {}
    kw_od = {"transport": odds_transport} if odds_transport else {}
    af = ApiFootball(cache, daily_limit=int(afc.get("daily_limit", 100)), cache_hours=float(afc.get("cache_hours", 6)), **kw_af)
    od = OddsApi(cache, monthly_credits=int(oc.get("monthly_credits", 500)), regions=oc.get("regions", "eu"),
                 markets=oc.get("markets", "h2h,totals"), cache_hours=float(oc.get("cache_hours", 3)), **kw_od)
    return af, od


def collect(company: Company, days: int = 3, leagues: list[int] | None = None, limit: int | None = None,
            light: bool = False, with_odds: bool = True, af_transport=None, odds_transport=None,
            today: datetime | None = None, log=print) -> list[Path]:
    ds = company.data_sources
    tz = ds.get("timezone", "Asia/Seoul")
    cache = ApiCache(company.base_dir / "data" / "api_cache.sqlite")
    af, od = _clients(company, cache, af_transport, odds_transport)
    dept = company.department_for_sport("soccer")
    out_dir = company.base_dir / "data" / "matches"
    out_dir.mkdir(parents=True, exist_ok=True)
    start = (today or datetime.now(ZoneInfo(tz))).date()
    end = start + timedelta(days=days)
    written: list[Path] = []
    for lc in ds.get("leagues", []):
        if leagues and lc["api_football_id"] not in leagues:
            continue
        fixtures = af.fixtures(lc["api_football_id"], lc["season"], start.isoformat(), end.isoformat(), tz)
        fixtures = [f for f in fixtures if f["fixture"]["status"]["short"] in ("NS", "TBD")]
        if not fixtures:
            continue
        events = None
        if with_odds and lc.get("odds_key"):
            try:
                events = od.odds(lc["odds_key"])
            except Exception as e:  # 배당이 없어도 경기 자료는 만든다
                log(f"  배당 수집 실패 ({lc['name']}): {e}")
        log(f"{lc['name']}: 예정 경기 {len(fixtures)}개")
        for f in fixtures:
            if limit is not None and len(written) >= limit:
                return written
            m = build_match(af, lc, f, events, ds.get("team_aliases", {}), dept.over_under_line, light, tz)
            path = out_dir / f"{m['id']}.json"
            path.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
            written.append(path)
            log(f"  - {m['kickoff']} {m['home']} vs {m['away']} → {path.name}")
    log(f"API-Football 오늘 사용량: {cache.used('api_football', 'day')} / {af.daily_limit}, "
        f"The Odds API 이번 달 사용량: {cache.used('odds_api', 'month')} / {od.monthly}")
    return written


def sync_results(company: Company, ledger: Ledger, af_transport=None, log=print) -> int:
    """기록부에서 결과가 없는 API 경기(AF-…)를 찾아, 끝났으면 점수를 넣는다."""
    cache = ApiCache(company.base_dir / "data" / "api_cache.sqlite")
    af, _ = _clients(company, cache, af_transport)
    pending = ledger.db.execute(
        "SELECT d.match_id FROM decisions d LEFT JOIN results r ON r.match_id = d.match_id"
        " WHERE r.match_id IS NULL AND d.match_id LIKE 'AF-%'"
    ).fetchall()
    done = 0
    for (mid,) in pending:
        fx = af.get("/fixtures", cache_hours=0.5, id=int(mid[3:]))
        if not fx:
            continue
        fx = fx[0]
        if fx["fixture"]["status"]["short"] in ("FT", "AET", "PEN"):
            # 승무패·언더/오버는 90분 기준이므로 연장·승부차기 경기는 정규시간 점수를 쓴다
            score = fx.get("score", {}).get("fulltime") or fx["goals"]
            ledger.settle(mid, int(score["home"]), int(score["away"]))
            log(f"{mid} 결과 {score['home']}-{score['away']} 기록")
            done += 1
    return done
