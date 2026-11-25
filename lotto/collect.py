"""동행복권 회차별 당첨번호를 받아 data/lotto/draws.json 에 쌓는다.

- 매주 토요일 추첨(20:35) 뒤에 GitHub Actions 가 돌린다 (python -m lotto).
- 처음 돌리면 1회부터 지금까지 전부, 그다음부터는 새 회차만 받는다.
- 공개 조회 주소(getLottoNumber)는 1등 정보까지만 준다. 2~5등 당첨금은 화면에서 숨겨진다.
- 받지 못하면(사이트 점검·차단 등) 있던 기록은 그대로 두고 다음 실행에서 다시 시도한다.
"""
from __future__ import annotations

import json
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

URL = "https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo={no}"
KST = timezone(timedelta(hours=9))
MAX_PER_RUN = 1500


def _get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (RAISE lotto bot)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse(raw: bytes) -> dict | None:
    """동행복권 답 → 우리 형식. 없는 회차('fail')나 JSON 이 아닌 답이면 None."""
    try:
        j = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if j.get("returnValue") != "success":
        return None
    nums = sorted(int(j[f"drwtNo{i}"]) for i in range(1, 7))
    return {
        "no": int(j["drwNo"]), "date": j["drwNoDate"], "nums": nums, "bonus": int(j["bnusNo"]),
        "first_winners": int(j.get("firstPrzwnerCo") or 0), "first_prize": int(j.get("firstWinamnt") or 0),
        "sales": int(j.get("totSellamnt") or 0),
    }


def path(base: Path) -> Path:
    return Path(base) / "data" / "lotto" / "draws.json"


def run(base: Path, get=_get, pause: float = 0.15, log=print) -> dict:
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
            d = parse(get(URL.format(no=no)))
        except Exception as e:  # 네트워크 오류: 다음 실행에서 다시
            err = str(e)
            break
        if not d:  # 아직 추첨 안 한 회차 (또는 이상한 답)
            break
        have[d["no"]] = d
        added += 1
        no += 1
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
