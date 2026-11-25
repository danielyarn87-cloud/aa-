"""스포츠 뉴스: 경기에 영향을 줄 소식(감독·부상/결장·이적·징계)만 모은다.

흐름 (3시간마다 GitHub Actions, python -m aa news):
  1) 다가오는 경기(지금~3일 뒤)에 나오는 팀 이름으로 구글 뉴스 RSS 를 검색 (무료)
     - 국내 리그(K리그)는 한국어 팀 이름 + 한국어 뉴스, 나머지는 영어 팀 이름 + 영어 뉴스
     - 검색어에 부상·경질·이적·징계 같은 낱말을 붙여 관련 있는 제목만 받는다
  2) 제목에 팀 이름이 실제로 들어 있는 것만 남기고, 이미 본 기사는 건너뛴다 (비용 절약)
  3) Claude Haiku 가 감독·부상/결장·이적·징계에 해당하는 것만 골라 팀과 짝짓고,
     영향 정도(큼·보통·작음)와 한국어 한 줄 요약을 붙인다
  4) data/news.json 에 저장 (7일치). 화면의 뉴스 탭·경기 목록 표시·경기 상세와
     분석가에게 주는 자료(pipeline.analyze)가 이 파일을 읽는다.

기사 본문은 저장하지 않는다. 제목·출처·링크와 우리가 다시 쓴 한 줄 요약만 둔다.
비용: Haiku 로 제목만 읽으므로 한 달 약 700원~2천 원 (추정).
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

MODEL = "claude-haiku-5-5"
KST = timezone(timedelta(hours=9))
KO_LEAGUES = {292, 293}          # 한국어 뉴스로 찾을 리그 (K리그1·2)
KEEP_DAYS = 7                     # 이만큼 지난 뉴스는 지운다
SEEN_DAYS = 4                     # 관련 없다고 본 기사도 이 기간 동안은 다시 묻지 않는다
GROUP = 6                         # 검색 한 번에 넣는 팀 수
BATCH = 80                        # Haiku 한 번에 읽히는 제목 수

KW = {
    "en": '(injury OR injured OR sidelined OR ruled out OR sacked OR fired OR resigns OR "head coach" OR manager '
          'OR transfer OR signs OR suspended OR suspension OR "red card" OR ban)',
    "ko": '(부상 OR 결장 OR 경질 OR 사퇴 OR 감독 OR 이적 OR 영입 OR 징계 OR 출전정지 OR 퇴장)',
}
FEED = {
    "en": "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en",
    "ko": "https://news.google.com/rss/search?q={q}&hl=ko&gl=KR&ceid=KR:ko",
}
CATS = ["manager", "injury", "transfer", "suspension"]
CAT_KO = {"manager": "감독", "injury": "부상·결장", "transfer": "이적", "suspension": "징계"}
IMPACT_KO = {"high": "영향 큼", "mid": "영향 보통", "low": "영향 작음"}

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "i": {"type": "integer"},
                    "team": {"type": "string"},
                    "category": {"type": "string", "enum": CATS},
                    "impact": {"type": "string", "enum": ["high", "mid", "low"]},
                    "summary": {"type": "string"},
                },
                "required": ["i", "team", "category", "impact", "summary"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

SYSTEM = """너는 축구 경기 분석팀의 뉴스 담당이다. 뉴스 제목 목록을 받아, 다가오는 경기 결과에 영향을 줄 수 있는 소식만 고른다.
고를 것 (category):
- manager: 감독 경질·사퇴·선임·임시 감독
- injury: 선수 부상·결장·복귀·출전 불투명
- transfer: 실제로 일어난 영입·이적·방출 (단순 관심·루머는 고르지 않는다)
- suspension: 퇴장·경고 누적·징계로 인한 출전 정지
고르지 않을 것: 경기 결과·하이라이트·예상 기사, 단순 루머, 구단 경영·스폰서, 다른 종목, 목록의 팀과 관계없는 기사.
team 은 그 제목에 붙은 후보 팀 이름 중 하나를 글자 그대로 쓴다.
impact: high = 주전 핵심 선수 결장 확정, 감독 경질·사퇴 직후, 여러 명 결장 / mid = 주전급 불투명, 징계 1명, 복귀 소식 / low = 그 밖에 영향이 작은 것.
summary: 한국어 한 문장(50자 안팎). 제목에 있는 사실만 쓰고 추측하지 않는다. 제목을 그대로 번역하지 말고 핵심만 다시 쓴다.
같은 소식이 여러 제목에 나오면 가장 분명한 하나만 고른다. 해당하는 것이 없으면 items 를 빈 목록으로."""


# ---------------------------------------------------------------------------
# 팀 이름
# ---------------------------------------------------------------------------

def norm(s: str) -> str:
    """악센트·대소문자·문장부호를 없앤 비교용 이름 ('Atlético Madrid' → 'atletico madrid')."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^0-9a-z가-힣]+", " ", s).strip()


