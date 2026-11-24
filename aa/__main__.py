"""명령줄 사용법

  python -m aa roster                              조직도 보기
  python -m aa analyze data/sample_match.json      경기 분석 (Claude API, ANTHROPIC_API_KEY 필요)
  python -m aa analyze data/sample_match.json --mock   키 없이 모의 실행
  python -m aa settle SAMPLE-001 2-1               경기 결과 입력 (홈-원정 점수)
  python -m aa review                              인사평가 (분석가별 성적과 투표 비중)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import load_company
from .ledger import Ledger
from .llm import ClaudeClient, MockClient, ReplayClient
from .models import Match
from .pipeline import analyze
from .report import decision_text
from .store import save_run


def _pct(x):
    return "-" if x is None else f"{x:.1%}"


def cmd_roster(company, args) -> None:
    print(f"{company.name}  (기본 모델: {company.model})\n")
    for d in company.departments.values():
        state = "운영" if d.active else "준비 중"
        print(f"[{d.name}] 종목: {d.sport or '-'} · {state}")
        people = [m for m in company.members if m.department == d.id]
        if not people:
            print("  (인원 없음)")
        for m in people:
            flags = []
            if not m.active:
                flags.append("비활성")
            if m.votes:
                flags.append(f"투표 비중 {m.base_weight}")
            print(f"  - {m.name} · {m.title} · {m.role} {' · '.join(flags)}")
        print()


def cmd_analyze(company, args) -> None:
    match = Match.load(args.match)
    if args.replay:
        client = ReplayClient(args.replay)
    elif args.mock:
        client = MockClient()
    else:
        client = ClaudeClient(model=company.model)
    ledger = Ledger(company.base_dir / "data" / "ledger.sqlite")
    print(f"분석 시작: {match.title} · 엔진: {client.label}")
    run = analyze(company, match, client, ledger, dept_id=args.dept)
    path, _ = save_run(run, company.base_dir / "reports")
    ledger.record(match, run.decision, run.initial + run.final, mock=args.mock, report_path=str(path))
    print()
    print(decision_text(run.decision))
    print(f"\n리포트: {path}")


def cmd_settle(company, args) -> None:
    try:
        hg, ag = (int(x) for x in args.score.split("-"))
    except ValueError:
        sys.exit("점수는 홈-원정 형식으로 입력하세요. 예: 2-1")
    Ledger(company.base_dir / "data" / "ledger.sqlite").settle(args.match_id, hg, ag)
    print(f"{args.match_id} 결과 {hg}-{ag} 기록 완료")


def cmd_review(company, args) -> None:
    ledger = Ledger(company.base_dir / "data" / "ledger.sqlite")
    depts = [company.department(args.dept)] if args.dept else [d for d in company.departments.values() if d.active]
    for d in depts:
        print(f"[{d.name}] 인사평가{' (모의 실행 포함)' if args.include_mock else ''}")
        c = ledger.company_stats(d.id, include_mock=args.include_mock)
        print(
            f"  회사: 채점 {c['settled']}경기 · 승무패 픽 {c['picks_1x2']} (관망 {c['passes_1x2']}) · "
            f"적중률 {_pct(c['acc_1x2'])} · 가상 수익률 {_pct(c['roi_1x2'])} · 언더/오버 적중률 {_pct(c['acc_ou'])}"
        )
        weights = ledger.weights(company, d.id)
        stats = ledger.member_stats(d.id, include_mock=args.include_mock)
        if not stats:
            print("  아직 채점된 경기가 없습니다.")
        for s in stats:
            print(
                f"  - {s['name']}: {s['n']}경기 · 승무패 적중 {_pct(s['acc_1x2'])} · 브라이어 {s['brier_1x2']:.3f} · "
                f"언더/오버 적중 {_pct(s['acc_ou'])} · 가상 수익률 {_pct(s['roi_1x2'])} · 다음 투표 비중 {weights.get(s['member_id'], 1.0):.2f}"
            )
        print(f"  (투표 비중은 {company.policy.min_samples_for_weight}경기 이상 채점된 분석가부터 성적으로 조정됩니다)\n")


def cmd_collect(company, args) -> None:
    from .collect import collect

    leagues = [int(x) for x in args.league.split(",")] if args.league else None
    paths = collect(company, days=args.days, leagues=leagues, limit=args.limit, light=args.light, with_odds=not args.no_odds)
    print(f"\n경기 자료 {len(paths)}개를 data/matches/ 에 만들었습니다.")


def cmd_sync(company, args) -> None:
    from .collect import sync_results

    n = sync_results(company, Ledger(company.base_dir / "data" / "ledger.sqlite"))
    print(f"결과 {n}경기 자동 기록")


def cmd_daily(company, args) -> None:
    from .daily import run_daily
    from .llm import MockClient

    auto = company.automation
    if args.leagues:
        auto["leagues"] = [int(x) for x in args.leagues.split(",") if x.strip()]
    else:  # 사이트에서 저장한 기본 리그가 있으면 그것을 쓴다
        from .daily import default_leagues

        auto["leagues"] = default_leagues(company)
    if args.days:
        auto["collect_days"] = args.days
    if args.within:
        auto["analyze_within_hours"] = args.within
    if args.light:
        auto["light"] = True
    if args.max is not None:  # "이번에 최대 N경기": 오늘 이미 분석한 수에 더해 준다
        from datetime import datetime
        from zoneinfo import ZoneInfo

        from .daily import analyzed_today

        auto["max_analyses_per_day"] = analyzed_today(company, datetime.now(ZoneInfo("Asia/Seoul"))) + args.max
    run_daily(company, client_factory=(MockClient if args.mock else None))


def cmd_worker(company, args) -> None:
    from .daily import worker

    worker(company)


def cmd_serve(company, args) -> None:
    from .web.app import create_app

    app = create_app(company)
    print(f"AA 스포츠 분석 웹: http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="python -m aa", description="AA 스포츠 분석")
    p.add_argument("--company", default="company.yaml", help="조직도 파일 경로")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("roster", help="조직도 보기")

    a = sub.add_parser("analyze", help="경기 분석")
    a.add_argument("match", help="경기 자료 JSON 파일")
    a.add_argument("--mock", action="store_true", help="API 없이 모의 실행")
    a.add_argument("--replay", help="미리 받아 둔 분석가 답변 JSON 으로 실행")
    a.add_argument("--dept", help="분석할 부서 id (생략하면 종목으로 자동 선택)")

    s = sub.add_parser("settle", help="경기 결과 입력")
    s.add_argument("match_id")
    s.add_argument("score", help="홈-원정 점수, 예: 2-1")

    r = sub.add_parser("review", help="인사평가")
    r.add_argument("--dept")
    r.add_argument("--include-mock", action="store_true", help="모의 실행 기록도 채점에 포함")

    c = sub.add_parser("collect", help="API 로 예정 경기 자료 자동 수집")
    c.add_argument("--days", type=int, default=3, help="오늘부터 며칠 뒤까지 (기본 3)")
    c.add_argument("--league", help="API-Football 리그 번호, 쉼표로 여러 개 (예: 39,140)")
    c.add_argument("--limit", type=int, help="최대 경기 수")
    c.add_argument("--light", action="store_true", help="상대 전적·직전 경기 생략 (호출 절약)")
    c.add_argument("--no-odds", action="store_true", help="배당 수집 생략")

    sub.add_parser("sync", help="끝난 경기 결과를 API 로 자동 채점")

    dl = sub.add_parser("daily", help="자동 실행 한 번: 채점 → 수집 → 분석")
    dl.add_argument("--mock", action="store_true", help="분석을 모의 실행으로 (API 비용 없이 흐름 확인)")
    dl.add_argument("--leagues", help="이번만 다룰 리그 번호, 쉼표로 (예: 39,140)")
    dl.add_argument("--days", type=int, help="이번만: 며칠 뒤 경기까지 수집")
    dl.add_argument("--within", type=float, help="이번만: 킥오프 몇 시간 안의 경기를 분석")
    dl.add_argument("--max", type=int, help="이번 실행에서 분석할 최대 경기 수 (오늘 한도와 별도)")
    dl.add_argument("--light", action="store_true", help="호출 절약: 순위표만 쓰고 경기별 호출 생략")
    sub.add_parser("worker", help="정해진 시각마다 자동 실행 (서버 상시 구동용)")

    w = sub.add_parser("serve", help="웹사이트 실행")
    w.add_argument("--host", default="127.0.0.1")
    w.add_argument("--port", type=int, default=8000)

    args = p.parse_args(argv)
    company = load_company(Path(args.company))
    {"roster": cmd_roster, "analyze": cmd_analyze, "settle": cmd_settle, "review": cmd_review,
     "collect": cmd_collect, "sync": cmd_sync, "serve": cmd_serve,
     "daily": cmd_daily, "worker": cmd_worker}[args.cmd](company, args)


if __name__ == "__main__":
    main()
