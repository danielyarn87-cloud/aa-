"""분석가의 두뇌: Claude API 클라이언트와, 키 없이 돌려 보는 모의 클라이언트."""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request

from .models import OUTCOMES

API_URL = "https://api.anthropic.com/v1/messages"


class ClaudeClient:
    """표준 라이브러리만으로 Claude Messages API 를 호출한다 (추가 설치 불필요)."""

    def __init__(self, model: str, api_key: str | None = None, max_tokens: int = 4000, timeout: int = 240):
        self.model = model
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise RuntimeError("ANTHROPIC_API_KEY 환경변수가 없습니다. 키 없이 시험하려면 --mock 을 쓰세요.")
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.label = f"Claude API ({model})"

    def complete(self, system: str, prompt: str, ctx: dict) -> str:
        model = ctx.get("model") or self.model
        payload = {
            "model": model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
        schema = ctx.get("schema")
        if schema:  # 답을 정해진 양식(도구 입력)으로만 받는다: 따옴표 등으로 형식이 깨지지 않음
            payload["tools"] = [{"name": "submit", "description": "분석 결과를 제출한다.", "input_schema": schema}]
            payload["tool_choice"] = {"type": "tool", "name": "submit"}
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "content-type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }
        for attempt in range(4):
            req = urllib.request.Request(API_URL, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                for b in data.get("content", []):
                    if b.get("type") == "tool_use":
                        return json.dumps(b.get("input", {}), ensure_ascii=False)
                return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise RuntimeError(f"Claude API 오류 {e.code}: {e.read().decode('utf-8', 'ignore')[:300]}") from e
        raise RuntimeError("Claude API 재시도 한도 초과")


# ---------------------------------------------------------------------------
# 재생 클라이언트: 미리 받아 둔 분석가 답변(JSON)을 그대로 돌려준다.
# API 를 쓸 수 없는 환경에서 사람이 받아 온 답을 넣거나, 지난 분석을 다시 돌려 볼 때 쓴다.
# 파일 형식: {"engine": "설명", "responses": {"<member_id>": {"initial": {...}, "debate": {...}}, ...}}
# ---------------------------------------------------------------------------

class ReplayClient:
    def __init__(self, path):
        from pathlib import Path

        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        self.responses = raw["responses"]
        self.label = raw.get("engine", "재생 실행")

    def complete(self, system: str, prompt: str, ctx: dict) -> str:
        try:
            return json.dumps(self.responses[ctx["member_id"]][ctx["stage"]], ensure_ascii=False)
        except KeyError as e:
            raise RuntimeError(f"재생 파일에 {ctx['member_id']} 의 {ctx['stage']} 답변이 없습니다.") from e


# ---------------------------------------------------------------------------
# 모의 클라이언트: API 없이 흐름 전체를 시험하기 위한 규칙 기반 흉내.
# 실제 분석 품질과는 무관하며, 리포트에 '모의 실행'으로 표시된다.
# ---------------------------------------------------------------------------

def _norm(p: dict[str, float]) -> dict[str, float]:
    p = {k: max(v, 0.01) for k, v in p.items()}
    t = sum(p.values())
    return {k: round(v / t, 3) for k, v in p.items()}


def _blend(a: dict, b: dict, w: float) -> dict:
    if not b:
        return dict(a)
    return {k: (1 - w) * a[k] + w * b[k] for k in OUTCOMES}


def _conf(p: dict) -> str:
    s = sorted(p.values(), reverse=True)
    gap = s[0] - s[1]
    return "high" if gap > 0.25 else "medium" if gap > 0.1 else "low"


def _jitter(key: str) -> float:
    return (int(hashlib.md5(key.encode()).hexdigest()[:4], 16) / 65535 - 0.5) * 0.02


LABEL = {"home": "홈승", "draw": "무승부", "away": "원정승"}


class MockClient:
    label = "모의 실행 (규칙 기반, 실제 AI 분석 아님)"

    def complete(self, system: str, prompt: str, ctx: dict) -> str:
        stage = ctx["stage"]
        if stage == "lead":
            return json.dumps({"headline": "모의 실행 결론", "comment": "모의 실행이므로 팀장 코멘트는 생략합니다."}, ensure_ascii=False)
        style = ctx["member_id"] if ctx["member_id"] in ("kim_data", "park_field", "lee_contra") else "neutral"
        if stage == "initial":
            out = self._initial(style, ctx)
        else:
            out = self._debate(style, ctx)
        return json.dumps(out, ensure_ascii=False)

    def _pick(self, style: str, p: dict, ctx: dict) -> str:
        if style == "lee_contra":
            odds = ctx["odds"]
            edges = {k: p[k] * float(odds[k]) - 1 for k in OUTCOMES if odds.get(k)}
            best = max(edges, key=edges.get) if edges else None
            if best and edges[best] > 0.03:
                return best
        return max(p, key=p.get)

    def _initial(self, style: str, ctx: dict) -> dict:
        b, m, data = ctx["base_probs"], ctx["market_probs"], ctx["data"]
        over = ctx["base_over"]
        lineup = data.get("lineup", {})
        sched = data.get("schedule", {})
        if style == "kim_data":
            p = _blend(b, m, 0.25)
            reasons = [
                f"기초 모델 승 {b['home']:.0%} / 무 {b['draw']:.0%} / 패 {b['away']:.0%}를 기준으로 시장 확률을 25% 섞었습니다.",
                "최근 10경기 성적보다 시즌 xG 득실을 더 신뢰합니다.",
                f"득점 모델 기준 오버 확률은 {over:.0%}입니다.",
            ]
            summary = "숫자상 우위는 분명합니다. 다만 그 우위만큼만 확률을 드립니다."
        elif style == "park_field":
            adj = 0.03 * (len(lineup.get("away_absent", [])) - len(lineup.get("home_absent", [])))
            if sched.get("home_days_rest", 7) <= 3:
                adj -= 0.03
            p = dict(b)
            p["home"] += adj
            p["away"] -= adj
            over = over - 0.02 * len(lineup.get("home_absent", []))
            reasons = [
                f"결장자 수 홈 {len(lineup.get('home_absent', []))}명, 원정 {len(lineup.get('away_absent', []))}명을 반영해 홈 확률을 {adj:+.0%} 조정했습니다.",
                f"홈팀 휴식일 {sched.get('home_days_rest', '자료 없음')}일로 로테이션 가능성이 있습니다.",
                "주 득점원 결장은 오버 확률을 낮춥니다.",
            ]
            summary = "라인업이 바뀌면 다른 팀입니다. 이번 경기는 숫자보다 스쿼드를 봐야 합니다."
        elif style == "lee_contra":
            p = _blend(b, m, 0.5)
            fav = max(m or b, key=(m or b).get)
            if fav != "draw":
                dog = "away" if fav == "home" else "home"
                p[fav] -= 0.07
                p["draw"] += 0.05
                p[dog] += 0.02
            over -= 0.04
            reasons = [
                f"시장은 {LABEL[fav]}에 {(m or b)[fav]:.0%}를 주고 있습니다. 정배치고 너무 낮은 배당입니다.",
                "일정 과밀과 동기 차이를 보면 무승부 가능성이 시장 생각보다 큽니다.",
                "정배가 일찍 골을 못 넣으면 경기가 닫힐 수 있습니다.",
            ]
            summary = "다들 정배를 보는데, 이 배당이면 정배를 사는 건 손해입니다."
        else:
            p = _blend(b, m, 0.4)
            reasons = ["기초 모델과 시장 확률을 섞었습니다."]
            summary = "중립적 판단입니다."
        p = {k: v + _jitter(ctx["member_id"] + k) for k, v in p.items()}
        p = _norm(p)
        over = round(min(max(over + _jitter(ctx["member_id"] + "ou"), 0.05), 0.95), 3)
        return {
            "probs": p,
            "pick_1x2": self._pick(style, p, ctx),
            "over_prob": over,
            "pick_ou": "over" if over >= 0.5 else "under",
            "confidence": _conf(p),
            "key_reasons": reasons,
            "risks": ["모의 실행: 실제 분석이 아닙니다."],
            "summary": summary,
        }

    def _debate(self, style: str, ctx: dict) -> dict:
        own = ctx["own"]
        others = ctx["others"]
        move = 0.15 if style == "lee_contra" else 0.3
        mean = {k: sum(o["probs"][k] for o in others) / len(others) for k in OUTCOMES} if others else own["probs"]
        p = _norm(_blend(own["probs"], mean, move))
        o_over = sum(o["over_prob"] for o in others) / len(others) if others else own["over_prob"]
        over = round((1 - move) * own["over_prob"] + move * o_over, 3)
        target = others[0]["member_name"] if others else "동료"
        out = self._initial(style, ctx)
        out.update(
            {
                "rebuttal": f"{target}의 의견은 일부 동의하지만 근거의 크기만큼만 반영해야 합니다.",
                "concession": "동료가 지적한 변수를 일부 반영했습니다.",
                "changed": f"동료 의견 쪽으로 확률을 {int(move * 100)}% 이동했습니다.",
                "probs": p,
                "pick_1x2": self._pick(style, p, ctx),
                "over_prob": over,
                "pick_ou": "over" if over >= 0.5 else "under",
                "confidence": _conf(p),
            }
        )
        return out
