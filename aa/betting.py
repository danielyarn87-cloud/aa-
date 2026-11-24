"""AI 3명의 가상 배팅 게임.

규칙
- 분석가(투표하는 사람)마다 가상 자금 100만원으로 시작한다.
- 각자 3폴더·5폴더·7폴더 조합 배팅을 한 장씩 들고 간다. 한 장이 정산되면 다음 실행 때 새로 건다.
- 한 장의 경기는 이틀 안(예: 24일·25일)이어야 한다. 24·25·26일처럼 사흘에 걸칠 수 없다.
- 한 장에는 경기당 한 가지 선택만 (같은 경기의 승무패와 언더오버를 같이 넣지 않는다).
- 선택은 그 분석가 자신의 최종 가능성으로 고른다: 맞을 가능성이 너무 낮은 것은 빼고, 100원당 평균 손익이 큰 순서.
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


def load(company: Company) -> dict:
    p = path_of(company)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"start_bankroll": START_BANKROLL, "accounts": {}, "slips": []}


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


def _legs_for(run: dict, member_id: str) -> list[dict]:
    """그 분석가의 최종 의견으로 이 경기에서 고를 수 있는 선택들 (배당이 있는 것만)."""
    op = next((o for o in run.get("final", []) if o["member_id"] == member_id), None)
    odds = run["match"].get("odds") or {}
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


def place(company: Company, book: dict, runs: list[dict], now: datetime, log=print) -> int:
    today = now.astimezone(KST).date()
    window = {today, today + timedelta(days=1)}          # 이틀 안 경기만
    upcoming = []
    for r in runs:
        if "모의" in r.get("engine", ""):
            continue
        ko_ = _kickoff(r)
        if ko_ and ko_ > now and ko_.astimezone(KST).date() in window:
            upcoming.append(r)
    placed = 0
    for m in company.voters("soccer"):
        acc = book["accounts"].setdefault(m.id, {"name": m.name, "bankroll": book.get("start_bankroll", START_BANKROLL)})
        best = []
        for r in upcoming:
            legs = [l for l in _legs_for(r, m.id) if l["prob"] >= MIN_LEG_PROB]
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


def summary(company: Company) -> dict:
    """사이트용: 계좌별 잔액·손익·적중."""
    book = load(company)
    start = book.get("start_bankroll", START_BANKROLL)
    accs = []
    for m in company.voters("soccer"):
        a = book["accounts"].get(m.id, {"name": m.name, "bankroll": start})
        mine = [s for s in book["slips"] if s["member_id"] == m.id]
        open_ = [s for s in mine if s["status"] == "open"]
        done = [s for s in mine if s["status"] != "open"]
        at_risk = sum(s["stake"] for s in open_)
        value = a["bankroll"] + at_risk           # 걸어 둔 돈까지 합친 평가액
        accs.append({"member_id": m.id, "name": m.name, "title": m.title, "color": m.color,
                     "bankroll": a["bankroll"], "at_risk": at_risk, "value": value, "profit": value - start,
                     "won": sum(1 for s in done if s["status"] == "won"), "settled": len(done),
                     "staked": sum(s["stake"] for s in done), "returned": sum(s["payout"] or 0 for s in done)})
    slips = sorted(book["slips"], key=lambda s: s["placed_at"], reverse=True)
    # 예전 배팅에는 이유가 저장돼 있지 않아 분석 글에서 채운다
    from .store import load_runs
    finals = {}
    for r in load_runs(company.base_dir / "reports"):
        for op in r.get("final", []):
            finals[(r["match"]["id"], op["member_id"])] = op
    for s in slips:
        b = s["combined_odds"] - 1
        kelly = (s["prob"] * s["combined_odds"] - 1) / b if b > 0 else 0
        s["how"] = {"ev_per_100": round((s["prob"] * s["combined_odds"] - 1) * 100), "kelly": round(kelly, 4),
                    "kelly_quarter": round(kelly * KELLY_FRACTION, 4)}
        for l in s["legs"]:
            l.setdefault("ev", round(l["prob"] * l["odds"] - 1, 4))
            l["breakeven"] = round(1 / l["odds"], 4)
            if not l.get("reason"):
                op = finals.get((l["match_id"], s["member_id"]))
                l["reason"] = _reason(op, l["market"]) if op else ""
    return {"start_bankroll": start, "min_stake": MIN_STAKE, "max_stake": MAX_STAKE, "sizes": list(SIZES),
            "accounts": accs, "slips": slips[:120]}
