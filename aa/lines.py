"""언더/오버 기준점 (2.5 · 3.5 · 4.5).

- 분석가는 세 기준점 모두의 오버 가능성(over_probs)을 한 번에 답한다 (추가 비용 거의 없음).
- 처음 기준점: 운영자가 분석 요청 화면에서 고른 값(data/lines.json) → 없으면 시장 배당이 반반에 가장 가까운 기준점
  → 배당도 없으면 기초 득점 모델로 오버 가능성이 50%에 가장 가까운 기준점.
- 분석이 끝난 뒤 운영자가 기준점을 바꾸면(data/lines.json) 다시 분석하지 않고 미리 받아 둔 숫자로
  의견·팀 결론·채점 기록을 고친다 (python -m aa reline, .github/workflows/lines.yml).
  토론 글은 처음 기준점 이야기 그대로 남는다.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

LINES = (2.5, 3.5, 4.5)


def path_of(base_dir: Path) -> Path:
    return Path(base_dir) / "data" / "lines.json"


def load(base_dir: Path) -> dict[str, float]:
    """운영자가 고른 기준점 {경기 번호: 기준점}."""
    try:
        raw = json.loads(path_of(base_dir).read_text(encoding="utf-8")).get("lines", {})
    except (OSError, ValueError):
        return {}
    out = {}
    for k, v in raw.items():
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if v in LINES:
            out[str(k)] = v
    return out


def key(line: float) -> str:
    return f"{float(line):.1f}"


def tidy(over_probs: dict | None, line: float, over: float) -> dict[str, float]:
    """세 기준점 오버 가능성을 정리: 0~1 로 자르고, 고른 기준점 값은 답한 over_prob 로 맞추고,
    기준점이 높을수록 오버 가능성이 같거나 낮게 (2.5 ≥ 3.5 ≥ 4.5)."""
    raw = {}
    for k, v in (over_probs or {}).items():
        try:
            f = float(k)
            if f in LINES:
                raw[f] = min(max(float(v), 0.0), 1.0)
        except (TypeError, ValueError):
            continue
    if float(line) in LINES:
        raw[float(line)] = over
    if not raw:
        return {}
    for pt in LINES:   # 빠진 기준점은 비우고 끝낸다 (옛 답변·형식 오류)
        if pt not in raw:
            return {key(p): round(v, 4) for p, v in sorted(raw.items())}
    lo = sorted(LINES)
    # 고른 기준점을 기준으로 위아래를 맞춘다
    i = lo.index(float(line)) if float(line) in lo else 0
    for j in range(i - 1, -1, -1):
        raw[lo[j]] = max(raw[lo[j]], raw[lo[j + 1]])
    for j in range(i + 1, len(lo)):
        raw[lo[j]] = min(raw[lo[j]], raw[lo[j - 1]])
    return {key(p): round(raw[p], 4) for p in lo}


def odds_for(odds: dict, line: float) -> dict:
    """그 기준점의 언더/오버 배당으로 바꾼 배당 묶음. 그 기준점 배당이 없으면 언더/오버 배당을 비운다."""
    o = dict(odds or {})
    o["line"] = float(line)
    t = (o.get("totals") or {}).get(key(line))
    if t and t.get("over") and t.get("under"):
        o["over"], o["under"] = t["over"], t["under"]
        o.pop("best_over", None), o.pop("best_under", None)
    elif float(odds.get("line") or 0) != float(line):
        for k in ("over", "under", "best_over", "best_under"):
            o.pop(k, None)
    return o


def model_line(lambdas) -> float:
    """배당이 없을 때: 기초 득점 모델로 오버 가능성이 50%에 가장 가까운 기준점."""
    from .sports.base import score_matrix, summarize_matrix

    try:
        lh, la = float(lambdas[0]), float(lambdas[1])
    except (TypeError, ValueError, IndexError):
        return 2.5
    m = score_matrix(lh, la)
    return min(LINES, key=lambda pt: (abs(summarize_matrix(m, pt)[1] - 0.5), pt))


def start_line(match_odds: dict, override: float | None, lambdas) -> float:
    """분석을 시작할 때 쓸 기준점."""
    if override in LINES:
        return float(override)
    o = match_odds or {}
    if o.get("over") and o.get("under") and float(o.get("line") or 0) in LINES:
        return float(o["line"])
    if o.get("totals"):
        from .sources.odds_api import OddsApi  # noqa: F401  (기준점 규칙은 odds_api.main_line 과 같게)

        best = min((k for k in o["totals"] if float(k) in LINES),
                   key=lambda k: abs(o["totals"][k]["over"] - o["totals"][k]["under"]), default=None)
        if best:
            return float(best)
    return model_line(lambdas)


def can_reline(run: dict) -> bool:
    return all(key_ok(op) for op in run.get("final", []))


def key_ok(op: dict) -> bool:
    return all(key(pt) in (op.get("over_probs") or {}) for pt in LINES)


def apply_line(run: dict, line: float, policy) -> bool:
    """분석이 끝난 경기의 기준점을 바꾼다 (run 을 그 자리에서 고침). 바꿨으면 True.
    세 기준점 숫자가 없는 예전 분석은 바꾸지 않는다."""
    from .models import OU, Opinion
    from .odds import implied_probs
    from .sports.base import score_matrix, summarize_matrix
    from .voting import decide

    line = float(line)
    d = run["decision"]
    if line not in LINES or float(d.get("line") or 0) == line or not can_reline(run):
        return False
    for op in run.get("initial", []) + run.get("final", []):
        ps = op.get("over_probs") or {}
        if key(line) in ps:
            op["over_prob"] = float(ps[key(line)])
            op["pick_ou"] = "over" if op["over_prob"] >= 0.5 else "under"
    m = run["match"]
    m["odds"] = odds_for(m.get("odds") or {}, line)
    mou, _ = implied_probs(m["odds"], OU)
    weights = d.get("weights") or {}
    voters = [Opinion.from_dict(o["member_id"], o["member_name"], "debate", o)
              for o in run["final"] if not weights or o["member_id"] in weights]
    m1 = (run.get("market") or {}).get("1x2") or {}
    _, ou = decide(voters, weights, policy, m["odds"], m1, mou)
    prev = d.get("line")
    d["over_under"], d["line"] = asdict(ou), line
    run.setdefault("market", {})["ou"] = mou
    base = run.get("base") or {}
    if base.get("lambdas"):
        base["over_prob"] = summarize_matrix(score_matrix(*base["lambdas"][:2]), line)[1]
    run.setdefault("line_history", []).append({"from": prev, "to": line})
    return True


def reline_all(company, log=print) -> int:
    """data/lines.json 의 기준점을 아직 시작 안 한 경기의 분석 결과와 채점 기록에 반영한다."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from .ledger import Ledger

    want = load(company.base_dir)
    if not want:
        return 0
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    ledger = None
    n = 0
    for mid, line in want.items():
        p = company.base_dir / "reports" / f"{mid}.json"
        if not p.exists():
            continue
        run = json.loads(p.read_text(encoding="utf-8"))
        iso = (run["match"].get("data") or {}).get("kickoff_iso")
        try:
            started = iso and datetime.fromisoformat(iso) <= now
        except ValueError:
            started = False
        if started:
            continue                      # 시작한 경기는 바꾸지 않는다 (채점 기준이 흔들리지 않게)
        if not apply_line(run, line, company.policy):
            if float(run["decision"].get("line") or 0) != line:
                log(f"기준점: {mid} 는 세 기준점 숫자가 없는 예전 분석이라 바꾸지 못함")
            continue
        p.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
        ledger = ledger or Ledger(company.base_dir / "data" / "ledger.sqlite")
        ledger.reline(run)
        n += 1
        ou = run["decision"]["over_under"]
        log(f"기준점: {run['match']['home']} vs {run['match']['away']} → {line} ({ou['pick'] or '관망'})")
    return n
