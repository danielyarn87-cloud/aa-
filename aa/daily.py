"""매일 자동 실행: 끝난 경기 채점 → 예정 경기 수집 → 새 경기 분석.

python -m aa daily      지금 한 번 실행
python -m aa worker     company.yaml 의 automation.run_at 시각마다 계속 실행 (서버에서 상시 구동)
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .collect import collect, sync_results
from .config import Company
from .ledger import Ledger
from .models import Match
from .pipeline import analyze
from .store import save_run

KST = ZoneInfo("Asia/Seoul")


def _kickoff(m: dict) -> datetime | None:
    iso = m.get("kickoff_iso")
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
        return dt if dt.tzinfo else dt.replace(tzinfo=KST)
    except ValueError:
        return None


def _kickoff_text(text: str) -> datetime | None:
    """분석 결과에 저장된 '2026-11-25 04:45 KST' 형식의 킥오프."""
    try:
        return datetime.strptime(text[:16], "%Y-%m-%d %H:%M").replace(tzinfo=KST)
    except ValueError:
        return None


def _league_id(m: dict) -> int | None:
    lid = m.get("league_id") or (m.get("source_ids") or {}).get("league")
    return int(lid) if lid is not None else None


def analyzed_today(company: Company, now: datetime) -> int:
    reports = company.base_dir / "reports"
    today = now.astimezone(KST).strftime("%Y-%m-%d")
    n = 0
    for p in reports.glob("*.json") if reports.exists() else []:
        try:
            run = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if str(run.get("analyzed_at", "")).startswith(today) and "모의" not in run.get("engine", ""):
            n += 1
    return n


def settings_path(company: Company) -> Path:
    return company.base_dir / "data" / "settings.json"


def saved_leagues(company: Company) -> list[int] | None:
    """사이트의 '분석 요청' 화면에서 저장한 기본 리그 (data/settings.json). 없으면 None."""
    p = settings_path(company)
    if not p.exists():
        return None
    try:
        leagues = json.loads(p.read_text(encoding="utf-8")).get("leagues")
        return [int(x) for x in leagues] if leagues else None
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def default_leagues(company: Company) -> list[int]:
    return saved_leagues(company) or list(company.automation.get("leagues") or [])


def due_matches(company: Company, now: datetime, within_hours: float, leagues: list[int] | None = None,
                include_analyzed: bool = False) -> list[Path]:
    """아직 분석하지 않았고 킥오프가 지금부터 within_hours 안에 있는 경기, 킥오프 순.
    leagues 가 있으면 그 리그 경기만."""
    pending = company.base_dir / "data" / "matches"
    reports = company.base_dir / "reports"
    out = []
    for p in pending.glob("*.json") if pending.exists() else []:
        if (reports / p.name).exists() and not include_analyzed:
            continue
        m = json.loads(p.read_text(encoding="utf-8"))
        if leagues and _league_id(m) not in leagues:
            continue
        ko = _kickoff(m)
        if ko and now < ko <= now + timedelta(hours=within_hours):
            out.append((ko, p))
    return [p for _, p in sorted(out)]


def picked_path(company: Company) -> Path:
    return company.base_dir / "data" / "picked.json"


def load_picked(company: Company) -> dict:
    """사이트에서 직접 골라 분석을 요청한 경기 {경기번호: 요청 시각}."""
    p = picked_path(company)
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("ids", {})
    except (OSError, ValueError):
        return {}


def _save_picked(company: Company, ids: list[str], now: datetime) -> None:
    cur = load_picked(company)
    at = now.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")
    for i in ids:
        cur.setdefault(i, at)
    p = picked_path(company)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"ids": cur}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def picked_matches(company: Company, now: datetime, ids: list[str], include_analyzed: bool = False) -> list[Path]:
    """고른 경기 중 아직 시작하지 않았고 (다시 분석이 아니면) 분석하지 않은 경기, 킥오프 순."""
    pending = company.base_dir / "data" / "matches"
    reports = company.base_dir / "reports"
    out = []
    for i in dict.fromkeys(ids):
        p = pending / f"{i}.json"
        if not p.exists() or ((reports / p.name).exists() and not include_analyzed):
            continue
        ko = _kickoff(json.loads(p.read_text(encoding="utf-8")))
        if ko and ko > now:
            out.append((ko, p))
    return [p for _, p in sorted(out)]


def catch_up_members(company: Company, ledger: Ledger, now: datetime, client_factory=None, log=print) -> int:
    """킥오프가 catch_up_hours(기본 48시간) 안이고 이미 분석된 경기 중, 의견이 없는 분석가가 있으면 채운다."""
    from .pipeline import join_member
    from .store import load_runs

    hours = float(company.automation.get("catch_up_hours", 48))
    voters = company.analysts("soccer")
    reports = company.base_dir / "reports"
    client, n = None, 0
    for run in load_runs(reports):
        ko = _kickoff(run["match"]) or _kickoff_text(run["match"].get("kickoff", ""))
        if not ko or not (now < ko <= now + timedelta(hours=hours)):
            continue
        have = {o["member_id"] for o in run.get("final", [])}
        missing = [m for m in voters if m.id not in have]
        if not missing:
            continue
        if client is None:
            client = client_factory() if client_factory else _default_client(company)
        mock = "모의" in run.get("engine", "")
        for m in missing:
            first, final = join_member(company, run, m, client)
            run["initial"].append(first.to_dict())
            run["final"].append(final.to_dict())
            ledger.add_opinions(run["match"]["id"], run["decision"]["department"], run["decision"]["line"], [first, final], mock)
            n += 1
            log(f"합류 분석: {m.name} → {run['match']['home']} vs {run['match']['away']}")
        p = reports / f"{run['match']['id']}.json"
        p.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
    return n


def run_daily(company: Company, client_factory=None, now: datetime | None = None, log=print,
              af_transport=None, odds_transport=None) -> dict:
    auto = company.automation
    now = now or datetime.now(KST)
    ledger = Ledger(company.base_dir / "data" / "ledger.sqlite")
    summary: dict = {"at": now.astimezone(KST).strftime("%Y-%m-%d %H:%M KST"), "settled": 0, "collected": 0, "analyzed": [], "errors": []}

    # 0) 기록부에 빠진 분석이 있으면 채워 넣기 (기록부를 새로 만든 경우 등)
    ledger.backfill_from_reports(company.base_dir / "reports")

    # 0-1) 운영자가 바꾼 언더/오버 기준점 반영 (lines.yml 이 놓친 것까지)
    try:
        from .lines import reline_all

        reline_all(company, log=log)
    except Exception as e:
        summary["errors"].append(f"기준점: {e}")

    # 1) 끝난 경기 채점
    try:
        summary["settled"] = sync_results(company, ledger, af_transport=af_transport, log=log)
    except Exception as e:  # 한 단계가 실패해도 다음 단계는 진행
        summary["errors"].append(f"채점: {e}")

    # 2) 예정 경기 수집
    try:
        paths = collect(company, days=int(auto.get("collect_days", 2)), leagues=auto.get("leagues") or None,
                        light=bool(auto.get("light", False)),
                        full_within_hours=float(auto.get("analyze_within_hours", 48)),
                        af_transport=af_transport, odds_transport=odds_transport, today=now, log=log)
        summary["collected"] = len(paths)
    except Exception as e:
        summary["errors"].append(f"수집: {e}")

    # 3) 분석: 사이트에서 고른 경기만 (자동 분석이 꺼져 있으면 고른 경기가 없을 때 분석하지 않음)
    room = int(auto.get("max_analyses_per_day", 10)) - analyzed_today(company, now)
    only = [str(i) for i in (auto.get("only_ids") or [])]
    if only:
        due = picked_matches(company, now, only, include_analyzed=bool(auto.get("reanalyze")))
        room = max(room, len(due))
        _save_picked(company, only, now)
        log(f"고른 경기 {len(only)}개 중 분석할 경기 {len(due)}개")
    elif auto.get("auto_analyze", True):
        due = due_matches(company, now, float(auto.get("analyze_within_hours", 48)), leagues=auto.get("leagues") or None,
                          include_analyzed=bool(auto.get("reanalyze")))
    else:
        due = []
        log("자동 분석 꺼짐: 경기 목록만 모았습니다. 분석은 사이트의 '분석 요청'에서 경기를 골라 하세요.")
    if due and room <= 0:
        log(f"오늘 분석 한도({auto.get('max_analyses_per_day', 10)}경기)에 닿아 {len(due)}경기는 다음 실행으로 넘깁니다.")
    client = None
    for p in due[: max(room, 0)]:
        try:
            if client is None:
                client = client_factory() if client_factory else _default_client(company)
            m = Match.load(p)
            run = analyze(company, m, client, ledger)
            md, _ = save_run(run, company.base_dir / "reports")
            ledger.record(m, run.decision, run.initial + run.final, mock="모의" in run.engine, report_path=str(md))
            summary["analyzed"].append(m.id)
            log(f"분석 완료: {m.kickoff} {m.title}")
        except Exception as e:
            summary["errors"].append(f"분석 {p.stem}: {e}")
            if client is None:  # 키가 없는 등 분석 자체가 불가능하면 멈춤
                break

    # 3-2) 나중에 합류한 분석가: 이미 분석된 가까운 경기에 그 사람 의견만 더한다 (팀 결론은 그대로)
    try:
        summary["joined"] = catch_up_members(company, ledger, now, client_factory, log=log)
    except Exception as e:
        summary["errors"].append(f"합류 분석: {e}")

    # 4) AI 가상 배팅: 끝난 배팅 정산 → 비어 있는 배팅표 자리(최대 3장, 장마다 2~5경기) 새로 걸기
    try:
        from .betting import run_betting

        summary["betting"] = run_betting(company, ledger, now, log=log)
    except Exception as e:
        summary["errors"].append(f"배팅: {e}")

    log_path = company.base_dir / "data" / "daily_log.jsonl"
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    log(f"자동 실행 끝: 채점 {summary['settled']} · 수집 {summary['collected']} · 분석 {len(summary['analyzed'])}"
        + (f" · 오류 {len(summary['errors'])}" if summary["errors"] else ""))
    for e in summary["errors"]:
        log(f"  오류: {e}")
    return summary


def _default_client(company: Company):
    from .llm import ClaudeClient

    return ClaudeClient(model=company.model)


def next_run(now: datetime, times: list[str]) -> datetime:
    now = now.astimezone(KST)
    cands = []
    for t in times:
        h, m = (int(x) for x in t.split(":"))
        c = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if c <= now:
            c += timedelta(days=1)
        cands.append(c)
    return min(cands)


def worker(company: Company, log=print) -> None:  # pragma: no cover - 무한 루프
    times = company.automation.get("run_at", ["10:00", "22:00"])
    log(f"자동 실행 대기 중. 실행 시각(한국): {', '.join(times)}")
    if os.environ.get("AA_RUN_ON_START") == "1":
        run_daily(company, log=log)
    while True:
        nxt = next_run(datetime.now(KST), times)
        log(f"다음 실행: {nxt.strftime('%Y-%m-%d %H:%M KST')}")
        while (wait := (nxt - datetime.now(KST)).total_seconds()) > 0:
            time.sleep(min(wait, 300))
        try:
            run_daily(company, log=log)
        except Exception as e:
            log(f"자동 실행 실패: {e}")
