"""고른 리그(data/shorts.json)의 분석 끝난 예정 경기 쇼츠를 한꺼번에 만든다.

사용: python tools/make_shorts_batch.py <폴더>
- <폴더>에 지난번 쇼츠가 들어 있으면, 분석 내용이 그대로인 경기는 다시 만들지 않고 그대로 쓴다.
- 킥오프가 지난 경기 쇼츠는 지운다. 끝나면 <폴더>/index.json 에 목록을 쓴다.
- GitHub Actions(daily.yml)가 이 폴더를 'shorts' 브랜치로 올리고, 운영자 사이트 '쇼츠' 화면이 받아 간다.
"""
from __future__ import annotations

import datetime as dt
import glob
import hashlib
import json
import os
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import make_short  # noqa: E402

DESIGN = "v2"            # 영상 모양을 바꾸면 올린다 → 전부 다시 만들어짐
AHEAD_HOURS = 72         # 킥오프 3일 안의 경기만
KST = dt.timezone(dt.timedelta(hours=9))


def league_ids() -> dict[str, int]:
    c = yaml.safe_load(open(ROOT / "company.yaml", encoding="utf-8"))
    out = {}

    def walk(o):
        if isinstance(o, dict):
            if "name" in o and "api_football_id" in o:
                out[o["name"]] = o["api_football_id"]
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(c)
    return out


def league_of(name: str, ids: dict[str, int]) -> int | None:
    # 긴 이름부터 (예: 'AFC챔피언스리그 엘리트' 가 '챔피언스리그' 보다 먼저)
    for nm in sorted(ids, key=len, reverse=True):
        if name.startswith(nm):
            return ids[nm]
    return None


def kickoff_dt(k: str) -> dt.datetime | None:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})", k or "")
    if not m:
        return None
    y, mo, d, hh, mm = map(int, m.groups())
    return dt.datetime(y, mo, d, hh, mm, tzinfo=KST)


def digest(rep: dict) -> str:
    keep = {
        "d": DESIGN,
        "k": rep["match"].get("kickoff"),
        "dec": rep.get("decision"),
        "f": [{k: s.get(k) for k in ("member_name", "pick_1x2", "probs", "pick_ou", "over_prob", "summary", "key_reasons")} for s in rep.get("final", [])],
    }
    return hashlib.sha1(json.dumps(keep, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:10]


def _make(t) -> str:
    try:
        make_short.make(t[0], t[1])
        return ""
    except BaseException as e:   # 한 경기 실패가 나머지를 막지 않게
        return str(e)[:200]


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    cfg = json.load(open(ROOT / "data" / "shorts.json", encoding="utf-8"))
    want = set(int(x) for x in cfg.get("leagues", []))
    ids = league_ids()
    now = dt.datetime.now(KST)
    items, todo = [], []
    for f in sorted(glob.glob(str(ROOT / "reports" / "*.json"))):
        try:
            rep = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        m = rep.get("match") or {}
        if not str(m.get("id", "")).startswith("AF-") or not rep.get("final") or not rep.get("decision"):
            continue
        ko = kickoff_dt(m.get("kickoff", ""))
        if not ko or not (now < ko <= now + dt.timedelta(hours=AHEAD_HOURS)):
            continue
        lid = league_of(m.get("league", ""), ids)
        if lid not in want:
            continue
        name = f"{m['id']}-{digest(rep)}.mp4"
        path = out / name
        if os.environ.get("DRY"):
            print("대상", m["id"], m.get("league", "")[:12], m.get("home"), "vs", m.get("away"))
            continue
        todo.append((f, str(path), f"{m.get('home')} vs {m.get('away')}"))
        items.append({
            "id": m["id"], "file": name, "home": m.get("home"), "away": m.get("away"),
            "league": make_short.league_label(m.get("league", "")), "league_id": lid,
            "kickoff": m.get("kickoff"),
        })
    if os.environ.get("LIMIT"):   # 시험용
        n = int(os.environ["LIMIT"])
        todo, items = todo[:n], items[:n]
    new = [t for t in todo if not os.path.exists(t[1])]
    print(f"대상 {len(todo)}경기, 새로 만들 것 {len(new)}개", flush=True)
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 2))) as ex:
        for (src, dst, label), err in zip(new, ex.map(_make, new)):
            print(("실패 " + err if err else "완료") + " · " + label, flush=True)
    ok = []
    for it in items:   # 만들기에 실패한 경기는 목록에서 뺀다
        p = out / it["file"]
        if p.exists():
            it["bytes"] = p.stat().st_size
            ok.append(it)
    items = ok
    keep = {it["file"] for it in items}
    for p in out.glob("*.mp4"):
        if p.name not in keep:
            p.unlink()
    items.sort(key=lambda x: x["kickoff"])
    (out / "index.json").write_text(json.dumps({
        "made_at": now.strftime("%Y-%m-%d %H:%M KST"), "leagues": sorted(want), "items": items,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"쇼츠 {len(items)}개 (고른 리그 {len(want)}개)")


if __name__ == "__main__":
    main()
