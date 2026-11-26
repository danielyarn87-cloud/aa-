"""정적 사이트 내보내기: Cloudflare Pages 같은 무료 정적 호스팅에 올릴 폴더를 만든다.

dist/site/
  index.html            화면 (읽기 전용 모드)
  static/               style.css, app.js
  manifest.webmanifest
  api/matches.json      경기 목록
  api/matches/<id>.json 경기 분석 전체
  api/company.json      조직도
  api/record.json       인사평가
  api/leagues.json      고를 수 있는 리그·기본 리그·API 사용량
  api/credit.json       Claude 크레딧 추정 잔액
  api/news.json         경기에 영향 줄 뉴스 (aa/news.py)
  fortune/index.html    오늘의 운세 화면 (unse/static/index.html)
  fortune/data/<날짜>.json  AI 운세 (data/unse/, 최근 3일 ~ 앞으로 3일)
  lotto/index.html      로또 화면 (lotto/static/index.html), lotto/data/ 당첨번호·띠별 한마디
그리고 저장소 맨 위의 functions/ 폴더(Cloudflare Pages 함수)가 /api/run 을 맡는다: 사이트에서 '분석 요청'을
누르면 GitHub Actions 를 실행시킨다.
같은 JSON 파일을 나중에 모바일 앱이 그대로 읽을 수 있다.

사용법: python tools/export_static.py [출력 폴더]
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aa.config import load_company  # noqa: E402
from aa.web.app import create_app  # noqa: E402


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def export_fortune(out: Path, src: Path = ROOT / "data" / "unse", today=None) -> None:
    """오늘의 운세: 화면 한 장과 날짜별 AI 운세 JSON. AI 운세가 없는 날은 화면이 기본 문장으로 보여 준다."""
    import datetime as dt
    from zoneinfo import ZoneInfo

    page = ROOT / "unse" / "static" / "index.html"
    if not page.exists():
        return
    (out / "fortune").mkdir(parents=True, exist_ok=True)
    shutil.copy(page, out / "fortune" / "index.html")
    today = today or dt.datetime.now(ZoneInfo("Asia/Seoul")).date()
    keep = {(today + dt.timedelta(days=n)).isoformat() for n in range(-3, 4)}
    for p in sorted(src.glob("????-??-??.json")) if src.exists() else []:
        if p.stem in keep:
            (out / "fortune" / "data").mkdir(parents=True, exist_ok=True)
            shutil.copy(p, out / "fortune" / "data" / p.name)


def export_lotto(out: Path, src: Path = ROOT / "data" / "lotto") -> None:
    """로또: 화면 한 장(lotto/static/index.html)과 당첨번호·띠별 한마디 JSON → /lotto/ (raise-lotto.com 첫 화면)."""
    page = ROOT / "lotto" / "static" / "index.html"
    if not page.exists():
        return
    (out / "lotto" / "data").mkdir(parents=True, exist_ok=True)
    shutil.copy(page, out / "lotto" / "index.html")
    for name in ("draws.json", "texts.json"):
        if (src / name).exists():
            shutil.copy(src / name, out / "lotto" / "data" / name)


def build_picks(matches: list, details: dict) -> dict:
    """회원용 '분석가 픽': 분석가마다 한 경기씩 채점한 적중률(승무패·언오버·고른 결과별)과
    시장 1순위(배당이 가장 낮은 쪽)를 고른 비율, 그리고 다가오는 경기의 분석가별 최종 선택. 돈·배당 숫자는 넣지 않는다."""
    stats, names, upcoming = {}, {}, []
    for m in matches:
        d = details.get(m["id"])
        if not d:
            continue
        res = m.get("result") or {}
        out = None
        try:
            hs, aw = (int(x) for x in str(res.get("score", "")).split("-"))
            out = "home" if hs > aw else "away" if aw > hs else "draw"
        except ValueError:
            pass
        o = m.get("odds") or {}
        fav = min(("home", "draw", "away"), key=lambda k: o.get(k) or 99) if o.get("home") else None
        for x in d.get("final") or []:
            mid = x["member_id"]
            names[mid] = x.get("member_name", mid)
            s = stats.setdefault(mid, {"n": 0, "hit": 0, "ou": 0, "fav": 0, "fav_n": 0,
                                       "pick": {"home": 0, "draw": 0, "away": 0}, "pick_hit": {"home": 0, "draw": 0, "away": 0}})
            p1 = x.get("pick_1x2")
            if fav and p1:
                s["fav_n"] += 1
                s["fav"] += p1 == fav
            if out and p1 in s["pick"]:
                s["n"] += 1
                s["hit"] += p1 == out
                s["pick"][p1] += 1
                s["pick_hit"][p1] += p1 == out
                try:
                    s["ou"] += (x.get("pick_ou") == "over") == (hs + aw > float(m.get("line") or 2.5))
                except (TypeError, ValueError):
                    pass
        if not res:
            upcoming.append({"id": m["id"], "home": m["home"], "away": m["away"], "league": m["league"],
                             "kickoff": m["kickoff"], "kickoff_iso": m.get("kickoff_iso"), "line": m.get("line"),
                             "picks": {x["member_id"]: {"p": x.get("pick_1x2"), "ou": x.get("pick_ou")} for x in d.get("final") or []}})
    upcoming.sort(key=lambda u: u.get("kickoff_iso") or u["kickoff"])
    return {"members": [{"id": k, "name": names[k], **v} for k, v in stats.items()], "upcoming": upcoming}


def export(out: Path, company_path: Path = ROOT / "company.yaml") -> Path:
    company = load_company(company_path)
    c = create_app(company).test_client()
    if out.exists():
        shutil.rmtree(out)
    static = ROOT / "aa" / "web" / "static"
    shutil.copytree(static, out / "static", ignore=shutil.ignore_patterns("index.html"))
    shutil.copy(static / "manifest.webmanifest", out / "manifest.webmanifest")

    matches = c.get("/api/matches").get_json()
    _write(out / "api" / "matches.json", matches)
    details = {}
    for m in matches["matches"]:
        if m["status"] == "analyzed":
            details[m["id"]] = c.get(f"/api/matches/{m['id']}").get_json()
            _write(out / "api" / "matches" / f"{m['id']}.json", details[m["id"]])
    _write(out / "api" / "picks.json", build_picks(matches["matches"], details))
    _write(out / "api" / "company.json", c.get("/api/company").get_json())
    _write(out / "api" / "record.json", c.get("/api/record").get_json())
    _write(out / "api" / "leagues.json", c.get("/api/leagues").get_json())
    _write(out / "api" / "bets.json", c.get("/api/bets").get_json())
    _write(out / "api" / "credit.json", c.get("/api/credit").get_json())
    _write(out / "api" / "news.json", c.get("/api/news").get_json())

    html = (static / "index.html").read_text(encoding="utf-8")
    # 화면 파일이 바뀌면 주소도 바뀌게 해서 브라우저가 옛 화면을 쓰지 않게 함
    import hashlib
    ver = hashlib.sha1((static / "app.js").read_bytes() + (static / "style.css").read_bytes()).hexdigest()[:10]
    html = html.replace('/static/style.css"', f'/static/style.css?v={ver}"')
    html = html.replace('<script src="/static/app.js"></script>', f'<script>window.AA_STATIC=true;</script>\n<script src="/static/app.js?v={ver}"></script>')
    (out / "index.html").write_text(html, encoding="utf-8")
    export_fortune(out)
    export_lotto(out)
    # 없는 주소는 404 로. (404.html 이 없으면 Cloudflare 가 아무 주소에나 첫 화면을 보여 주는데,
    #  그러면 운세·로또 도메인에서 RAISE 화면이 보일 수 있다 → functions/_middleware.js 참고)
    (out / "404.html").write_text('<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" '
                                  'content="width=device-width,initial-scale=1"><title>페이지를 찾을 수 없어요</title></head>'
                                  '<body style="font-family:system-ui,sans-serif;text-align:center;padding:60px 20px;color:#444">'
                                  '<h1 style="font-size:20px">페이지를 찾을 수 없어요</h1><p><a href="/">첫 화면으로</a></p></body></html>',
                                  encoding="utf-8")
    # Cloudflare Pages: JSON 은 늘 새로 받도록
    (out / "_headers").write_text("/api/*\n  Cache-Control: no-cache\n/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/static/*\n  Cache-Control: no-cache\n/fortune/*\n  Cache-Control: no-cache\n/lotto/*\n  Cache-Control: no-cache\n", encoding="utf-8")
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "site"
    print(export(target))
