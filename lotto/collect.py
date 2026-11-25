"""동행복권 회차별 당첨번호를 받아 data/lotto/draws.json 에 쌓는다.

- 매주 토요일 추첨(20:35) 뒤에 GitHub Actions 가 돌린다 (python -m lotto).
- 처음 돌리면 1회부터 지금까지 전부, 그다음부터는 새 회차만 받는다.
- 동행복권 사이트 개편(2026)으로 예전 조회 주소(getLottoNumber)가 첫 화면으로 넘어가서,
  지금 '추첨결과' 화면이 쓰는 주소(selectPstLt645InfoNew.do)를 쓴다. 1~5등 당첨금·구매 방식까지 들어 있다.
- 한 번 물으면 기준 회차 주변 여러 회차를 함께 주므로, 0.5초씩 쉬며 적은 횟수로 받는다.
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


def run(base: Path, get=_get, pause: float = 0.5, log=print) -> dict:
    p = path(base)
    try:
        db = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        db = {"source": "동행복권 (dhlottery.co.kr)", "draws": []}
    have = {d["no"]: d for d in db.get("draws", [])}
    no = max(have, default=0) + 1
    added, err = 0, None
    for _ in range(MAX_PER_RUN):
        try:
            got = parse(get(URL.format(no=no)))
        except Exception as e:  # 네트워크 오류: 다음 실행에서 다시
            err = str(e)
            break
        new = [d for d in got if d["no"] not in have]
        for d in new:
            have[d["no"]] = d
        added += len(new)
        later = [d["no"] for d in got if d["no"] >= no]
        if not later:  # 아직 추첨 안 한 회차 (또는 이상한 답)
            break
        no = max(later) + 1
        if pause:
            time.sleep(pause)
    log(f"로또: 새 회차 {added}개 (마지막 {max(have, default=0)}회)" + (f" · 오류: {err}" if err else ""))
    if added:
        db["draws"] = [have[k] for k in sorted(have)]
        db["updated"] = datetime.now(KST).isoformat(timespec="seconds")
        db["source"] = "동행복권 (dhlottery.co.kr)"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"added": added, "last": max(have, default=0), "error": err}
