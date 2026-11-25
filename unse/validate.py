"""AI가 쓴 글을 저장 전에 검사한다. 하나라도 걸리면 그 띠(또는 별자리)는 버리고,
화면은 미리 써 둔 문장 조합으로 대신 보여 준다."""
from __future__ import annotations

import re

BANNED = ["베팅", "배팅", "도박", "토토", "경마", "경륜", "카지노", "복권", "로또", "주식", "코인", "가상화폐",
          "암호화폐", "비트코인", "투자", "대박", "올인", "배당", "승부", "적중", "슬롯"]
MONEY_AMOUNT = re.compile(r"\d[\d,.]*\s*(만|억|천)?\s*원|\d+\s*%")
MARKUP = re.compile(r"[<>{}\[\]`#*_]|https?://")
SENT = re.compile(r"[^.!?]+[.!?]")


def sentences(text: str) -> list[str]:
    return [s.strip() for s in SENT.findall(text.strip())]


def check_text(text, n: int, label: str) -> list[str]:
    if not isinstance(text, str) or not text.strip():
        return [f"{label}: 비어 있음"]
    t = text.strip()
    errs = []
    ss = sentences(t)
    if len(ss) != n or "".join(ss).replace(" ", "") != t.replace(" ", ""):
        errs.append(f"{label}: {n}문장이어야 함 ({len(ss)}문장)")
    for s in ss:
        if not 8 <= len(s) <= 90:
            errs.append(f"{label}: 문장 길이 {len(s)}자")
    hit = [w for w in BANNED if w in t]
    if hit:
        errs.append(f"{label}: 금지어 {', '.join(hit)}")
    if MONEY_AMOUNT.search(t):
        errs.append(f"{label}: 금액·퍼센트")
    if MARKUP.search(t):
        errs.append(f"{label}: 기호·링크")
    return errs


def check_ddi(out: dict, item: dict) -> list[str]:
    errs = check_text(out.get("summary"), 1, "요약")
    years = out.get("years")
    want = [y["y"] for y in item["years"]]
    if not isinstance(years, list) or sorted(y.get("y") for y in years if isinstance(y, dict)) != sorted(want):
        return errs + [f"연도 목록이 다름 (필요: {want})"]
    for y in years:
        errs += check_text(y.get("money"), 2, f"{y['y']} 금전운")
        errs += check_text(y.get("luck"), 1, f"{y['y']} 행운운")
        errs += check_text(y.get("advice"), 1, f"{y['y']} 조언")
    allss = [s for y in years for k in ("money", "luck", "advice") for s in sentences(str(y.get(k, "")))]
    if len(allss) != len(set(allss)):
        errs.append("같은 문장이 되풀이됨")
    return errs


def check_star(out: dict) -> list[str]:
    errs = []
    for k, n, label in [("summary", 2, "총평"), ("money", 2, "금전운"), ("luck", 2, "행운운"), ("love", 1, "애정"), ("health", 1, "건강")]:
        errs += check_text(out.get(k), n, label)
    return errs