def short(name: str) -> str:
    """제목에서 찾을 이름: 뒤에 붙은 FC·CF 같은 꼬리표만 뗀다 ('Burnley FC' → 'burnley', 'FC Seoul' 은 그대로).
    너무 짧아지면 원래 이름을 쓴다."""
    n = norm(name)
    s = re.sub(r"\s+(fc|cf|sc|afc|ac)$", "", n)
    return s if len(s) >= 4 else n


def upcoming_teams(matches_dir: Path, now: datetime, hours: float = 72) -> dict[str, dict]:
    """지금(3시간 전)부터 hours 시간 안에 경기가 있는 팀: {검색 이름: {lang, ko, en, match_ids}}"""
    teams: dict[str, dict] = {}
    for p in sorted(Path(matches_dir).glob("*.json")):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
            k = datetime.fromisoformat(m["kickoff_iso"])
        except (OSError, ValueError, KeyError):
            continue
        if not (now - timedelta(hours=3) <= k <= now + timedelta(hours=hours)):
            continue
        lang = "ko" if m.get("league_id") in KO_LEAGUES else "en"
        for side in ("home", "away"):
            ko, en = m.get(side), m.get(f"{side}_en") or m.get(side)
            key = ko if lang == "ko" else en
            if not key:
                continue
            t = teams.setdefault(key, {"lang": lang, "ko": ko, "en": en, "match_ids": []})
            if m["id"] not in t["match_ids"]:
                t["match_ids"].append(m["id"])
    return teams


# ---------------------------------------------------------------------------
# 뉴스 받기
# ---------------------------------------------------------------------------

def _http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (RAISE news bot)"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_rss(xml_bytes: bytes) -> list[dict]:
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return out
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        src_el = it.find("source")
        source = (src_el.text or "").strip() if src_el is not None else ""
        if source and title.endswith(" - " + source):  # 구글 뉴스 제목 끝의 '- 언론사' 떼기
            title = title[: -len(source) - 3].strip()
        try:
            pub = parsedate_to_datetime(it.findtext("pubDate") or "").astimezone(KST).isoformat()
        except (TypeError, ValueError):
            pub = ""
        link = (it.findtext("link") or "").strip()
        if title and link:
            out.append({"title": title, "source": source, "link": link, "published": pub})
    return out


def fetch(teams: dict[str, dict], get=_http_get, pause: float = 1.0, log=print) -> list[dict]:
    """팀 몇 개씩 묶어 검색한다. 제목에 팀 이름이 들어 있는 기사만, 후보 팀과 함께 돌려준다."""
    items: dict[str, dict] = {}
    for lang in ("en", "ko"):
        names = [n for n, t in teams.items() if t["lang"] == lang]
        for i in range(0, len(names), GROUP):
            group = names[i:i + GROUP]
            q = "(" + " OR ".join(f'"{n}"' for n in group) + f") {KW[lang]} when:2d"
            url = FEED[lang].format(q=urllib.parse.quote(q))
            try:
                got = parse_rss(get(url))
            except Exception as e:  # 한 묶음이 실패해도 나머지는 계속
                log(f"  뉴스 검색 실패 ({', '.join(group)}): {e}")
                got = []
            for a in got:
                t = norm(a["title"])
                cands = [n for n in group if short(n) and f" {short(n)} " in f" {t} "]
                if not cands:
                    continue
                cur = items.setdefault(a["link"], dict(a, teams=[]))
                cur["teams"] = sorted(set(cur["teams"]) | set(cands))
            if pause:
                time.sleep(pause)
    # 같은 제목(언론사만 다른 경우)은 하나로
    uniq: dict[str, dict] = {}
    for a in items.values():
        uniq.setdefault(norm(a["title"]), a)
    return list(uniq.values())


# ---------------------------------------------------------------------------
# Haiku 로 고르기
# ---------------------------------------------------------------------------

def classify(arts: list[dict], client) -> list[dict]:
    """관련 있는 기사만 골라 category·impact·summary·team 을 붙여 돌려준다."""
    out = []
    for s in range(0, len(arts), BATCH):
        chunk = arts[s:s + BATCH]
        lines = [f"{i}. {a['title']}  [후보 팀: {' / '.join(a['teams'])}]" for i, a in enumerate(chunk)]
        prompt = "다음 뉴스 제목 가운데 경기에 영향을 줄 소식만 골라라.\n\n" + "\n".join(lines)
        raw = client.complete(SYSTEM, prompt, {"schema": SCHEMA, "model": MODEL, "stage": "news"})
        try:
            got = json.loads(raw).get("items", [])
        except (json.JSONDecodeError, AttributeError):
            got = []
        for g in got:
            i = g.get("i")
            if not isinstance(i, int) or not 0 <= i < len(chunk):
                continue
            a = chunk[i]
            team = g.get("team") if g.get("team") in a["teams"] else a["teams"][0]
            if g.get("category") not in CATS or g.get("impact") not in IMPACT_KO:
                continue
            out.append(dict(a, team=team, category=g["category"], impact=g["impact"],
                            summary=str(g.get("summary", "")).strip()[:120]))
    return out


