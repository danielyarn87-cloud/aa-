"""분석 결과를 사람이 읽는 리포트(마크다운)로 만든다."""
from __future__ import annotations

from .models import LABEL_1X2, LABEL_CONF, LABEL_OU, Decision, MarketDecision


def _pct(x: float | None) -> str:
    return "-" if x is None else f"{x:.0%}"


def _won(x: float | None) -> str:
    """기대값을 100원당 평균 손익으로: 0.097 → +10원"""
    return "-" if x is None else f"{'+' if x >= 0 else '−'}{abs(round(x * 100))}원"


def _names(home: str, away: str, line: float) -> dict:
    import math

    return {"home": f"{home} 승", "draw": "무승부", "away": f"{away} 승",
            "over": f"오버 ({math.ceil(line)}골 이상)", "under": f"언더 ({math.floor(line)}골 이하)"}


def _votes(tally: str) -> str:
    n = [int(x) for x in tally.split(":")]
    return f"{sum(n)}명 중 {max(n)}명"


def _pick_label(md: MarketDecision) -> str:
    labels = LABEL_1X2 if md.market == "1x2" else LABEL_OU
    return "판단 보류" if md.pick is None else labels[md.pick]


def decision_text(d: Decision) -> str:
    one, ou = d.one_x_two, d.over_under
    return (
        f"승패 예측: {_pick_label(one)} ({_votes(one.tally)}, 가능성 홈 승 {_pct(one.probs['home'])} / "
        f"무 {_pct(one.probs['draw'])} / 원정 승 {_pct(one.probs['away'])})\n"
        f"골 수 {d.line} 예측: {_pick_label(ou)} ({_votes(ou.tally)}, 오버 가능성 {_pct(ou.probs['over'])})"
    )


def render(run) -> str:
    m, d = run.match, run.decision
    one, ou = d.one_x_two, d.over_under
    mock = "모의" in run.engine
    L: list[str] = []
    L.append(f"# [RAISE 스포츠 분석] {m.title}")
    L.append("")
    L.append(f"{m.league} · {m.kickoff} · 분석 엔진: {run.engine}")
    if mock:
        L.append("")
        L.append("> **모의 실행입니다.** 규칙 기반 흉내로 만든 결과라 실제 분석이 아닙니다. 흐름과 리포트 형식 확인용입니다.")
    L.append("")
    N = _names(m.home, m.away, d.line)
    L.append("## 결론")
    L.append("")
    if d.headline:
        L.append(f"**{d.headline}**")
        L.append("")
    L.append(f"- **누가 이기나**: {N[one.pick] if one.pick else '판단 보류 (의견이 갈림)'} ({_votes(one.tally)})")
    L.append(f"- **골 수**: {N[ou.pick] if ou.pick else '판단 보류 (의견이 갈림)'} ({_votes(ou.tally)})")
    L.append("")
    L.append("## 배당 이득 계산")
    L.append("")
    L.append("| 선택 | 우리가 본 가능성 | 시장이 본 가능성 | 본전 가능성 | 배당 | 100원당 평균 손익 |")
    L.append("| --- | --- | --- | --- | --- | --- |")
    good = []
    for md_, keys in ((one, ("home", "draw", "away")), (ou, ("over", "under"))):
        for k in keys:
            o = m.odds.get(k)
            be = 1 / float(o) if o else None
            e = md_.edges.get(k)
            mark = " · 예측" if md_.pick == k else ""
            flag = " **이득 신호**" if e is not None and e >= 0.05 else ""
            L.append(f"| {N[k]}{mark} | {_pct(md_.probs[k])} | {_pct(md_.market_probs.get(k))} | {_pct(be)} | {o or '-'} | {_won(e)}{flag} |")
            if e is not None and e >= 0.05:
                good.append((N[k], md_.probs[k], be, e))
    L.append("")
    if good:
        for name, p, be, e in good:
            L.append(f"- **{name}**: 우리는 {_pct(p)}로 보는데, 이 배당은 {_pct(be)}만 돼도 본전입니다. 100원을 걸면 평균 {_won(e)}.")
    else:
        L.append("- 이번 경기는 배당이 후하게 나온 선택이 없습니다.")
    L.append("")
    L.append("읽는 법: 본전 가능성은 1 ÷ 배당입니다. 우리가 본 가능성이 이보다 높으면 배당이 후하게 나온 것입니다. "
             "100원당 평균 손익은 같은 판단을 아주 여러 번 했을 때의 평균이며, +5원 이상만 이득 신호로 표시합니다. "
             "이득 신호가 이번 경기에서 맞는다는 뜻은 아닙니다.")
    if one.dissent:
        L.append("")
        L.append(f"- 승패 소수 의견: {', '.join(one.dissent)}")
    if ou.dissent:
        L.append(f"- 골 수 소수 의견: {', '.join(ou.dissent)}")
    if d.comment:
        L.append("")
        L.append(d.comment)

    L.append("")
    L.append("## 분석가 최종 의견")
    first = {o.member_id: o for o in run.initial}
    for o in run.final:
        p = o.probs
        L.append("")
        L.append(f"### {o.member_name} · {N[o.pick_1x2]} / {LABEL_OU[o.pick_ou]} · 확신 {LABEL_CONF[o.confidence]}")
        L.append("")
        L.append(f"가능성: {N['home']} {_pct(p['home'])} / 무승부 {_pct(p['draw'])} / {N['away']} {_pct(p['away'])} · 오버 {_pct(o.over_prob)}")
        L.append("")
        L.append(o.summary)
        L.append("")
        for r in o.key_reasons:
            L.append(f"- {r}")
        for r in o.risks:
            L.append(f"- 틀릴 수 있는 이유: {r}")
        if o.rebuttal:
            L.append(f"- 반박: {o.rebuttal}")
        if o.concession:
            L.append(f"- 인정: {o.concession}")
        if o.changed:
            L.append(f"- 바꾼 점: {o.changed}")

    L.append("")
    L.append("## 토론 전후 변화")
    L.append("")
    L.append("| 분석가 | 처음 고른 결과 | 최종 | 처음 가능성 (승/무/패) | 최종 가능성 (승/무/패) | 오버 가능성 |")
    L.append("| --- | --- | --- | --- | --- | --- |")
    for o in run.final:
        f = first[o.member_id]
        L.append(
            f"| {o.member_name} | {N[f.pick_1x2]} | {N[o.pick_1x2]} | "
            f"{_pct(f.probs['home'])}/{_pct(f.probs['draw'])}/{_pct(f.probs['away'])} | "
            f"{_pct(o.probs['home'])}/{_pct(o.probs['draw'])}/{_pct(o.probs['away'])} | "
            f"{_pct(f.over_prob)}→{_pct(o.over_prob)} |"
        )

    L.append("")
    L.append("## 기본 계산 (득점 통계)")
    L.append("")
    L.append("```")
    L.append(run.base["detail"])
    L.append("```")
    L.append("")
    L.append("## 투표 비중")
    L.append("")
    L.append(", ".join(f"{o.member_name} {d.weights.get(o.member_id, 1.0):.2f}" for o in run.final))
    L.append("")
    L.append("---")
    L.append("이 리포트는 분석 참고용이며 결과를 보장하지 않습니다.")
    return "\n".join(L) + "\n"
