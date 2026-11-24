"""서버 없이 열리는 한 장짜리 미리보기 HTML 을 만든다 (화면 공유·검토용).

현재 분석 결과를 API 와 같은 형태의 스냅샷으로 담아 넣는다.
사용법: python tools/build_preview.py [추가 경기 JSON] → dist/preview.html
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aa.config import load_company  # noqa: E402
from aa.web.app import create_app  # noqa: E402


def main(extra: list[str]) -> Path:
    company = load_company(ROOT / "company.yaml")
    c = create_app(company).test_client()
    matches = c.get("/api/matches").get_json()
    for path in extra:  # 분석 대기로 보여 줄 실제 일정
        matches["matches"].extend(json.loads(Path(path).read_text(encoding="utf-8")))
    matches["matches"].sort(key=lambda m: m["kickoff"])
    details = {m["id"]: c.get(f"/api/matches/{m['id']}").get_json() for m in matches["matches"] if m["status"] == "analyzed"}
    snap = {"matches": matches, "details": details, "company": c.get("/api/company").get_json(), "record": c.get("/api/record").get_json()}

    static = ROOT / "aa" / "web" / "static"
    html = (static / "index.html").read_text(encoding="utf-8")
    css = (static / "style.css").read_text(encoding="utf-8")
    js = (static / "app.js").read_text(encoding="utf-8")
    data = json.dumps(snap, ensure_ascii=False).replace("</", "<\\/")
    html = html.replace('<link rel="manifest" href="/manifest.webmanifest">\n', "")
    html = html.replace('<link rel="stylesheet" href="/static/style.css">', f"<style>\n{css}</style>")
    html = html.replace('<script src="/static/app.js"></script>', f"<script>window.AA_SNAPSHOT={data};</script>\n<script>\n{js}</script>")
    out = ROOT / "dist" / "preview.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    print(main(sys.argv[1:]))
