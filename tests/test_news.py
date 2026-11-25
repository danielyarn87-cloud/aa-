import json
from datetime import datetime, timedelta, timezone

from aa import news

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 25, 16, 0, tzinfo=KST)

RSS = """<?xml version="1.0"?><rss><channel>
<item><title>Atlético Madrid striker ruled out for two weeks with hamstring injury - Marca</title>
<link>https://news.example/a1</link><pubDate>Wed, 25 Nov 2026 05:00:00 GMT</pubDate><source url="x">Marca</source></item>
<item><title>Burnley FC beat Stoke in thriller - BBC</title>
<link>https://news.example/a2</link><pubDate>Wed, 25 Nov 2026 04:00:00 GMT</pubDate><source url="x">BBC</source></item>
<item><title>Unrelated club news about someone else - Site</title>
<link>https://news.example/a3</link><pubDate>Wed, 25 Nov 2026 04:00:00 GMT</pubDate><source url="x">Site</source></item>
</channel></rss>"""


def _setup(tmp_path):
    md = tmp_path / "data" / "matches"
    md.mkdir(parents=True)
    m = {"id": "AF-1", "league_id": 2, "kickoff_iso": "2026-11-26T05:00:00+09:00",
         "home": "아틀레티코 마드리드", "away": "비킹", "home_en": "Atletico Madrid", "away_en": "Viking"}
    (md / "AF-1.json").write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    m2 = {"id": "AF-2", "league_id": 40, "kickoff_iso": "2026-11-26T04:45:00+09:00",
          "home": "번리", "away": "버밍엄", "home_en": "Burnley", "away_en": "Birmingham"}
    (md / "AF-2.json").write_text(json.dumps(m2, ensure_ascii=False), encoding="utf-8")
    m3 = {"id": "AF-9", "league_id": 2, "kickoff_iso": "2026-12-20T05:00:00+09:00",  # 너무 먼 경기: 검색 안 함
          "home": "먼팀", "away": "먼팀2", "home_en": "Far", "away_en": "Far2"}
    (md / "AF-9.json").write_text(json.dumps(m3, ensure_ascii=False), encoding="utf-8")


class FakeClient:
    def __init__(self):
        self.calls = 0

    def complete(self, system, prompt, ctx):
        self.calls += 1
        assert ctx["model"] == news.MODEL and "schema" in ctx
        lines = [l for l in prompt.splitlines() if l[:1].isdigit()]
        out = []
        for l in lines:
            i = int(l.split(".")[0])
            if "injury" in l:
                out.append({"i": i, "team": "Atletico Madrid", "category": "injury", "impact": "high",
                            "summary": "아틀레티코 주전 공격수 햄스트링 부상, 2주 결장 전망"})
        return json.dumps({"items": out})


def test_run_collects_classifies_and_links_matches(tmp_path):
    _setup(tmp_path)
    urls = []

    def get(url):
        urls.append(url)
        return RSS.encode()

    c = FakeClient()
    out = news.run(tmp_path, c, get=get, now=NOW, pause=0, log=lambda *a: None)
    assert urls and all("Far" not in u for u in urls)          # 먼 경기 팀은 검색하지 않음
    assert len(out["items"]) == 1
    x = out["items"][0]
    assert x["category"] == "injury" and x["impact"] == "high" and x["team"] == "아틀레티코 마드리드"
    assert x["match_ids"] == ["AF-1"] and x["source"] == "Marca" and "Marca" not in x["title"]
    # 'Unrelated' 기사는 팀 이름이 없어 Haiku 에 보내지도 않음, 번리 기사는 보냈지만 고르지 않음
    assert "https://news.example/a2" in out["seen"] and "https://news.example/a3" not in out["seen"]

    # 두 번째 실행: 이미 본 기사는 다시 묻지 않는다 (비용 0)
    c2 = FakeClient()
    news.run(tmp_path, c2, get=get, now=NOW + timedelta(hours=3), pause=0, log=lambda *a: None)
    assert c2.calls == 0

    # 분석가에게 줄 줄
    got = news.for_match(tmp_path, "AF-1", now=NOW)
    lines = news.brief_lines(got)
    assert lines and lines[0].startswith("[부상·결장 · 영향 큼] 아틀레티코 마드리드:")


def test_norm_and_short():
    assert news.norm("Atlético Madrid") == "atletico madrid"
    assert news.short("Burnley FC") == "burnley" and news.short("FC Seoul") == "fc seoul"
