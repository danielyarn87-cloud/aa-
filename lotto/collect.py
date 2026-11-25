"""동행복권 회차별 당첨번호를 받아 data/lotto/draws.json 에 쌓는다.

- 매주 토요일 추첨(20:35) 뒤에 GitHub Actions 가 돌린다 (python -m lotto).
- 최신 회차부터 받고, 빠진 옛 회차는 위에서 아래로 여러 번에 나눠 채운다. 그다음부터는 새 회차만.
- 동행복권 사이트 개편(2026)으로 예전 조회 주소(getLottoNumber)가 첫 화면으로 넘어가서,
  지금 '추첨결과' 화면이 쓰는 주소(selectPstLt645InfoNew.do)를 쓴다. 1~5등 당첨금·구매 방식까지 들어 있다.
- 한 번 물으면 기준 회차 주변 여러 회차를 함께 주므로, 1초씩 쉬며 적은 횟수로 받는다.
- 받지 못하면(사이트 점검·차단 등) 있던 기록은 그대로 두고 다음 실행에서 다시 시도한다.
"""
from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

URL = "https://www.dhlottery.co.kr/lt645/selectPstLt645InfoNew.do?srchDir=center&srchLtEpsd={no}"
KST = timezone(timedelta(hours=9))
MAX_PER_RUN = 1500   # 묻는 횟수 한도 (한 번에 여러 회차가 와서 실제로는 훨씬 적게 묻는다)


def _get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (RAISE lotto bot)",
                                               "Referer": "https://www.dhlottery.co.kr/lt645/result",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _one(x: dict) -> dict:
    ymd = str(x["ltRflYmd"])
    return {
        "no": int(x["ltEpsd"]), "date": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}",
        "nums": sorted(int(x[f"tm{i}WnNo"]) for i in range(1, 7)), "bonus": int(x["bnsWnNo"]),
        "first_winners": int(x.get("rnk1WnNope") or 0), "first_prize": int(x.get("rnk1WnAmt") or 0),
        "ranks": [[int(x.get(f"rnk{r}WnNope") or 0), int(x.get(f"rnk{r}WnAmt") or 0)] for r in range(1, 6)],
        "first_type": {"auto": int(x.get("winType1") or 0), "manual": int(x.get("winType2") or 0),
                       "semi": int(x.get("winType3") or 0)},
        "sales": int(x.get("wholEpsdSumNtslAmt") or 0),
    }


def parse(raw: bytes) -> list[dict]:
    """동행복권 답 → 우리 형식 목록 (기준 회차 주변 여러 회차). JSON 이 아니거나 비어 있으면 []."""
    try:
        j = json.loads(raw.decode("utf-8"))
        items = (j.get("data") or {}).get("list") or []
        return [_one(x) for x in items if x.get("ltEpsd") and x.get("tm6WnNo")]
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, KeyError, TypeError, ValueError):
        return []


def path(base: Path) -> Path:
    return Path(base) / "data" / "lotto" / "draws.json"


FIRST_DRAW = datetime(2002, 12, 7, 21, 0, tzinfo=KST)   # 1회 추첨 (결과가 올라오는 21시 기준)


def expected_latest(now: datetime | None = None) -> int:
    """지금까지 추첨했을 마지막 회차 (매주 토요일). 동행복권에 아직 안 올라왔으면 그 앞 회차까지만 온다."""
    now = now or datetime.now(KST)
    return max(1, (now - FIRST_DRAW) // timedelta(days=7) + 1)


def run(base: Path, get=_get, pause: float = 1.0, log=print, now: datetime | None = None) -> dict:
    """최신 회차부터 받는다: ① 새 회차(위로) ② 빠진 옛 회차(위에서 아래로).
    그래서 채우는 중에도 첫 화면의 '이번 회차'는 늘 최신이다."""
    p = path(base)
    try:
        db = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        db = {"source": "동행복권 (dhlottery.co.kr)", "draws": []}
    have = {d["no"]: d for d in db.get("draws", [])}
    before = max(have, default=0)
    added, err, asked = 0, None, 0

    def ask(no: int):
        """기준 회차 주변을 받아 쌓는다. 계속 안 되면 None."""
        nonlocal added, err, asked
        got = None
        for attempt in range(4):  # 느려지거나 끊기면 잠깐 쉬었다가 다시 (10초·20초·40초)
            try:
                got = parse(get(URL.format(no=no)))
                err = None
                break
            except Exception as e:
                err = str(e)
                if pause:
                    time.sleep(10 * 2 ** attempt)
        asked += 1
        if got is not None:
            for d in got:
                if d["no"] not in have:
                    have[d["no"]] = d
                    added += 1
        if pause:
            time.sleep(pause)
        return got

    # ① 새 회차: 계산상 최신 회차부터 위로
    no = max(expected_latest(now), before + 1)
    while asked < MAX_PER_RUN:
        got = ask(no)
        if got is None:
            break
        later = [d["no"] for d in got if d["no"] >= no]
        if not later:  # 아직 추첨 안 한 회차
            break
        no = max(later) + 1
    top = max(have, default=0)
    # ② 빠진 옛 회차: 위에서 아래로
    while err is None and asked < MAX_PER_RUN:
        missing = [n for n in range(top, 0, -1) if n not in have]
        if not missing:
            break
        n = missing[0]
        if ask(n) is None or n not in have:  # 안 오면 다음 실행에서 다시
            break
    left = sum(1 for n in range(1, max(have, default=0) + 1) if n not in have)
    last = max(have, default=0)
    log(f"로또: 새 회차 {added}개 (마지막 {last}회, 빠진 회차 {left}개)" + (f" · 오류: {err}" if err else ""))
    if added:
        db["draws"] = [have[k] for k in sorted(have)]
        db["updated"] = datetime.now(KST).isoformat(timespec="seconds")
        db["source"] = "동행복권 (dhlottery.co.kr)"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # 사이트 다시 만들기(월 500회 한도)는 최신 회차가 바뀌었거나 다 채웠을 때만
    return {"added": added, "last": last, "left": left, "error": err,
            "deploy": bool(added) and (last > before or left == 0)}
