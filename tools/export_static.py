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
    for m in matches["matches"]:
        if m["status"] == "analyzed":
            _write(out / "api" / "matches" / f"{m['id']}.json", c.get(f"/api/matches/{m['id']}").get_json())
    _write(out / "api" / "company.json", c.get("/api/company").get_json())
    _write(out / "api" / "record.json", c.get("/api/record").get_json())
    _write(out / "api" / "leagues.json", c.get("/api/leagues").get_json())
    _write(out / "api" / "bets.json", c.get("/api/bets").get_json())
    _write(out / "api" / "credit.json", c.get("/api/credit").get_json())

    html = (static / "index.html").read_text(encoding="utf-8")
    # 화면 파일이 바뀌면 주소도 바뀌게 해서 브라우저가 옛 화면을 쓰지 않게 함
    import hashlib
    ver = hashlib.sha1((static / "app.js").read_bytes() + (static / "style.css").read_bytes()).hexdigest()[:10]
    html = html.replace('/static/style.css"', f'/static/style.css?v={ver}"')
    html = html.replace('<script src="/static/app.js"></script>', f'<script>window.AA_STATIC=true;</script>\n<script src="/static/app.js?v={ver}"></script>')
    (out / "index.html").write_text(html, encoding="utf-8")
    # Cloudflare Pages: JSON 은 늘 새로 받도록
    (out / "_headers").write_text("/api/*\n  Cache-Control: no-cache\n/\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/static/*\n  Cache-Control: no-cache\n", encoding="utf-8")
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "site"
    print(export(target))
