"""Claude 크레딧 추정 잔액.

Console 의 잔액은 밖에서 읽을 수 없어서:
  1) 사용자가 Console 에서 본 잔액을 사이트에서 입력한다 (data/credit.json, functions/api/credit.js).
     "68.75" 는 잔액을 그 값으로 맞추고, "+20" 은 충전한 금액만 더한다.
  2) 분석할 때마다 Claude 가 알려 주는 실제 토큰 수로 비용을 계산해 쌓는다 (data/claude_spend.json).
  3) 추정 잔액 = 마지막으로 맞춘 잔액 + 그 뒤 충전 − 그 뒤 사용.
가격표 반올림·할인 등으로 Console 과 몇 센트 다를 수 있으니, 가끔 잔액을 다시 맞춘다.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

# 100만 토큰당 달러 (입력, 출력). 바뀌면 여기만 고친다.
PRICES = {
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),     # 프롬프트 10만 토큰 이하 기준
    "claude-opus-5-5": (4.00, 20.00),
}
DEFAULT_PRICE = (2.00, 10.00)

_calls: list[dict] = []   # 이번 실행에서 부른 기록 (flush 때 파일로)


def cost(model: str, usage: dict) -> float:
    pi, po = PRICES.get(model, DEFAULT_PRICE)
    inp = usage.get("input_tokens", 0) or 0
    out = usage.get("output_tokens", 0) or 0
    cw = usage.get("cache_creation_input_tokens", 0) or 0
    cr = usage.get("cache_read_input_tokens", 0) or 0
    return (inp * pi + out * po + cw * pi * 1.25 + cr * pi * 0.1) / 1_000_000


def record(model: str, usage: dict | None) -> None:
    if not usage:
        return
    _calls.append({"model": model, "in": usage.get("input_tokens", 0) or 0,
                   "out": usage.get("output_tokens", 0) or 0, "usd": cost(model, usage)})


def spend_path(base: Path) -> Path:
    return Path(base) / "data" / "claude_spend.json"


def credit_path(base: Path) -> Path:
    return Path(base) / "data" / "credit.json"


def _read(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def flush(base: Path, now: datetime | None = None) -> dict | None:
    """이번 실행의 사용량을 data/claude_spend.json 에 한 줄로 더한다 (부른 적이 없으면 아무것도 안 함)."""
    global _calls
    if not _calls:
        return None
    now = now or datetime.now(timezone.utc)
    models: dict[str, float] = {}
    for c in _calls:
        models[c["model"]] = models.get(c["model"], 0) + c["usd"]
    run = {"at": now.isoformat(timespec="seconds"), "calls": len(_calls),
           "in": sum(c["in"] for c in _calls), "out": sum(c["out"] for c in _calls),
           "usd": round(sum(c["usd"] for c in _calls), 6),
           "by_model": {k: round(v, 6) for k, v in models.items()}}
    p = spend_path(base)
    data = _read(p, {"runs": []})
    data.setdefault("runs", []).append(run)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    _calls = []
    return run


def _t(s: str) -> datetime:
    d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def status(base: Path) -> dict:
    """사이트에 보일 추정 잔액. 아직 잔액을 넣은 적이 없으면 balance 는 None."""
    events = _read(credit_path(base), {}).get("events", [])
    runs = _read(spend_path(base), {}).get("runs", [])
    sets = [e for e in events if e.get("type") == "set"]
    if not sets:
        return {"balance": None, "spent_total": round(sum(r.get("usd", 0) for r in runs), 4)}
    last = max(sets, key=lambda e: _t(e["at"]))
    t0 = _t(last["at"])
    added = sum(float(e.get("usd", 0)) for e in events if e.get("type") == "add" and _t(e["at"]) > t0)
    after = [r for r in runs if _t(r["at"]) > t0]
    spent = sum(r.get("usd", 0) for r in after)
    return {"balance": round(float(last["usd"]) + added - spent, 2), "set_usd": float(last["usd"]),
            "set_at": last["at"], "added": round(added, 2), "spent": round(spent, 4),
            "calls": sum(r.get("calls", 0) for r in after)}
