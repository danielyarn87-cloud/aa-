from __future__ import annotations

import json
import math
from abc import ABC, abstractmethod

from ..models import Match


class SportModule(ABC):
    name: str = ""
    label: str = ""

    @abstractmethod
    def base_model(self, match: Match, line: float) -> dict:
        """모든 분석가에게 똑같이 주는 기초 확률. {'probs': {...}, 'over_prob': x, 'detail': '...'}"""

    def brief(self, match: Match) -> str:
        """경기 자료를 분석가가 읽을 글로 바꾼다. 종목별로 덮어써도 된다."""
        lines = [
            f"- 경기: {match.home} (홈) vs {match.away} (원정)",
            f"- 리그: {match.league}",
            f"- 킥오프: {match.kickoff}",
        ]
        for key, value in match.data.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False, indent=2)
            lines.append(f"- {key}:\n{value}" if "\n" in str(value) else f"- {key}: {value}")
        return "\n".join(lines)


def poisson_pmf(k: int, lam: float) -> float:
    return math.exp(-lam) * lam**k / math.factorial(k)


def score_matrix(lam_home: float, lam_away: float, max_goals: int = 12) -> list[list[float]]:
    ph = [poisson_pmf(i, lam_home) for i in range(max_goals + 1)]
    pa = [poisson_pmf(j, lam_away) for j in range(max_goals + 1)]
    return [[ph[i] * pa[j] for j in range(max_goals + 1)] for i in range(max_goals + 1)]


def summarize_matrix(m: list[list[float]], line: float) -> tuple[dict[str, float], float]:
    home = draw = away = over = 0.0
    for i, row in enumerate(m):
        for j, p in enumerate(row):
            if i > j:
                home += p
            elif i == j:
                draw += p
            else:
                away += p
            if i + j > line:
                over += p
    total = home + draw + away
    return {"home": home / total, "draw": draw / total, "away": away / total}, over / total
