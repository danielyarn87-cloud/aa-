"""배당 → 시장 확률, 기대값 계산."""
from __future__ import annotations


def implied_probs(odds: dict[str, float], keys: tuple[str, ...]) -> tuple[dict[str, float], float]:
    """소수점 배당에서 북메이커 마진을 비례 제거한 확률과 마진을 돌려준다."""
    raw = {k: 1.0 / float(odds[k]) for k in keys if odds.get(k)}
    if len(raw) != len(keys):
        return {}, 0.0
    total = sum(raw.values())
    return {k: v / total for k, v in raw.items()}, total - 1.0


def edge(prob: float, decimal_odds: float | None) -> float | None:
    """기대값: 확률 x 배당 - 1. 0.05 면 1을 걸 때 장기적으로 0.05 남는다는 뜻."""
    if not decimal_odds:
        return None
    return prob * float(decimal_odds) - 1.0
