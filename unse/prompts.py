"""Haiku에게 보내는 지시문과 답 형식(도구 스키마).

AI는 등급을 정하지 않는다. ilgin.plan_day 가 정한 등급에 맞춰 문장만 쓴다.
"""
from __future__ import annotations

import json

from .ilgin import AGE_GROUP, GRADE

MODEL = "claude-haiku-5-5"

SYSTEM = """너는 한국 운세 사이트 "오늘의 운세"의 운세 작가다. 매일 띠별·별자리 운세를 쓴다.
이 사이트는 금전운과 행운운을 중심으로 본다.

글쓰기 규칙
- 한국어 존댓말 평서문으로 쓴다. 문장은 "~습니다", "~세요", "~예요" 같은 말로 끝내고 마침표를 찍는다.
- 한 문장은 15~60자 정도로 짧고 구체적으로 쓴다. 문장 수는 각 칸에 정해진 수를 정확히 지킨다.
- 주어진 등급에 어조를 맞춘다. 대길·길은 밝게, 평은 담담하게, 주의·조심은 겁주지 말고 조심할 점과 대처를 알려 준다.
- 금전운은 생활 속 돈 이야기로만 쓴다: 수입, 지출, 절약, 정산, 환급, 거래와 흥정, 부업, 물건 정리, 가계부, 빌려주기와 보증.
- 행운운은 기회, 귀인, 반가운 소식, 우연한 만남, 타이밍, 잃어버린 것 되찾기 같은 이야기로 쓴다.
- 나이대 조언은 그 나이대의 생활에 맞게 쓴다 (20대: 배움·첫인상·친구, 30~40대: 일과 가족의 균형, 50대 이상: 건강·가족·오랜 벗).
- 같은 날 다른 연도·다른 별자리와 문장이 겹치지 않게, 어제 쓴 문장도 되풀이하지 않는다.

절대 쓰지 않는 것
- 베팅, 배팅, 도박, 토토, 경마, 카지노, 복권, 로또, 주식, 코인, 가상화폐, 투자, 대박, 올인, 배당 같은 말과 그런 행동을 부추기는 내용.
  (이 사이트는 스포츠 분석 사이트와 연결되어 있어 특히 중요하다.)
- 구체적인 금액, 퍼센트, 날짜 약속. 질병 진단이나 치료법. 죽음, 사고, 이별을 단정하는 말. 정치·종교 이야기.
- 띠·별자리 이름이나 출생연도를 문장 안에 되풀이하는 것 (화면에 이미 있다).

답은 반드시 주어진 도구 하나로만 한다."""

DDI_TOOL = {
    "name": "save_ddi_fortune",
    "description": "한 띠의 오늘 운세(띠 요약 1문장과 출생연도별 금전운·행운운)를 저장한다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "이 띠의 오늘 금전·행운 흐름 1문장"},
            "years": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "y": {"type": "integer", "description": "출생연도 (주어진 값 그대로)"},
                        "money": {"type": "string", "description": "금전운 정확히 2문장"},
                        "luck": {"type": "string", "description": "행운운 정확히 1문장"},
                        "advice": {"type": "string", "description": "나이대에 맞는 조언 정확히 1문장"},
                    },
                    "required": ["y", "money", "luck", "advice"],
                },
            },
        },
        "required": ["summary", "years"],
    },
}

STAR_TOOL = {
    "name": "save_star_fortune",
    "description": "한 별자리의 오늘 운세를 저장한다.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "오늘 총평 정확히 2문장 (원소 성격을 살짝 반영)"},
            "money": {"type": "string", "description": "금전운 정확히 2문장"},
            "luck": {"type": "string", "description": "행운운 정확히 2문장"},
            "love": {"type": "string", "description": "애정운 정확히 1문장"},
            "health": {"type": "string", "description": "건강운 정확히 1문장"},
        },
        "required": ["summary", "money", "luck", "love", "health"],
    },
}


def _g(n: int) -> str:
    return f"{GRADE[n]}({n}/5)"


def ddi_prompt(day: dict, item: dict, prev: dict | None) -> str:
    lines = [
        f"날짜: {day['date']} ({day['weekday']}요일), 일진 {day['ilgin']['name']}일({day['ilgin']['hanja']}日)",
        f"띠: {item['animal']}띠",
        f"오늘 일진과의 관계: {item['relation_tag'] or '특별한 관계 없음'} — {item['relation_text']}",
        f"행운의 시간 {item['lucky']['time'][0]}({item['lucky']['time'][1]}), 행운의 색 {item['lucky']['color']}",
        "",
        "출생연도별로 아래 등급에 맞춰 써 주세요.",
    ]
    for y in item["years"]:
        lines.append(f"- {y['y']}년생 (만 {y['age']}세 전후, {AGE_GROUP[y['age_group']]}): 금전운 {_g(y['gm'])}, 행운운 {_g(y['gl'])}")
    if prev:
        lines += ["", "어제 이 띠에 쓴 문장 (되풀이하지 마세요):", json.dumps(prev, ensure_ascii=False)]
    return "\n".join(lines)


def star_prompt(day: dict, item: dict, prev: dict | None) -> str:
    sc = item["sc"]
    lines = [
        f"날짜: {day['date']} ({day['weekday']}요일)",
        f"별자리: {item['name']}자리 ({item['dates']}), {item['element']}의 별자리",
        f"등급: 총운 {_g(item['g'])}, 금전운 {_g(sc[0])}, 행운운 {_g(sc[1])}, 애정운 {_g(sc[2])}, 건강운 {_g(sc[3])}",
        f"행운의 시간 {item['lucky']['time'][0]}({item['lucky']['time'][1]}), 행운의 물건 {item['lucky']['item']}",
    ]
    if prev:
        lines += ["", "어제 이 별자리에 쓴 문장 (되풀이하지 마세요):", json.dumps(prev, ensure_ascii=False)]
    return "\n".join(lines)


def request_params(prompt: str, tool: dict, max_tokens: int) -> dict:
    return {
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": SYSTEM,
        "tools": [tool],
        "tool_choice": {"type": "tool", "name": tool["name"]},
        "messages": [{"role": "user", "content": prompt}],
    }
