"""네이버 데이터랩 검색어 트렌드로 팀 이름의 최근 검색량을 잰다 (쇼츠 추천 순위용).

- API: POST https://openapi.naver.com/v1/datalab/search (무료, 하루 1,000번)
  키: GitHub 저장소 Secrets 의 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (네이버 개발자센터에서 사장님이 발급).
  키가 없으면 아무것도 하지 않는다 (추천 순위는 점수표만으로).
- 데이터랩은 한 번 물을 때 넣은 검색어끼리의 '상대값'(가장 많은 것 = 100)만 준다.
  그래서 매번 기준 검색어 ANCHOR 를 같이 넣고, 팀 값 ÷ 기준 값 으로 바꿔 서로 비교할 수 있게 한다.
- 결과는 <폴더>/naver.json 에 하루 동안 보관해 같은 팀을 다시 묻지 않는다.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import urllib.request
from pathlib import Path

URL = "https://openapi.naver.com/v1/datalab/search"
ANCHOR = "토트넘"          # 늘 검색이 꾸준한 기준 (손흥민 이적 뒤에도 국내 검색 많음)
PER_CALL = 4               # 한 번에 5묶음까지: 기준 1 + 팀 4
KEEP_H = 20                # 이 시간 안에 잰 팀은 다시 안 물음
KST = dt.timezone(dt.timedelta(hours=9))


def keywords(team: str) -> list[str]:
    """검색어 묶음: 팀 이름 그대로 + 띄어쓰기 없는 것. ('FC 서울'에서 FC를 떼면 도시 이름 '서울' 검색량이 섞여서 떼지 않는다)"""
    out = [team]
    ns = team.replace(" ", "")
    if ns != team:
        out.append(ns)
    return out


def _ask(groups: list[str], cid: str, secret: str, start: str, end: str) -> dict[str, float]:
    body = {"startDate": start, "endDate": end, "timeUnit": "date",
            "keywordGroups": [{"groupName": g, "keywords": keywords(g)} for g in groups]}
    req = urllib.request.Request(URL, data=json.dumps(body, ensure_ascii=False).encode(), method="POST",
                                 headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": secret,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        res = json.load(r)["results"]
    return {x["title"]: (sum(d["ratio"] for d in x["data"]) / max(1, len(x["data"]))) for x in res}


def measure(teams: list[str], folder: Path, log=print) -> dict[str, float]:
    """팀 이름 → 최근 7일 검색량 (기준 '토트넘' = 1.0). 키가 없거나 실패하면 지난 값만."""
    path = folder / "naver.json"
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    vals: dict = cache.get("teams", {})
    cid, secret = os.environ.get("NAVER_CLIENT_ID", ""), os.environ.get("NAVER_CLIENT_SECRET", "")
    now = dt.datetime.now(KST)
    fresh = lambda t: t in vals and now - dt.datetime.fromisoformat(vals[t]["at"]) < dt.timedelta(hours=KEEP_H)
    todo = [t for t in dict.fromkeys(teams) if t and t != ANCHOR and not fresh(t)]
    if cid and secret and todo:
        end = (now - dt.timedelta(days=1)).date()
        start = end - dt.timedelta(days=6)
        asked = 0
        for i in range(0, len(todo), PER_CALL):
            part = todo[i:i + PER_CALL]
            try:
                got = _ask([ANCHOR, *part], cid, secret, start.isoformat(), end.isoformat())
            except Exception as e:      # 한도·네트워크 문제: 남은 팀은 다음에
                log(f"네이버 검색량: {e} (남은 {len(todo) - i}팀은 다음에)")
                break
            base = got.get(ANCHOR) or 0
            for t in part:
                v = round((got.get(t, 0) / base), 3) if base else 0.0
                vals[t] = {"v": v, "at": now.isoformat(timespec="minutes")}
            asked += 1
        log(f"네이버 검색량: {asked}번 물어 {min(len(todo), asked * PER_CALL)}팀 갱신")
    elif not (cid and secret):
        log("네이버 검색량: 키 없음 (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET) → 건너뜀")
    vals = {t: x for t, x in vals.items() if now - dt.datetime.fromisoformat(x["at"]) < dt.timedelta(days=7)}
    path.write_text(json.dumps({"anchor": ANCHOR, "teams": vals}, ensure_ascii=False, indent=1), encoding="utf-8")
    return {t: x["v"] for t, x in vals.items()}
