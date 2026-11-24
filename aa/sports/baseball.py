"""야구: 확장 예정 자리.

구현 방향
- 기대 득점: 선발투수(FIP, 이닝 소화), 불펜 소모(최근 3일 투구 수), 타선(wRC+), 구장 보정
- 언더/오버: 총 득점 분포 (포아송보다 분산이 큰 음이항 분포가 더 잘 맞음)
- KBO 는 무승부가 있으므로 승무패 확률을 함께 낸다
"""
from __future__ import annotations

from ..models import Match
from .base import SportModule


class Baseball(SportModule):
    name = "baseball"
    label = "야구"

    def base_model(self, match: Match, line: float) -> dict:
        raise NotImplementedError("야구 모듈은 준비 중입니다. company.yaml 의 baseball 부서도 아직 비활성입니다.")
