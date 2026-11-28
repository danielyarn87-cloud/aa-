"""우리 유튜브 채널(RAISE Fulltime) 쇼츠의 조회수를 모아 리그별·팀별 평균을 낸다 (쇼츠 추천 순위용, 무료).

- 채널 공개 RSS(최근 15개, 조회수 포함)를 읽는다. 로그인·키 없음.
- RSS 에서 빠진 예전 영상도 <폴더>/yt_stats.json 에 마지막 조회수로 남겨 둔다 (쌓일수록 정확해짐).
- 영상 제목의 '홈 vs 원정'으로 분석 보고서를 찾아 리그를 붙인다.
- 올린 지 24시간이 안 된 영상은 평균에 넣지 않는다 (조회수가 아직 덜 쌓임).
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

CHANNEL = "UCV7HEKoes_TA6RzeXGvghpQ"
FEED = f"https://www.youtube.com/feeds/videos.xml?channel_id={CHANNEL}"
NS = {"a": "http://www.w3.org/2005/Atom", "media": "http://search.yahoo.com/mrss/", "yt": "http://www.youtube.com/xml/schemas/2015"}
MIN_AGE_H = 24
norm = lambda t: re.sub(r"[\s·.\-_|]", "", str(t or "")).lower()


def _feed() -> list[dict]:
    req = urllib.request.Request(FEED, headers={"User-Agent": "Mozilla/5.0 (RAISE shorts stats)"})
    with urllib.request.urlopen(req, timeout=20) as r:
        root = ET.fromstring(r.read())
    out = []
    for e in root.findall("a:entry", NS):
        st = e.find("media:group/media:community/media:statistics", NS)
        out.append({"id": e.findtext("yt:videoId", default="", namespaces=NS),
                    "title": e.findtext("a:title", default="", namespaces=NS),
                    "published": e.findtext("a:published", default="", namespaces=NS),
                    "views": int(st.get("views", 0)) if st is not None else 0})
    return [x for x in out if x["id"]]


def _matches(root: Path) -> list[tuple[str, str, str, str]]:
    """(정규화한 '홈vs원정', 리그, 홈, 원정) — 분석 보고서 전체에서."""
    import make_short

    rows = []
    for f in glob.glob(str(root / "reports" / "*.json")):
        try:
            m = json.load(open(f, encoding="utf-8"))["match"]
        except Exception:
            continue
        rows.append((norm(m["home"] + "vs" + m["away"]), make_short.league_label(m.get("league", "")), m["home"], m["away"]))
    return rows


def collect(folder: Path, root: Path, log=print) -> dict:
    """yt_stats.json 을 갱신하고 {"overall", "leagues": {리그: [평균, 개수]}, "teams": {...}} 를 돌려준다."""
    path = folder / "yt_stats.json"
    try:
        vids = json.loads(path.read_text(encoding="utf-8")).get("videos", {})
    except (OSError, ValueError):
        vids = {}
    try:
        feed = _feed()
    except Exception as e:
        log(f"유튜브 조회수: 채널 목록을 못 읽음 ({e}) → 지난 기록만")
        feed = []
    rows = _matches(root)
    for v in feed:
        key = norm(v["title"])
        hit = next((r for r in rows if r[0] and r[0] in key), None)
        old = vids.get(v["id"], {})
        vids[v["id"]] = {**old, "title": v["title"], "published": v["published"], "views": max(v["views"], old.get("views", 0)),
                         **({"league": hit[1], "home": hit[2], "away": hit[3]} if hit else {})}
    path.write_text(json.dumps({"channel": CHANNEL, "videos": vids}, ensure_ascii=False, indent=1), encoding="utf-8")

    now = dt.datetime.now(dt.timezone.utc)
    ready = [v for v in vids.values() if v.get("league") and v.get("published")
             and now - dt.datetime.fromisoformat(v["published"]) >= dt.timedelta(hours=MIN_AGE_H)]
    if not ready:
        log(f"유튜브 조회수: 영상 {len(vids)}개 기록 (24시간 지난 것 없음)")
        return {}
    overall = sum(v["views"] for v in ready) / len(ready)
    acc: dict[str, dict[str, list]] = {"leagues": {}, "teams": {}}
    for v in ready:
        acc["leagues"].setdefault(v["league"], []).append(v["views"])
        for t in (v["home"], v["away"]):
            acc["teams"].setdefault(t, []).append(v["views"])
    out = {"overall": round(overall, 1), "videos": len(ready),
           **{k: {n: [round(sum(x) / len(x), 1), len(x)] for n, x in d.items()} for k, d in acc.items()}}
    log(f"유튜브 조회수: 영상 {len(ready)}개 평균 {overall:.0f}회, 리그 {len(out['leagues'])}개")
    return out
