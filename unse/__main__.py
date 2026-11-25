"""명령줄.

python -m unse daily            매일 한 번: 끝난 배치 수거 → 오늘~이틀 뒤 빈 칸 제출
python -m unse collect          끝난 배치만 수거
python -m unse submit 2026-11-27  그날 빈 칸 제출
python -m unse plan 2026-11-27  그날 등급·행운 값 보기 (API 안 씀)
python -m unse status           진행 중 배치와 날짜별 채움 상태
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging

from .ilgin import plan_day, today_kst
from .store import Store


def client():
    from .api import BatchClient  # ANTHROPIC_API_KEY 환경변수를 읽는다
    return BatchClient()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m unse")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("daily"); d.add_argument("--ahead", type=int, default=2)
    sub.add_parser("collect")
    s = sub.add_parser("submit"); s.add_argument("date")
    p = sub.add_parser("plan"); p.add_argument("date", nargs="?")
    sub.add_parser("status")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    store = Store()

    if a.cmd == "plan":
        day = dt.date.fromisoformat(a.date) if a.date else today_kst()
        print(json.dumps(plan_day(day), ensure_ascii=False, indent=1))
    elif a.cmd == "status":
        from .batch import missing
        st = store.state()
        print("진행 중 배치:", json.dumps(st["pending"], ensure_ascii=False))
        for n in range(-1, 3):
            day = today_kst() + dt.timedelta(days=n)
            print(day.isoformat(), f"빈 칸 {len(missing(store, day))}/24", f"시도 {st['attempts'].get(day.isoformat(), 0)}번")
    else:
        from . import batch
        c = client()
        if a.cmd == "daily":
            out = batch.daily(c, store, ahead=a.ahead)
        elif a.cmd == "collect":
            out = batch.collect(c, store)
        else:
            out = batch.submit(c, store, dt.date.fromisoformat(a.date))
        print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
