"""경기, 분석가 의견, 회사 결론을 담는 자료형."""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

OUTCOMES = ("home", "draw", "away")
OU = ("over", "under")
CONFIDENCE = ("high", "medium", "low")

LABEL_1X2 = {"home": "홈승", "draw": "무승부", "away": "원정승"}
LABEL_OU = {"over": "오버", "under": "언더"}
LABEL_CONF = {"high": "높음", "medium": "보통", "low": "낮음"}


@dataclass
class Match:
    id: str
    sport: str
    league: str
    kickoff: str
    home: str
    away: str
    odds: dict
    data: dict  # 나머지 모든 자료 (통계, 라인업, 일정, 동기, 메모 등)

    @property
    def title(self) -> str:
        return f"{self.home} vs {self.away}"

    @classmethod
    def load(cls, path: str | Path) -> "Match":
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        core = {k: raw.pop(k) for k in ("id", "sport", "league", "kickoff", "home", "away", "odds")}
        return cls(**core, data=raw)


@dataclass
class Opinion:
    member_id: str
    member_name: str
    stage: str  # "initial" | "debate"
    probs: dict[str, float]
    pick_1x2: str
    over_prob: float
    pick_ou: str
    confidence: str
    key_reasons: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    summary: str = ""
    rebuttal: str = ""
    concession: str = ""
    changed: str = ""

    @classmethod
    def from_dict(cls, member_id: str, member_name: str, stage: str, d: dict) -> "Opinion":
        probs = {k: float(d["probs"][k]) for k in OUTCOMES}
        if any(p < 0 for p in probs.values()):
            raise ValueError("확률에 음수가 있습니다.")
        total = sum(probs.values())
        if total <= 0:
            raise ValueError("확률 합계가 0입니다.")
        probs = {k: v / total for k, v in probs.items()}  # 합계가 살짝 어긋나면 보정

        pick = str(d.get("pick_1x2", "")).strip().lower()
        if pick not in OUTCOMES:
            pick = max(probs, key=probs.get)
        over = min(max(float(d["over_prob"]), 0.0), 1.0)
        pick_ou = str(d.get("pick_ou", "")).strip().lower()
        if pick_ou not in OU:
            pick_ou = "over" if over >= 0.5 else "under"
        conf = str(d.get("confidence", "medium")).strip().lower()
        if conf not in CONFIDENCE:
            conf = "medium"

        return cls(
            member_id=member_id,
            member_name=member_name,
            stage=stage,
            probs=probs,
            pick_1x2=pick,
            over_prob=over,
            pick_ou=pick_ou,
            confidence=conf,
            key_reasons=[str(x) for x in d.get("key_reasons", [])],
            risks=[str(x) for x in d.get("risks", [])],
            summary=str(d.get("summary", "")),
            rebuttal=str(d.get("rebuttal", "")),
            concession=str(d.get("concession", "")),
            changed=str(d.get("changed", "")),
        )

    def to_dict(self) -> dict:
        return asdict(self)

    def short(self) -> str:
        p = self.probs
        return (
            f"{self.member_name}: 승 {p['home']:.0%} / 무 {p['draw']:.0%} / 패 {p['away']:.0%} → "
            f"{LABEL_1X2[self.pick_1x2]}, 오버 {self.over_prob:.0%} → {LABEL_OU[self.pick_ou]}, "
            f"신뢰도 {LABEL_CONF[self.confidence]}\n  요약: {self.summary}\n  근거: " + " / ".join(self.key_reasons)
        )


@dataclass
class MarketDecision:
    market: str  # "1x2" | "over_under"
    pick: str | None  # None 이면 관망
    share: float  # 1위 선택지의 가중 득표율
    tally: str  # 예: "2:1:0"
    probs: dict[str, float]  # 가중 평균 확률
    market_probs: dict[str, float]
    edges: dict[str, float]  # 확률 x 배당 - 1
    value_pick: bool  # 픽이 기대값 기준을 넘는지
    value_alerts: list[str]  # 픽과 무관하게 기대값 기준을 넘는 선택지
    dissent: list[str]  # 소수 의견자 이름


@dataclass
class Decision:
    match_id: str
    department: str
    one_x_two: MarketDecision
    over_under: MarketDecision
    line: float
    weights: dict[str, float]
    headline: str = ""
    comment: str = ""


def extract_json(text: str) -> dict:
    """모델 답변에서 JSON 객체 하나를 꺼낸다 (코드블록이나 앞뒤 글이 섞여 있어도)."""
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fenced:
        text = fenced.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("답변에서 JSON 을 찾지 못했습니다.")
    return json.loads(text[start : end + 1])
