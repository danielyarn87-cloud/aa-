"""분석 흐름: 자료 준비 → 독립 분석 → 토론 → 가중 투표 → (팀장 코멘트)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from string import Template

from .config import Company, Member
from .ledger import Ledger
from .models import OU, OUTCOMES, Decision, Match, Opinion, extract_json
from .odds import implied_probs
from .sports import get_sport
from .voting import decide


_PROBS = {"type": "object", "properties": {k: {"type": "number"} for k in ("home", "draw", "away")},
          "required": ["home", "draw", "away"], "additionalProperties": False}
_TEXTS = {"type": "array", "items": {"type": "string"}}
_OPINION = {
    "probs": _PROBS,
    "pick_1x2": {"type": "string", "enum": ["home", "draw", "away"]},
    "over_prob": {"type": "number"},
    "pick_ou": {"type": "string", "enum": ["over", "under"]},
    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    "key_reasons": _TEXTS,
    "risks": _TEXTS,
    "summary": {"type": "string"},
}
_REQ = ["probs", "pick_1x2", "over_prob", "pick_ou", "confidence", "key_reasons", "risks", "summary"]
SCHEMAS = {
    "initial": {"type": "object", "properties": _OPINION, "required": _REQ, "additionalProperties": False},
    "debate": {"type": "object",
               "properties": {"rebuttal": {"type": "string"}, "concession": {"type": "string"},
                              "changed": {"type": "string"}, **_OPINION},
               "required": ["rebuttal", "concession", "changed", *_REQ], "additionalProperties": False},
    "lead": {"type": "object", "properties": {"headline": {"type": "string"}, "comment": {"type": "string"}},
             "required": ["headline", "comment"], "additionalProperties": False},
}


@dataclass
class AnalysisRun:
    match: Match
    decision: Decision
    initial: list[Opinion]
    final: list[Opinion]
    base: dict
    market_1x2: dict
    market_ou: dict
    margin_1x2: float
    engine: str


def _template(company: Company, name: str) -> Template:
    return Template((company.base_dir / "prompts" / f"{name}.md").read_text(encoding="utf-8"))


def _system(company: Company, member: Member) -> str:
    return (
        f"{member.persona()}\n\n---\n당신은 {company.name} 의 직원입니다. 모든 답은 한국어로 씁니다. "
        "주어진 자료 밖의 사실을 지어내지 않습니다."
    )


def _market_text(match: Match, m1: dict, margin: float, mou: dict, line: float) -> str:
    o = match.odds
    parts = []
    if m1:
        parts.append(
            f"승 {m1['home']:.1%} / 무 {m1['draw']:.1%} / 패 {m1['away']:.1%} "
            f"(배당 {o['home']} / {o['draw']} / {o['away']}, 마진 {margin:.1%})"
        )
    else:
        parts.append("승무패 배당 자료 없음")
    if mou:
        parts.append(f"총 득점 {line} 오버 {mou['over']:.1%} / 언더 {mou['under']:.1%} (배당 {o['over']} / {o['under']})")
    else:
        parts.append("언더/오버 배당 자료 없음")
    if o.get("movement"):
        parts.append(f"배당 흐름: {o['movement']}")
    return "\n".join(parts)


BLIND_MARKET = ("(1차 분석에서는 배당을 일부러 보여 주지 않습니다. 시장이 누구를 밀고 있는지 짐작해 맞추지 말고, "
                "자료와 당신의 관점만으로 가능성을 내세요. 배당은 토론 때 공개됩니다.)")


def _ask(client, company: Company, member: Member, stage: str, prompt: str, ctx: dict) -> dict:
    ctx = {**ctx, "member_id": member.id, "stage": stage, "model": member.model, "schema": SCHEMAS.get(stage)}
    system = _system(company, member)
    last_err: Exception | None = None
    for attempt in range(2):
        text = client.complete(system, prompt if attempt == 0 else prompt + "\n\n반드시 JSON 객체 하나만 출력하세요.", ctx)
        try:
            return extract_json(text)
        except Exception as e:  # 형식이 깨지면 한 번 더 요청
            last_err = e
            print(f"[{member.name} {stage}] 답변 형식 오류: {e} / 답변 앞부분: {text[:300]!r}")
    raise RuntimeError(f"{member.name} 의 답변을 읽지 못했습니다: {last_err}")


def analyze(company: Company, match: Match, client, ledger: Ledger, dept_id: str | None = None) -> AnalysisRun:
    dept = company.department(dept_id) if dept_id else company.department_for_sport(match.sport)
    if not dept.active:
        raise RuntimeError(f"{dept.name} 은 아직 비활성 부서입니다.")
    sport = get_sport(match.sport)
    line = float(match.odds.get("line", dept.over_under_line))
    voters = company.analysts(dept.id) or company.voters(dept.id)   # 분석·토론 참여자 (투표 안 하는 사람 포함)
    voting = {m.id for m in company.voters(dept.id)}
    if not voting:
        raise RuntimeError(f"{dept.name} 에 투표할 분석가가 없습니다.")

    base = sport.base_model(match, line)
    m1, margin = implied_probs(match.odds, OUTCOMES)
    mou, _ = implied_probs(match.odds, OU)
    brief = sport.brief(match)
    market = _market_text(match, m1, margin, mou, line)
    ctx = {
        "base_probs": base["probs"],
        "base_over": base["over_prob"],
        "market_probs": m1,
        "odds": match.odds,
        "data": match.data,
    }

    # 1) 독립 분석: 서로의 의견을 모른 채 동시에
    t_init = _template(company, "analysis")

    def initial(member: Member) -> Opinion:
        prompt = t_init.safe_substitute(
            member_name=member.name, member_title=member.title, match_brief=brief,
            base_model=base["detail"], market=market if member.sees_market else BLIND_MARKET, line=line,
        )
        return Opinion.from_dict(member.id, member.name, "initial", _ask(client, company, member, "initial", prompt, ctx))

    with ThreadPoolExecutor(max_workers=min(8, len(voters))) as ex:
        first = list(ex.map(initial, voters))

    # 2) 토론: 다른 사람의 첫 분석을 읽고 반박·수정
    t_deb = _template(company, "debate")

    def debate(pair: tuple[Member, Opinion]) -> Opinion:
        member, own = pair
        others = [o for o in first if o.member_id != member.id]
        prompt = t_deb.safe_substitute(
            member_name=member.name, member_title=member.title, match_brief=brief, market=market,
            own_opinion=own.short(), others="\n\n".join(o.short() for o in others) or "(동료 없음)", line=line,
        )
        d = _ask(client, company, member, "debate", prompt,
                 {**ctx, "own": own.to_dict(), "others": [o.to_dict() for o in others]})
        return Opinion.from_dict(member.id, member.name, "debate", d)

    with ThreadPoolExecutor(max_workers=min(8, len(voters))) as ex:
        final = list(ex.map(debate, zip(voters, first)))

    # 3) 가중 투표
    weights = ledger.weights(company, dept.id)
    one, ou = decide([o for o in final if o.member_id in voting], weights, company.policy, match.odds, m1, mou)
    decision = Decision(match_id=match.id, department=dept.id, one_x_two=one, over_under=ou, line=line, weights=weights)

    # 4) 팀장이 있으면 최종 코멘트
    lead = company.lead(dept.id)
    if lead:
        from .report import decision_text

        prompt = _template(company, "lead_summary").safe_substitute(
            member_name=lead.name, member_title=lead.title, match_title=match.title,
            decision=decision_text(decision), opinions="\n\n".join(o.short() for o in final),
        )
        d = _ask(client, company, lead, "lead", prompt, ctx)
        decision.headline = str(d.get("headline", ""))
        decision.comment = str(d.get("comment", ""))

    return AnalysisRun(match, decision, first, final, base, m1, mou, margin, getattr(client, "label", "unknown"))


def join_member(company: Company, run: dict, member: Member, client) -> tuple[Opinion, Opinion]:
    """이미 분석된 경기에 새 분석가 한 명의 1차 분석과 토론 의견을 더한다.
    팀 결론(투표 결과)은 바꾸지 않는다. 동료들의 1차 분석을 읽고 토론하는 것은 다른 사람과 같다."""
    mm = run["match"]
    match = Match(id=mm["id"], sport=mm["sport"], league=mm["league"], kickoff=mm["kickoff"],
                  home=mm["home"], away=mm["away"], odds=mm.get("odds") or {}, data=mm.get("data") or {})
    sport = get_sport(match.sport)
    line = float(run["decision"].get("line") or match.odds.get("line", 2.5))
    base = sport.base_model(match, line)
    m1, margin = implied_probs(match.odds, OUTCOMES)
    mou, _ = implied_probs(match.odds, OU)
    brief = sport.brief(match)
    market = _market_text(match, m1, margin, mou, line)
    ctx = {"base_probs": base["probs"], "base_over": base["over_prob"], "market_probs": m1, "odds": match.odds,
           "data": match.data}
    prompt = _template(company, "analysis").safe_substitute(
        member_name=member.name, member_title=member.title, match_brief=brief,
        base_model=base["detail"], market=market if member.sees_market else BLIND_MARKET, line=line,
    )
    own = Opinion.from_dict(member.id, member.name, "initial", _ask(client, company, member, "initial", prompt, ctx))
    others = [Opinion.from_dict(o["member_id"], o["member_name"], "initial", o)
              for o in run.get("initial", []) if o["member_id"] != member.id]
    prompt = _template(company, "debate").safe_substitute(
        member_name=member.name, member_title=member.title, match_brief=brief, market=market,
        own_opinion=own.short(), others="\n\n".join(o.short() for o in others) or "(동료 없음)", line=line,
    )
    d = _ask(client, company, member, "debate", prompt,
             {**ctx, "own": own.to_dict(), "others": [o.to_dict() for o in others]})
    return own, Opinion.from_dict(member.id, member.name, "debate", d)