# ---------------------------------------------------------------------------
# 저장·읽기
# ---------------------------------------------------------------------------

def news_path(base: Path) -> Path:
    return Path(base) / "data" / "news.json"


def load(base: Path) -> dict:
    try:
        return json.loads(news_path(base).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"items": [], "seen": {}}


def _id(link: str) -> str:
    return hashlib.sha1(link.encode()).hexdigest()[:12]


def run(base: Path, client, get=_http_get, now: datetime | None = None, pause: float = 1.0, log=print) -> dict:
    base = Path(base)
    now = now or datetime.now(KST)
    db = load(base)
    seen: dict = db.get("seen", {})
    old = {x["link"]: x for x in db.get("items", [])}
    teams = upcoming_teams(base / "data" / "matches", now)
    log(f"뉴스: 다가오는 경기 팀 {len(teams)}곳 검색")
    arts = fetch(teams, get=get, pause=pause, log=log)
    fresh = [a for a in arts if a["link"] not in old and a["link"] not in seen]
    log(f"  제목 {len(arts)}건 중 새로 볼 것 {len(fresh)}건")
    picked = classify(fresh, client) if fresh else []
    log(f"  경기에 영향 줄 소식 {len(picked)}건")
    stamp = now.isoformat(timespec="seconds")
    for a in fresh:
        seen[a["link"]] = stamp
    for a in picked:
        t = teams.get(a["team"], {})
        old[a["link"]] = {
            "id": _id(a["link"]), "category": a["category"], "impact": a["impact"], "summary": a["summary"],
            "title": a["title"], "source": a["source"], "link": a["link"], "published": a["published"] or stamp,
            "found": stamp, "team": t.get("ko") or a["team"], "team_en": t.get("en") or a["team"],
            "match_ids": t.get("match_ids", []),
        }
    # 이미 있던 뉴스도 다가오는 경기와 다시 짝짓는다 (새 경기가 수집됐을 수 있음)
    by_team = {}
    for t in teams.values():
        by_team.setdefault(t["en"], set()).update(t["match_ids"])
        by_team.setdefault(t["ko"], set()).update(t["match_ids"])
    cut = now - timedelta(days=KEEP_DAYS)
    items = []
    for x in old.values():
        try:
            if datetime.fromisoformat(x["published"]) < cut:
                continue
        except ValueError:
            pass
        x["match_ids"] = sorted(set(x.get("match_ids", [])) | by_team.get(x.get("team_en"), set())
                                | by_team.get(x.get("team"), set()))
        items.append(x)
    items.sort(key=lambda x: x.get("published", ""), reverse=True)
    scut = (now - timedelta(days=SEEN_DAYS)).isoformat()
    seen = {k: v for k, v in seen.items() if v >= scut}
    sig = lambda xs: [(x["id"], tuple(x.get("match_ids", []))) for x in xs]
    changed = sig(items) != sig(db.get("items", []))   # 화면에 보일 내용이 바뀌었나 (안 바뀌면 사이트 재배포 생략)
    out = {"updated": stamp if changed else db.get("updated", stamp), "items": items, "seen": seen, "changed": changed}
    p = news_path(base)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({k: v for k, v in out.items() if k != "changed"}, ensure_ascii=False, indent=1),
                 encoding="utf-8")
    return out


def for_match(base: Path, match_id: str, home_en: str = "", away_en: str = "", home: str = "", away: str = "",
              days: int = 4, now: datetime | None = None) -> list[dict]:
    """이 경기와 관련된 최근 뉴스 (경기 번호가 붙은 것 + 같은 팀 이름)."""
    now = now or datetime.now(KST)
    cut = now - timedelta(days=days)
    names = {n for n in (home_en, away_en, home, away) if n}
    out = []
    for x in load(base).get("items", []):
        if match_id not in x.get("match_ids", []) and x.get("team_en") not in names and x.get("team") not in names:
            continue
        try:
            if datetime.fromisoformat(x["published"]) < cut:
                continue
        except ValueError:
            pass
        out.append(x)
    return out


def brief_lines(items: list[dict]) -> list[str]:
    """분석가에게 줄 한 줄씩: '[부상·결장 · 영향 큼] FC 서울: 요약 (2026-11-25)'"""
    return [f"[{CAT_KO.get(x['category'], x['category'])} · {IMPACT_KO.get(x['impact'], '')}] {x.get('team', '')}: "
            f"{x.get('summary') or x.get('title')} ({(x.get('published') or '')[:10]})" for x in items]
