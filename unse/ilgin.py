"""날짜, 일진, 띠·별자리, 등급과 행운 값을 계산한다.

AI는 문장만 쓴다. 등급과 행운 값은 여기서 정해서 AI에게 넘기므로
등급과 내용이 어긋나지 않고, 같은 날이면 몇 번을 다시 만들어도 같은 값이 나온다.
"""
from __future__ import annotations

import datetime as dt
import random
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")

GAN = "갑을병정무기경신임계"
GANH = "甲乙丙丁戊己庚辛壬癸"
JI = "자축인묘진사오미신유술해"
JIH = "子丑寅卯辰巳午未申酉戌亥"
ANIMALS = ["쥐", "소", "호랑이", "토끼", "용", "뱀", "말", "양", "원숭이", "닭", "개", "돼지"]
STARS = [
    ("양", "3.21–4.19", "불"), ("황소", "4.20–5.20", "흙"), ("쌍둥이", "5.21–6.21", "공기"),
    ("게", "6.22–7.22", "물"), ("사자", "7.23–8.22", "불"), ("처녀", "8.23–9.23", "흙"),
    ("천칭", "9.24–10.22", "공기"), ("전갈", "10.23–11.22", "물"), ("사수", "11.23–12.24", "불"),
    ("염소", "12.25–1.19", "흙"), ("물병", "1.20–2.18", "공기"), ("물고기", "2.19–3.20", "물"),
]
GRADE = {5: "대길", 4: "길", 3: "평", 2: "주의", 1: "조심"}
COLORS = ["빨강", "주황", "노랑", "연두", "초록", "하늘색", "남색", "보라", "흰색", "검정", "금색", "분홍", "갈색", "회색"]
DIRS = ["동쪽", "서쪽", "남쪽", "북쪽", "동남쪽", "동북쪽", "서남쪽", "서북쪽"]
ITEMS = ["손수건", "머그컵", "이어폰", "책갈피", "향초", "접이식 우산", "손목시계", "수첩", "립밤", "열쇠고리", "목도리", "텀블러"]
SIJIN = [("묘시", "오전 5~7시"), ("진시", "오전 7~9시"), ("사시", "오전 9~11시"), ("오시", "오전 11시~오후 1시"),
         ("미시", "오후 1~3시"), ("신시", "오후 3~5시"), ("유시", "오후 5~7시"), ("술시", "오후 7~9시")]
AGE_GROUP = {"young": "20대", "middle": "30~40대", "senior": "50대 이상"}

SIX = [{0, 1}, {2, 11}, {3, 10}, {4, 9}, {5, 8}, {6, 7}]
TRI = [{8, 0, 4}, {11, 3, 7}, {2, 6, 10}, {5, 9, 1}]

# 20세 이상만, 띠마다 4개: (올해-67) ~ (올해-20)년생
MIN_AGE, YEARS_PER_ANIMAL = 20, 4


def today_kst() -> dt.date:
    return dt.datetime.now(KST).date()


def day_ganzhi(d: dt.date) -> int:
    """60갑자 번호 (0 = 갑자). 2000-01-01 = 54 (무오일)."""
    jdn = d.toordinal() + 1721425
    return (jdn + 49) % 60


def year_ganzhi(y: int) -> int:
    return (y - 4) % 60


def gz_name(i: int) -> str:
    return GAN[i % 10] + JI[i % 12]


def gz_hanja(i: int) -> str:
    return GANH[i % 10] + JIH[i % 12]


def birth_years(branch: int, year: int) -> list[int]:
    min_y = year - (MIN_AGE + 12 * YEARS_PER_ANIMAL - 1)
    first = min_y + (branch - (min_y - 4)) % 12
    return [first + 12 * k for k in range(YEARS_PER_ANIMAL)]


def age_group(age: int) -> str:
    return "young" if age <= 29 else "middle" if age <= 49 else "senior"


def relation(branch: int, day_branch: int, day_name: str) -> dict:
    dn = day_name + "일"
    animal = ANIMALS[branch]
    if branch == day_branch:
        return {"base": 3.1, "tag": "같은 기운", "text": f"{dn}은 {animal}띠와 같은 기운의 날이라, 내 페이스대로 가면 무난합니다."}
    if any({branch, day_branch} <= p for p in SIX):
        return {"base": 3.7, "tag": "육합(六合)", "text": f"{dn}과 육합을 이루어 사람 복이 따르는 날입니다."}
    if any({branch, day_branch} <= t for t in TRI):
        return {"base": 3.5, "tag": "삼합(三合)", "text": f"{dn}과 삼합으로 기운이 모여 일이 한 방향으로 풀립니다."}
    if (branch + 6) % 12 == day_branch:
        return {"base": 2.4, "tag": "충(沖)", "text": f"{dn}과 충이 들어 변동이 많으니 차분하게 움직이세요."}
    return {"base": 3.1, "tag": "", "text": f"{dn}과 큰 부딪힘이 없어 평소 흐름대로 이어집니다."}


def _clamp(g: float) -> int:
    return max(1, min(5, round(g)))


def _rng(*key) -> random.Random:
    return random.Random("|".join(str(k) for k in key))


def _lucky(r: random.Random, with_item: bool = False) -> dict:
    a, b = r.sample(range(1, 10), 2)
    out = {"time": list(r.choice(SIJIN)), "color": r.choice(COLORS)}
    if with_item:
        out.update(num=[a], item=r.choice(ITEMS))
    else:
        out.update(num=[a, b], dir=r.choice(DIRS))
    return out


def plan_day(d: dt.date) -> dict:
    """그날의 뼈대: 일진, 띠 12개(연도 4개씩, 금전·행운 등급), 별자리 12개(점수)."""
    gz = day_ganzhi(d)
    name = gz_name(gz)
    iso = d.isoformat()
    ddi = []
    for b in range(12):
        rel = relation(b, gz % 12, name)
        r0 = _rng(iso, "ddi", b)
        years = []
        for y in birth_years(b, d.year):
            r = _rng(iso, "y", y)
            age = d.year - y
            years.append({
                "y": y, "age": age, "age_group": age_group(age), "gz": gz_name(year_ganzhi(y)),
                "gm": _clamp(rel["base"] + (r.random() - 0.5) * 2.6),
                "gl": _clamp(rel["base"] + (r.random() - 0.5) * 2.6),
            })
        ddi.append({"branch": b, "animal": ANIMALS[b], "relation_tag": rel["tag"], "relation_text": rel["text"],
                    "lucky": _lucky(r0), "years": years})
    stars = []
    for i, (sname, dates, elem) in enumerate(STARS):
        r = _rng(iso, "star", i)
        sc = [_clamp(2.3 + r.random() * 2.9) for _ in range(4)]  # 금전, 행운, 애정, 건강
        stars.append({"idx": i, "name": sname, "dates": dates, "element": elem, "sc": sc,
                      "g": _clamp(sum(sc) / 4), "total": sc[0] + sc[1], "lucky": _lucky(r, with_item=True)})
    return {"date": iso, "weekday": "월화수목금토일"[d.weekday()],
            "ilgin": {"index": gz, "name": name, "hanja": gz_hanja(gz)},
            "year_gz": gz_name(year_ganzhi(d.year)), "ddi": ddi, "stars": stars}
