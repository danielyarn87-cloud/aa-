"""AI 3명의 가상 배팅 게임.

규칙
- 분석가(투표하는 사람)마다 가상 자금 100만원으로 시작한다.
- 각자 3폴더·5폴더·7폴더 조합 배팅을 한 장씩 들고 간다. 한 장이 정산되면 다음 실행 때 새로 건다.
- 한 장의 경기는 이틀 안(예: 24일·25일)이어야 한다. 24·25·26일처럼 사흘에 걸칠 수 없다.
- 한 장에는 경기당 한 가지 선택만 (같은 경기의 승무패와 언더오버를 같이 넣지 않는다).
- 선택은 그 분석가 자신의 최종 가능성으로 고른다: 맞을 가능성이 너무 낮은 것은 빼고, 기대 손익(5,000원 기준 화면 표시)이 큰 순서.
- 금액은 5,000원 이상 100,000원 이하, 1,000원 단위. 켈리 기준의 1/4 만큼 (자신 있을수록 많이, 그래도 한도 안).
- 배당은 북메이커 평균 배당. 모두 맞히면 금액 × 배당 곱을 받고, 하나라도 틀리면 0원.
실제 돈이 아닌 분석 실력 비교용 기록이다.
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .config import Company
from .ledger import Ledger

KST = ZoneInfo("Asia/Seoul")
START_BANKROLL = 1_000_000
MIN_STAKE, MAX_STAKE = 5_000, 100_000
SIZES = (3, 5, 7)
MIN_LEG_PROB = 0.45      # 조합 배팅이라 한 경기라도 가능성이 낮으면 거의 다 틀린다
KELLY_FRACTION = 0.25


def path_of(company: Company) -> Path:
    return company.base_dir / "data" / "betting.json"


def topups_path(company: Company) -> Path:
    return company.base_dir / "data" / "topups.json"


def _apply_topups(company: Company, book: dict) -> None:
    """사이트에서 넣어 준 추가 금액(data/topups.json)을 계좌에 반영한다. 한 번 반영한 것은 다시 넣지 않는다."""
    p = topups_path(company)
    try:
        items = json.loads(p.read_text(encoding="utf-8")).get("topups", []) if p.exists() else []
    except (OSError, ValueError):
        items = []
    applied = book.setdefault("applied_topups", [])
    names = {m.id: m.name for m in company.members}
    for t in items:
        tid, mid, amount = str(t.get("id")), t.get("member_id"), int(t.get("amount") or 0)
        if tid in applied or mid not in names or amount <= 0:
            continue
        acc = book["accounts"].setdefault(mid, {"name": names[mid], "bankroll": book.get("start_bankroll", START_BANKROLL)})
        acc["bankroll"] += amount
        acc["deposited"] = acc.get("deposited", 0) + amount
        applied.append(tid)


def load(company: Company) -> dict:
    p = path_of(company)
    if p.exists():
        book = json.loads(p.read_text(encoding="utf-8"))
    else:
        book = {"start_bankroll": START_BANKROLL, "accounts": {}, "slips": []}
    _apply_topups(company, book)
    return book


def save(company: Company, book: dict) -> None:
    path_of(company).write_text(json.dumps(book, ensure_ascii=False, indent=2), encoding="utf-8")


def _kickoff(run: dict) -> datetime | None:
    m = run["match"]
    iso = (m.get("data") or {}).get("kickoff_iso")
    if iso:
        return datetime.fromisoformat(iso)
    try:
        return datetime.strptime(m["kickoff"].replace(" KST", ""), "%Y-%m-%d %H:%M").replace(tzinfo=KST)
    except (KeyError, ValueError):
        return None


def _odds_for(run: dict, now_odds: dict | None) -> dict:
    """분석 때 저장된 배당. 없으면(2026-11-26 배당 키 장애 때 분석된 경기 등) 지금 배당을 쓴다.
    언더/오버는 분석 때 기준선과 지금 기준선이 같을 때만 (기준이 다르면 확률이 맞지 않음)."""
    odds = dict(run["match"].get("odds") or {})
    if odds.get("home") or not now_odds:
        return odds
    line = odds.get("line") or (run.get("decision") or {}).get("line")
    out = {k: now_odds.get(k) for k in ("home", "draw", "away")}
    if line is not None and now_odds.get("line") is not None and float(now_odds["line"]) == float(line):
        out.update(over=now_odds.get("over"), under=now_odds.get("under"))
    out["line"] = line
    out["source"] = "지금 배당 (분석 때 배당 없음)"
    return out


def _legs_for(run: dict, member_id: str, now_odds: dict | None = None) -> list[dict]:
    """그 분석가의 최종 의견으로 이 경기에서 고를 수 있는 선택들 (배당이 있는 것만)."""
    op = next((o for o in run.get("final", []) if o["member_id"] == member_id), None)
    odds = _odds_for(run, now_odds)
    if not op:
        return []
    from .teams_ko import ko
    home, away = ko(run["match"]["home"]), ko(run["match"]["away"])
    line = odds.get("line") or run["decision"].get("line")
    names = {"home": f"{home} 승", "draw": "무승부", "away": f"{away} 승",
             "over": f"오버 {line}", "under": f"언더 {line}"}
    probs = dict(op["probs"])
    probs["over"] = op["over_prob"]
    probs["under"] = 1 - op["over_prob"]
    out = []
    for k in ("home", "draw", "away", "over", "under"):
        o = odds.get(k)
        if not o or o <= 1:
            continue
        p = float(probs[k])
        out.append({"match_id": run["match"]["id"], "title": f"{home} vs {away}", "kickoff": run["match"]["kickoff"],
                    "market": "ou" if k in ("over", "under") else "1x2", "pick": k, "label": names[k],
                    "line": line if k in ("over", "under") else None, "odds": float(o), "prob": round(p, 4),
                    "ev": round(p * float(o) - 1, 4), "reason": _reason(op, "ou" if k in ("over", "under") else "1x2")})
    return out


def _reason(op: dict, market: str) -> str:
    """그 분석가가 이 선택을 고른 이유 한 줄 (자기 분석 글에서 그 선택과 관련된 문장)."""
    reasons = list(op.get("key_reasons") or []) + ([op["summary"]] if op.get("summary") else [])
    if market == "ou":
        words = [("언더", "오버"), ("골 이상", "골 이하", "득점 합", "합이", "총 득점"), ("골",)]
    else:
        words = [("승리", "승 ", "무승부", "비길"), ("승",)]
    text = ""
    for ws in words:
        text = next((r for r in reasons if any(w in r for w in ws)
                     and not (market == "1x2" and any(x in r for x in ("언더", "오버")))), "")
        if text:
            break
    text = text or (reasons[0] if reasons else "")
    return text if len(text) <= 180 else text[:178] + "…"


def _stake(bankroll: int, p: float, odds: float) -> int:
    b = odds - 1
    kelly = (p * odds - 1) / b if b > 0 else 0
    amount = bankroll * kelly * KELLY_FRACTION if kelly > 0 else MIN_STAKE
    amount = int(round(amount / 1000) * 1000)
    return max(MIN_STAKE, min(MAX_STAKE, amount, bankroll // 1000 * 1000))


def _leg_result(leg: dict, res: dict) -> bool | None:
    if res is None:
        return None
    h, a = res["home_goals"], res["away_goals"]
    if leg["market"] == "ou":
        return ((h + a) > leg["line"]) == (leg["pick"] == "over")
    outcome = "home" if h > a else "away" if a > h else "draw"
    return outcome == leg["pick"]


def settle(book: dict, results: dict, now: datetime, log=print) -> int:
    n = 0
    for s in book["slips"]:
        if s["status"] != "open":
            continue
        marks = [_leg_result(l, results.get(l["match_id"])) for l in s["legs"]]
        for l, mk in zip(s["legs"], marks):
            l["hit"] = mk
        if any(mk is False for mk in marks):
            s.update(status="lost", payout=0)
        elif all(mk is True for mk in marks):
            s.update(status="won", payout=int(math.floor(s["stake"] * s["combined_odds"])))
            book["accounts"][s["member_id"]]["bankroll"] += s["payout"]
        else:
            continue
        s["settled_at"] = now.strftime("%Y-%m-%d %H:%M KST")
        n += 1
        log(f"배팅 정산: {s['member_name']} {s['size']}폴더 {'적중 +' + format(s['payout'], ',') + '원' if s['status'] == 'won' else '실패'}")
    return n


AHEAD = timedelta(hours=48)   # 앞으로 48시간 안 경기만 (예전: 오늘·내일 날짜 → 밤에 돌면 모레 새벽 경기가 빠졌음)


def _now_odds(company: Company, match_id: str) -> dict | None:
    """매일 목록 수집 때 저장한 지금 배당 (data/matches/<id>.json)."""
    import json
    p = company.base_dir / "data" / "matches" / f"{match_id}.json"
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("odds") or None
    except (OSError, ValueError):
        return None


def place(company: Company, book: dict, runs: list[dict], now: datetime, log=print) -> int:
    upcoming = []
    for r in runs:
        if "모의" in r.get("engine", ""):
            continue
        ko_ = _kickoff(r)
        if ko_ and now < ko_ <= now + AHEAD:
            upcoming.append(r)
    now_odds = {r["match"]["id"]: _now_odds(company, r["match"]["id"]) for r in upcoming}
    pol = getattr(company, "policy", None)
    max_edge = float(getattr(pol, "value_max_edge", 0.40) or 0.40)
    max_odds = float(getattr(pol, "value_max_odds", 3.5) or 3.5)
    placed = 0
    for m in company.analysts("soccer"):
        acc = book["accounts"].setdefault(m.id, {"name": m.name, "bankroll": book.get("start_bankroll", START_BANKROLL)})
        best = []
        for r in upcoming:
            # 이득 규칙과 같은 기준(11/27): 기대값 40% 넘게 크거나 배당 3.5 넘는 선택은 분석 착오일 때가 많아 뺀다
            legs = [l for l in _legs_for(r, m.id, now_odds.get(r["match"]["id"]))
                    if l["prob"] >= MIN_LEG_PROB and l["ev"] <= max_edge and l["odds"] <= max_odds]
            if legs:
                best.append(max(legs, key=lambda l: (l["ev"], l["prob"])))
        best.sort(key=lambda l: (l["ev"], l["prob"]), reverse=True)
        for size in SIZES:
            if any(s for s in book["slips"] if s["member_id"] == m.id and s["size"] == size and s["status"] == "open"):
                continue
            if len(best) < size:
                log(f"배팅: {m.name} {size}폴더는 고를 경기가 부족해 이번엔 쉽니다 ({len(best)}경기)")
                continue
            if acc["bankroll"] < MIN_STAKE:
                log(f"배팅: {m.name} 잔액 부족")
                continue
            legs = best[:size]
            odds = round(math.prod(l["odds"] for l in legs), 2)
            prob = math.prod(l["prob"] for l in legs)
            stake = _stake(acc["bankroll"], prob, odds)
            acc["bankroll"] -= stake
            days = sorted({l["kickoff"][:10] for l in legs})
            book["slips"].append({
                "id": f"{now.strftime('%Y%m%d%H%M')}-{m.id}-{size}", "member_id": m.id, "member_name": m.name,
                "size": size, "days": days, "placed_at": now.strftime("%Y-%m-%d %H:%M KST"),
                "stake": stake, "combined_odds": odds, "prob": round(prob, 4),
                "expected": round(prob * odds * stake - stake), "legs": legs, "status": "open", "payout": None,
            })
            placed += 1
            log(f"배팅: {m.name} {size}폴더 {stake:,}원 (배당 {odds}, 맞을 가능성 {prob:.1%})")
    return placed


def run_betting(company: Company, ledger: Ledger, now: datetime, log=print) -> dict:
    from .store import load_runs

    book = load(company)
    results = {r["match_id"]: dict(r) for r in ledger.db.execute("SELECT * FROM results")}
    settled = settle(book, results, now, log)
    placed = place(company, book, load_runs(company.base_dir / "reports"), now, log)
    save(company, book)
    return {"settled": settled, "placed": placed}


def _ticket_info(leg: dict, m: dict | None, leagues: list) -> None:
    """배팅표처럼 보여 주려고 리그·팀·고를 수 있던 칸들의 배당을 붙인다."""
    m = m or {}
    text = str(m.get("league", ""))
    leg["league"] = next((lc["name"] for lc in leagues if text.startswith(lc["name"])), text.split(" ")[0] if text else "")
    home, away = (leg.get("title", "").split(" vs ") + [""])[:2]
    from .teams_ko import ko
    leg["home"], leg["away"] = ko(m.get("home") or home), ko(m.get("away") or away)
    leg["title"] = f'{leg["home"]} vs {leg["away"]}'
    o = m.get("odds") or {}
    if leg["market"] == "1x2":
        keys = ["home", "draw", "away"]
    else:
        keys = ["under", "over"]
    same_line = leg["market"] == "1x2" or o.get("line") == leg.get("line")
    leg["opts"] = {k: (leg["odds"] if k == leg["pick"] else (o.get(k) if same_line else None)) for k in keys}


def summary(company: Company) -> dict:
    """사이트용: 계좌별 잔액·손익·적중."""
    book = load(company)
    start = book.get("start_bankroll", START_BANKROLL)
    accs = []
    for m in company.analysts("soccer"):
        a = book["accounts"].get(m.id, {"name": m.name, "bankroll": start})
        mine = [s for s in book["slips"] if s["member_id"] == m.id]
        open_ = [s for s in mine if s["status"] == "open"]
        done = [s for s in mine if s["status"] != "open"]
        at_risk = sum(s["stake"] for s in open_)
        value = a["bankroll"] + at_risk           # 걸어 둔 돈까지 합친 평가액
        deposited = a.get("deposited", 0)         # 사이트에서 추가로 넣어 준 돈
        legs = [l for s in mine for l in s["legs"] if l.get("hit") is not None]
        by_size = {str(n): {"won": sum(1 for s in done if s["size"] == n and s["status"] == "won"),
                            "settled": sum(1 for s in done if s["size"] == n)} for n in SIZES}
        accs.append({"member_id": m.id, "name": m.name, "title": m.title, "color": m.color, "votes": m.votes,
                     "bankroll": a["bankroll"], "at_risk": at_risk, "value": value, "deposited": deposited,
                     "profit": value - start - deposited,
                     "won": sum(1 for s in done if s["status"] == "won"), "settled": len(done),
                     "legs_hit": sum(1 for l in legs if l["hit"]), "legs_settled": len(legs), "by_size": by_size,
                     "staked": sum(s["stake"] for s in done), "returned": sum(s["payout"] or 0 for s in done)})
    slips = sorted(book["slips"], key=lambda s: s["placed_at"], reverse=True)
    # 예전 배팅에는 이유가 저장돼 있지 않아 분석 글에서 채운다
    from .store import load_runs
    finals, matches = {}, {}
    for r in load_runs(company.base_dir / "reports"):
        matches[r["match"]["id"]] = r["match"]
        for op in r.get("final", []):
            finals[(r["match"]["id"], op["member_id"])] = op
    leagues = sorted(company.data_sources.get("leagues", []), key=lambda x: -len(x["name"]))
    for s in slips:
        b = s["combined_odds"] - 1
        kelly = (s["prob"] * s["combined_odds"] - 1) / b if b > 0 else 0
        s["how"] = {"ev_per_100": round((s["prob"] * s["combined_odds"] - 1) * 100), "kelly": round(kelly, 4),
                    "kelly_quarter": round(kelly * KELLY_FRACTION, 4)}
        for l in s["legs"]:
            l.setdefault("ev", round(l["prob"] * l["odds"] - 1, 4))
            l["breakeven"] = round(1 / l["odds"], 4)
            _ticket_info(l, matches.get(l["match_id"]), leagues)
            if not l.get("reason"):
                op = finals.get((l["match_id"], s["member_id"]))
                l["reason"] = _reason(op, l["market"]) if op else ""
    return {"start_bankroll": start, "min_stake": MIN_STAKE, "max_stake": MAX_STAKE, "sizes": list(SIZES),
            "accounts": accs, "slips": slips[:120]}
