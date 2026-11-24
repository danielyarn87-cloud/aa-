"""축구: xG 기반 포아송 득점 모델."""
from __future__ import annotations

from ..models import Match
from .base import SportModule, score_matrix, summarize_matrix


class Soccer(SportModule):
    name = "soccer"
    label = "축구"

    def expected_goals(self, match: Match) -> tuple[float, float]:
        """기대득점 계산. stats.basis 로 두 방식을 고른다.

        - "venue" (기본): 홈팀의 홈 경기 xG, 원정팀의 원정 경기 xG 를 쓴다.
          홈 기대득점 = 홈팀 홈 xG 득점 x 원정팀 원정 xG 실점 / 리그 평균 홈 득점
        - "overall": 시즌 전체 경기당 xG 를 쓰고, 홈 이점은 리그 평균 홈/원정 득점 비율로 넣는다.
          홈 기대득점 = (홈팀 xG 득점 / 리그 평균) x (원정팀 xG 실점 / 리그 평균) x 리그 평균 홈 득점
        """
        stats = match.data["stats"]
        avg = match.data.get("league_avg", {})
        lh = float(avg.get("home_goals", 1.5))
        la = float(avg.get("away_goals", 1.2))
        h, a = stats["home"], stats["away"]
        if stats.get("basis") == "overall":
            lall = float(avg.get("all_goals", (lh + la) / 2))
            lam_home = float(h["xg_for"]) / lall * float(a["xg_against"]) / lall * lh
            lam_away = float(a["xg_for"]) / lall * float(h["xg_against"]) / lall * la
        else:
            lam_home = float(h["xg_for"]) * float(a["xg_against"]) / lh
            lam_away = float(a["xg_for"]) * float(h["xg_against"]) / la
        return lam_home, lam_away

    def base_model(self, match: Match, line: float) -> dict:
        lam_h, lam_a = self.expected_goals(match)
        probs, over = summarize_matrix(score_matrix(lam_h, lam_a), line)
        detail = (
            f"예상 득점 {match.home} {lam_h:.2f} : {lam_a:.2f} {match.away}\n"
            f"승 {probs['home']:.1%} / 무 {probs['draw']:.1%} / 패 {probs['away']:.1%}\n"
            f"총 득점 {line} 오버 {over:.1%} / 언더 {1 - over:.1%}\n"
            "주의: 이 모델은 라인업, 동기, 일정, 전술 상성을 반영하지 않습니다. 무승부를 약간 과소평가하는 경향이 있습니다."
        )
        return {"probs": probs, "over_prob": over, "lambdas": (lam_h, lam_a), "detail": detail}
