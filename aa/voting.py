"""가중 투표로 회사 결론을 낸다. 인원이 몇 명이든 같은 규칙으로 동작한다.

규칙
- 1위 선택지의 가중 득표율이 policy.consensus_share 를 넘으면 픽 확정, 아니면 관망.
  (3명 동일 비중이면 3:0, 2:1 은 확정 / 1:1:1 은 관망. 4명이면 2:2 는 관망.)
- 확률은 가중 평균. 배당과 곱해 기대값을 계산하고 기준(5%~40%, 배당 3.5 이하)에 들면 '가치 있음'으로 표시.
"""
from __future__ import annotations

from .config import Policy
from .models import OU, OUTCOMES, MarketDecision, Opinion
from .odds import edge


def _market(
    name: str,
    keys: tuple[str, ...],
    picks: list[tuple[str, str, float]],  # (이름, 픽, 비중)
    probs: dict[str, float],
    market_probs: dict[str, float],
    odds: dict,
    policy: Policy,
) -> MarketDecision:
    total_w = sum(w for _, _, w in picks)
    shares = {k: sum(w for _, p, w in picks if p == k) / total_w for k in keys}
    top = max(shares.values())
    leaders = [k for k, s in shares.items() if s == top]
    pick = leaders[0] if len(leaders) == 1 and top > policy.consensus_share else None
    tally = ":".join(str(sum(1 for _, p, _ in picks if p == k)) for k in keys)
    edges = {k: e for k in keys if (e := edge(probs[k], odds.get(k))) is not None}
    th = policy.value_threshold

    def ok(k: str) -> bool:   # 이득 조건: 기대값 5%~40%, 배당 3.5 이하 (company.yaml policy)
        e, o = edges.get(k), odds.get(k)
        return e is not None and th <= e <= policy.value_max_edge and o is not None and float(o) <= policy.value_max_odds

    return MarketDecision(
        market=name,
        pick=pick,
        share=top,
        tally=tally,
        probs=probs,
        market_probs=market_probs,
        edges=edges,
        value_pick=bool(pick and ok(pick)),
        value_alerts=[k for k in edges if ok(k)],
        dissent=[n for n, p, _ in picks if pick and p != pick],
    )


def decide(
    opinions: list[Opinion],
    weights: dict[str, float],
    policy: Policy,
    odds: dict,
    market_1x2: dict[str, float],
    market_ou: dict[str, float],
) -> tuple[MarketDecision, MarketDecision]:
    if not opinions:
        raise ValueError("투표할 의견이 없습니다.")
    w = {o.member_id: weights.get(o.member_id, 1.0) for o in opinions}
    total = sum(w.values())

    probs = {k: sum(w[o.member_id] * o.probs[k] for o in opinions) / total for k in OUTCOMES}
    over = sum(w[o.member_id] * o.over_prob for o in opinions) / total
    over = 0.5 + (over - 0.5) * policy.ou_shrink   # 치우친 판단을 가운데로 조금 당김 (company.yaml ou_shrink)

    one = _market(
        "1x2", OUTCOMES, [(o.member_name, o.pick_1x2, w[o.member_id]) for o in opinions], probs, market_1x2, odds, policy
    )
    ou = _market(
        "over_under",
        OU,
        [(o.member_name, o.pick_ou, w[o.member_id]) for o in opinions],
        {"over": over, "under": 1 - over},
        market_ou,
        odds,
        policy,
    )
    return one, ou
