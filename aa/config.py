"""회사 조직도(company.yaml) 읽기.

인원·부서는 전부 설정 파일에서 오며, 코드는 몇 명이든 몇 개 부서든 그대로 동작한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Policy:
    consensus_share: float = 0.5
    value_threshold: float = 0.05
    min_samples_for_weight: int = 30
    weight_bounds: tuple[float, float] = (0.5, 2.0)


@dataclass
class Department:
    id: str
    name: str
    sport: str | None
    active: bool = True
    markets: list[str] = field(default_factory=lambda: ["1x2", "over_under"])
    over_under_line: float = 2.5


@dataclass
class Member:
    id: str
    name: str
    title: str
    department: str
    role: str
    persona_path: Path
    base_weight: float = 1.0
    active: bool = True
    votes: bool = True
    model: str | None = None
    color: str | None = None
    former_names: list = field(default_factory=list)  # 예전 이름 (화면에서 지금 이름으로 바꿔 보여 줌)
    sees_market: bool = False  # 1차(독립) 분석 때 배당을 볼지. 기본은 가림 (시장 숫자에 끌려가지 않게)

    def persona(self) -> str:
        return self.persona_path.read_text(encoding="utf-8")


@dataclass
class Company:
    name: str
    model: str
    policy: Policy
    departments: dict[str, Department]
    members: list[Member]
    base_dir: Path
    data_sources: dict = field(default_factory=dict)
    automation: dict = field(default_factory=dict)

    def department(self, dept_id: str) -> Department:
        if dept_id not in self.departments:
            raise KeyError(f"부서 '{dept_id}' 가 조직도에 없습니다.")
        return self.departments[dept_id]

    def department_for_sport(self, sport: str) -> Department:
        found = [d for d in self.departments.values() if d.sport == sport and d.active]
        if not found:
            raise KeyError(f"'{sport}' 를 맡는 활성 부서가 없습니다. company.yaml 을 확인하세요.")
        return found[0]

    def analysts(self, dept_id: str) -> list[Member]:
        """분석·토론·배팅에 참여하는 사람 (투표하지 않는 비교용 분석가 포함)."""
        return [m for m in self.members if m.department == dept_id and m.active and m.role == "analyst"]

    def voters(self, dept_id: str) -> list[Member]:
        return [m for m in self.members if m.department == dept_id and m.active and m.votes]

    def lead(self, dept_id: str) -> Member | None:
        leads = [m for m in self.members if m.department == dept_id and m.active and m.role == "lead"]
        return leads[0] if leads else None

    def member(self, member_id: str) -> Member:
        for m in self.members:
            if m.id == member_id:
                return m
        raise KeyError(member_id)


def load_company(path: str | Path) -> Company:
    path = Path(path).resolve()
    base = path.parent
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))

    pol = raw.get("policy", {}) or {}
    policy = Policy(
        consensus_share=float(pol.get("consensus_share", 0.5)),
        value_threshold=float(pol.get("value_threshold", 0.05)),
        min_samples_for_weight=int(pol.get("min_samples_for_weight", 30)),
        weight_bounds=tuple(pol.get("weight_bounds", [0.5, 2.0])),
    )

    departments: dict[str, Department] = {}
    for d in raw.get("departments", []) or []:
        if d["id"] in departments:
            raise ValueError(f"부서 id 중복: {d['id']}")
        departments[d["id"]] = Department(
            id=d["id"],
            name=d.get("name", d["id"]),
            sport=d.get("sport"),
            active=bool(d.get("active", True)),
            markets=list(d.get("markets", ["1x2", "over_under"])),
            over_under_line=float(d.get("over_under_line", 2.5)),
        )

    members: list[Member] = []
    seen: set[str] = set()
    for m in raw.get("members", []) or []:
        if m["id"] in seen:
            raise ValueError(f"직원 id 중복: {m['id']}")
        seen.add(m["id"])
        if m["department"] not in departments:
            raise ValueError(f"{m['name']} 의 부서 '{m['department']}' 가 departments 에 없습니다.")
        persona_path = (base / m["persona"]).resolve()
        if m.get("active", True) and not persona_path.exists():
            raise FileNotFoundError(f"{m['name']} 의 페르소나 파일이 없습니다: {persona_path}")
        role = m.get("role", "analyst")
        members.append(
            Member(
                id=m["id"],
                name=m["name"],
                title=m.get("title", ""),
                department=m["department"],
                role=role,
                persona_path=persona_path,
                base_weight=float(m.get("base_weight", 1.0)),
                active=bool(m.get("active", True)),
                votes=bool(m.get("votes", role == "analyst")),
                model=m.get("model"),
                color=m.get("color"),
                sees_market=bool(m.get("sees_market", False)),
                former_names=list(m.get("former_names") or []),
            )
        )

    co = raw.get("company", {}) or {}
    return Company(
        name=co.get("name", "AA"),
        model=co.get("model", "claude-sonnet-5-5"),
        policy=policy,
        departments=departments,
        members=members,
        base_dir=base,
        data_sources=raw.get("data_sources", {}) or {},
        automation=raw.get("automation", {}) or {},
    )
