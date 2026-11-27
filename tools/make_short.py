"""분석 보고서(reports/<id>.json)로 세로 쇼츠(1080x1920, 30fps, 약 16초)를 만든다.

사용: python tools/make_short.py reports/AF-1557484.json out.mp4
- 선수 사진·구단 로고·음악 없음(저작권). 팀 이름 글자와 색 도형만.
- 배팅 표현 없음: '예측'·'확률'만.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import tempfile
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1080, 1920, 30
PITCH = (13, 92, 53)
PITCH_D = (6, 52, 30)
GOLD = (245, 197, 24)
CHALK = (244, 241, 232)
MUTED = (178, 200, 186)
RED = (225, 29, 46)
INK = (16, 24, 20)

FONT_DIR = "/usr/share/fonts/opentype/noto/"
SITE = "raise-fulltime.com"
# 쇼츠·릴스 화면에서 오른쪽 버튼과 아래 설명 글이 덮는 곳을 피한다
LEFT, RIGHT, TOP, BOTTOM = 80, W - 150, 230, H - 380

ANALYST_STYLE = {"고광렬": "강팀 신뢰형", "고니": "라인업 중시형", "아귀": "변수 추구형", "호구": "상식형", "호구형": "상식형"}


FALLBACK = {"Black": "Bold", "Medium": "Regular"}   # GitHub Actions(fonts-noto-cjk)엔 Regular·Bold 만 있음


@lru_cache(None)
def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    for w in (weight, FALLBACK.get(weight, weight)):
        path = FONT_DIR + f"NotoSansCJK-{w}.ttc"
        if os.path.exists(path):
            return ImageFont.truetype(path, size, index=1)
    raise SystemExit("한글 글꼴(Noto Sans CJK)이 없습니다: sudo apt-get install fonts-noto-cjk")


def ease(p: float) -> float:
    p = max(0.0, min(1.0, p))
    return 1 - (1 - p) ** 3


def prog(t: float, start: float, dur: float = 0.45) -> float:
    return ease((t - start) / dur)


# ---------- 그림 조각(스프라이트) ----------
@lru_cache(None)
def text_sprite(text: str, weight: str, size: int, color: tuple) -> Image.Image:
    f = font(weight, size)
    l, t, r, b = f.getbbox(text)
    im = Image.new("RGBA", (r - l + 4, b - t + 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((2 - l, 2 - t), text, font=f, fill=color)
    return im


def fit_size(text: str, weight: str, size: int, maxw: int) -> int:
    while size > 20 and font(weight, size).getlength(text) > maxw:
        size -= 2
    return size


def wrap(text: str, weight: str, size: int, maxw: int, max_lines: int = 2) -> list[str]:
    """어절 단위 줄바꿈(글자 중간에서 자르지 않음)."""
    f = font(weight, size)
    words, lines, cur = text.split(), [], ""
    for w in words:
        nxt = (cur + " " + w).strip()
        if f.getlength(nxt) <= maxw:
            cur = nxt
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        while f.getlength(lines[-1] + "…") > maxw and " " in lines[-1]:
            lines[-1] = lines[-1].rsplit(" ", 1)[0]
        lines[-1] = lines[-1].rstrip(".,") + "…"
    return lines


def put(base: Image.Image, spr: Image.Image, x: int, y: int, alpha: float = 1.0, anchor: str = "l") -> None:
    if alpha <= 0.01:
        return
    if anchor == "c":
        x -= spr.width // 2
    elif anchor == "r":
        x -= spr.width
    if alpha < 0.99:
        spr = spr.copy()
        a = spr.getchannel("A").point(lambda v: int(v * alpha))
        spr.putalpha(a)
    base.alpha_composite(spr, (int(x), int(y)))


def text(base, s, weight, size, color, x, y, alpha=1.0, anchor="l", rise=0.0):
    put(base, text_sprite(s, weight, size, color), x, y + rise, alpha, anchor)


def rrect(base, box, r, fill, alpha=1.0):
    if alpha <= 0.01:
        return
    x0, y0, x1, y1 = [int(v) for v in box]
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    layer = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    c = fill if len(fill) == 4 else fill + (255,)
    c = c[:3] + (int(c[3] * alpha),)
    ImageDraw.Draw(layer).rounded_rectangle((0, 0, x1 - x0 - 1, y1 - y0 - 1), min(r, (y1 - y0) // 2), fill=c)
    base.alpha_composite(layer, (x0, y0))


@lru_cache(None)
def logo(size: int) -> Image.Image:
    """logo.svg(초록 사각형 + 금색 왕관 + R)을 그대로 따라 그림."""
    s = size / 100
    big = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    k = 4 * s
    d.rounded_rectangle((4 * k, 4 * k, 96 * k, 96 * k), 22 * k, fill=PITCH + (255,), outline=GOLD + (255,), width=int(2 * k))
    crown = [(31, 40), (28, 24), (38, 32), (50, 19), (62, 32), (72, 24), (69, 40)]
    d.polygon([(x * k, y * k) for x, y in crown], fill=GOLD + (255,))
    f = font("Black", int(52 * k))
    d.text((50 * k, 64 * k), "R", font=f, fill=CHALK + (255,), anchor="mm")
    return big.resize((size, size), Image.LANCZOS)


@lru_cache(None)
def background() -> Image.Image:
    bg = Image.new("RGBA", (W, H), PITCH_D + (255,))
    grad = Image.linear_gradient("L").resize((W, H))
    top = Image.new("RGBA", (W, H), PITCH + (255,))
    bg = Image.composite(bg, top, grad)
    lines = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(lines)
    line = (255, 255, 255, 22)
    # 경기장 선(은은하게)
    d.rectangle((40, 40, W - 40, H - 40), outline=line, width=4)
    d.line((40, H // 2, W - 40, H // 2), fill=line, width=4)
    d.ellipse((W // 2 - 220, H // 2 - 220, W // 2 + 220, H // 2 + 220), outline=line, width=4)
    d.rectangle((W // 2 - 300, 40, W // 2 + 300, 330), outline=line, width=4)
    d.rectangle((W // 2 - 300, H - 330, W // 2 + 300, H - 40), outline=line, width=4)
    bg.alpha_composite(lines)
    # 잔디 줄무늬
    stripes = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stripes)
    for i in range(0, H, 240):
        sd.rectangle((0, i, W, i + 120), fill=(255, 255, 255, 7))
    bg.alpha_composite(stripes)
    return bg


# ---------- 데이터 ----------
def first_sentence(s: str) -> str:
    s = s.strip()
    m = re.match(r"(.+?(?:다|요)\.)", s)
    return (m.group(1) if m else s).strip()


def kickoff_label(k: str) -> str:
    m = re.match(r"(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})", k)
    if not m:
        return k
    import datetime as dt
    y, mo, d, hh, mm = map(int, m.groups())
    wd = "월화수목금토일"[dt.date(y, mo, d).weekday()]
    return f"{mo}/{d} ({wd}) {hh:02d}:{mm:02d}"


def league_label(s: str) -> str:
    return re.split(r"\s+(Regular|Round|Championship|Relegation|\d)", s)[0].strip()


def load(path: str) -> dict:
    d = json.load(open(path, encoding="utf-8"))
    m, dec = d["match"], d["decision"]
    one, ou = dec["one_x_two"], dec["over_under"]
    home, away = m["home"], m["away"]
    names = {"home": f"{home} 승", "draw": "무승부", "away": f"{away} 승"}
    p = one["probs"]
    order = sorted(p, key=p.get, reverse=True)
    gap = p[order[0]] - p[order[1]]
    if gap < 0.03:
        verdict = "초박빙"
        sub = f"{names[one['pick']]} 쪽이 아주 근소하게 앞서요"
    elif gap < 0.10:
        verdict = names[one["pick"]]
        sub = "근소하게 앞서요"
    else:
        verdict = names[one["pick"]]
        sub = "우세로 봐요"
    analysts = []
    first = {x.get("member_name"): x.get("pick_1x2") for x in d.get("initial", [])}
    for s in d["final"]:
        nm = s["member_name"]
        fk = first.get(nm) or s["pick_1x2"]
        analysts.append({
            "first": names.get(fk, names[s["pick_1x2"]]),
            "first_key": fk,
            "name": nm.replace("호구형", "호구"),
            "style": ANALYST_STYLE.get(nm, ""),
            "pick": names[s["pick_1x2"]],
            "pick_key": s["pick_1x2"],
            "ou": "2.5골 오버" if s.get("pick_ou") == "over" else "2.5골 언더",
            "line": first_sentence(s.get("summary", "")),
        })
    ou_pick = ou["pick"]
    ou_prob = ou["probs"][ou_pick]
    agree = sum(1 for a in d["final"] if a.get("pick_ou") == ou_pick)
    # 골 이유: 같은 쪽을 고른 분석가들의 이유 문장 중 실점·골 이야기(개인 % 숫자 없는 것 먼저)
    sents = [sent.strip() for s in d["final"] if s.get("pick_ou") == ou_pick
             for r in s.get("key_reasons", []) for sent in re.findall(r".+?(?:다|요)\.|.+$", r)]
    goal_reason = ""
    for pat in (r"^(?!.*%).*(실점|\d골)", r"^(?!.*%).*골", r"골"):
        hit = [x for x in sents if re.search(pat, x)]
        if hit:
            goal_reason = hit[0]
            break
    return {
        "league": league_label(m.get("league", "")),
        "kickoff": kickoff_label(m.get("kickoff", "")),
        "home": home, "away": away,
        "probs": [(names["home"], p["home"], "home"), ("무승부", p["draw"], "draw"), (names["away"], p["away"], "away")],
        "pick": one["pick"], "verdict": verdict, "sub": sub, "tally": one.get("tally", ""),
        "analysts": analysts,
        "ou_label": "2.5골 오버" if ou_pick == "over" else "2.5골 언더",
        "ou_desc": "3골 이상" if ou_pick == "over" else "2골 이하",
        "ou_prob": ou_prob, "ou_agree": agree, "ou_total": len(d["final"]),
        "goal_reason": goal_reason,
    }


# ---------- 장면 ----------
def header(img, D, t, a=1.0):
    put(img, logo(84), LEFT, 110, a)
    text(img, "RAISE 분석팀", "Black", 40, CHALK, LEFT + 104, 118, a)
    text(img, f"{D['league']} · {D['kickoff']}", "Medium", 28, MUTED, LEFT + 104, 168, a)


def scene_title(img, D, t):
    a = prog(t, 0.0, 0.5)
    put(img, logo(220), W // 2, 300 - 40 * (1 - a), a, "c")
    b = prog(t, 0.25)
    text(img, "RAISE 분석팀 예측", "Black", 64, GOLD, W // 2, 580 + 30 * (1 - b), b, "c")
    c = prog(t, 0.5)
    text(img, D["league"], "Bold", 40, MUTED, W // 2, 700 + 30 * (1 - c), c, "c")
    maxw = RIGHT - LEFT
    for i, (nm, y) in enumerate(((D["home"], 820), (D["away"], 1080))):
        e = prog(t, 0.7 + i * 0.25)
        sz = fit_size(nm, "Black", 104, maxw)
        dx = (-1 if i == 0 else 1) * 120 * (1 - e)
        text(img, nm, "Black", sz, CHALK, W // 2 + dx, y, e, "c")
    v = prog(t, 0.95, 0.35)
    if v > 0:
        r = int(70 * (0.6 + 0.4 * v))
        rrect(img, (W // 2 - r, 1000 - r * 0.55, W // 2 + r, 1000 + r * 0.55), 40, GOLD, v)
        text(img, "VS", "Black", 56, INK, W // 2, 966, v, "c")
    k = prog(t, 1.3)
    rrect(img, (W // 2 - 260, 1300, W // 2 + 260, 1390), 45, (0, 0, 0, 90), k)
    text(img, f"킥오프 {D['kickoff']}", "Bold", 40, CHALK, W // 2, 1318, k, "c")


def scene_probs(img, D, t):
    header(img, D, t)
    a = prog(t, 0.0)
    text(img, "승무패 예측", "Black", 76, CHALK, LEFT, 330 + 30 * (1 - a), a)
    text(img, "분석팀 평균 확률", "Medium", 34, MUTED, LEFT, 438, a)
    y0, bh, gap = 560, 150, 60
    maxw = RIGHT - LEFT
    top = max(p for _, p, _ in D["probs"])
    for i, (label, p, key) in enumerate(D["probs"]):
        y = y0 + i * (bh + gap + 50)
        e = prog(t, 0.3 + i * 0.18, 0.4)
        text(img, label, "Bold", fit_size(label, "Bold", 44, maxw - 200), CHALK, LEFT, y, e)
        g = prog(t, 0.55 + i * 0.18, 0.9)
        rrect(img, (LEFT, y + 70, RIGHT, y + 70 + bh - 40), 26, (0, 0, 0, 80), e)
        col = GOLD if key == D["pick"] else (CHALK if key != "draw" else MUTED)
        if abs(p - top) < 0.005 and key != D["pick"]:
            col = CHALK
        w = int(maxw * p / max(top, 0.01) * 0.92 * g)
        rrect(img, (LEFT, y + 70, LEFT + max(w, 0), y + 70 + bh - 40), 26, col, e)
        pct = f"{p * 100 * g:.0f}%"
        text(img, pct, "Black", 64, INK if w > 260 else CHALK, LEFT + max(w, 0) - 24 if w > 260 else LEFT + w + 20, y + 78, e, "r" if w > 260 else "l")
    v = prog(t, 1.9, 0.5)
    yb = y0 + 3 * (bh + gap + 50) + 10
    rrect(img, (LEFT, yb, RIGHT, yb + 210), 30, GOLD, v)
    text(img, "분석팀 결론", "Bold", 34, INK, LEFT + 40, yb + 26, v)
    vs = fit_size(D["verdict"], "Black", 70, RIGHT - LEFT - 80)
    text(img, D["verdict"], "Black", vs, INK, LEFT + 40, yb + 76, v)
    text(img, D["sub"], "Medium", 32, INK, LEFT + 40, yb + 76 + vs + 14, v) if vs < 70 else None
    s = prog(t, 2.3)
    text(img, D["sub"], "Bold", 38, CHALK, LEFT, yb + 240, s)


def pill(img, label, x, y, size, bg, fg, alpha):
    """글자 들어간 둥근 칸. 오른쪽 끝 x 좌표를 돌려줌."""
    w = font("Black", size).getlength(label) + 36
    h = size + 26
    rrect(img, (x, y, x + w, y + h), h // 2, bg, alpha)
    text(img, label, "Black", size, fg, x + w / 2, y + 7, alpha, "c")
    return x + w


def scene_analysts(img, D, t):
    header(img, D, t)
    a = prog(t, 0.0)
    text(img, f"분석가 {len(D['analysts'][:4])}명의 선택", "Black", 72, CHALK, LEFT, 330 + 30 * (1 - a), a)
    text(img, "처음 → 토론 뒤 최종", "Medium", 30, MUTED, LEFT, 420 + 30 * (1 - a), a)
    y, ch, gap = 480, 252, 16
    cw = RIGHT - LEFT
    for i, an in enumerate(D["analysts"][:4]):
        e = prog(t, 0.25 + i * 0.32, 0.45)
        yy = y + i * (ch + gap)
        dx = 80 * (1 - e)
        rrect(img, (LEFT + dx, yy, RIGHT + dx, yy + ch), 28, (0, 0, 0, 95), e)
        text(img, an["name"], "Black", 44, CHALK, LEFT + 32 + dx, yy + 20, e)
        nw = font("Black", 44).getlength(an["name"])
        text(img, an["style"], "Medium", 26, MUTED, LEFT + 32 + nw + 16 + dx, yy + 36, e)
        # 처음 → 최종 (바뀌었으면 최종 칸을 형광펜처럼 노란색)
        changed = an["first_key"] != an["pick_key"]
        avail = cw - 64 - 150
        sz = 32
        while sz > 20 and (font("Black", sz).getlength(an["first"]) + font("Black", sz).getlength(an["pick"]) + 72 + 56) > avail:
            sz -= 2
        x = LEFT + 32 + dx
        py = yy + 88
        text(img, "처음", "Medium", 24, MUTED, x, py + 12, e)
        x = pill(img, an["first"], x + 58, py, sz, (255, 255, 255, 40), CHALK, e)
        text(img, "→", "Black", 34, GOLD if changed else MUTED, x + 14, py + 8, e)
        x += 56
        text(img, "최종", "Medium", 24, MUTED, x, py + 12, e)
        x = pill(img, an["pick"], x + 58, py, sz, GOLD if changed else CHALK, INK, e)
        if changed:
            text(img, "바뀜", "Black", 24, GOLD, x + 12, py + 14, e)
        lines = wrap(an["line"], "Medium", 29, cw - 64, 2)
        for j, ln in enumerate(lines):
            text(img, ln, "Medium", 29, CHALK, LEFT + 32 + dx, yy + 162 + j * 42, e)


def scene_goals(img, D, t):
    header(img, D, t)
    a = prog(t, 0.0)
    text(img, "골은 몇 골?", "Black", 76, CHALK, LEFT, 330 + 30 * (1 - a), a)
    b = prog(t, 0.3, 0.6)
    text(img, D["ou_label"], "Black", 70, GOLD, LEFT, 500, b)
    text(img, f"({D['ou_desc']})", "Bold", 40, MUTED, LEFT + font("Black", 70).getlength(D["ou_label"]) + 20, 528, b)
    n = D["ou_prob"] * 100 * prog(t, 0.4, 1.0)
    text(img, f"{n:.0f}%", "Black", 250, CHALK, LEFT - 10, 600, b)
    # 원형 게이지
    g = prog(t, 0.4, 1.0)
    cx, cy, r = RIGHT - 100, 790, 100
    ring = Image.new("RGBA", (r * 2 + 40, r * 2 + 40), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    rd.ellipse((20, 20, 20 + 2 * r, 20 + 2 * r), outline=(0, 0, 0, 110), width=28)
    if g > 0:
        rd.arc((20, 20, 20 + 2 * r, 20 + 2 * r), -90, -90 + 360 * D["ou_prob"] * g, fill=GOLD + (255,), width=28)
    put(img, ring, cx - r - 20, cy - r - 20, b)
    c = prog(t, 1.2)
    msg = f"분석가 {D['ou_total']}명 중 {D['ou_agree']}명이 같은 선택"
    if D["ou_agree"] == D["ou_total"]:
        msg = f"분석가 {D['ou_total']}명 모두 같은 선택"
    rrect(img, (LEFT, 1030, RIGHT, 1130), 50, (0, 0, 0, 95), c)
    text(img, msg, "Bold", fit_size(msg, "Bold", 42, RIGHT - LEFT - 60), CHALK, (LEFT + RIGHT) // 2, 1052, c, "c")
    d = prog(t, 1.6)
    if D["goal_reason"]:
        text(img, "이유", "Black", 40, GOLD, LEFT, 1190, d)
        for j, ln in enumerate(wrap(D["goal_reason"], "Medium", 40, RIGHT - LEFT, 3)):
            text(img, ln, "Medium", 40, CHALK, LEFT, 1250 + j * 60, d)


def scene_end(img, D, t):
    a = prog(t, 0.0, 0.5)
    put(img, logo(200), W // 2, 380 - 30 * (1 - a), a, "c")
    b = prog(t, 0.25)
    text(img, "전체 분석은", "Bold", 52, MUTED, W // 2, 660, b, "c")
    c = prog(t, 0.45)
    sz = fit_size(SITE, "Black", 92, RIGHT - LEFT + 40)
    text(img, SITE, "Black", sz, GOLD, W // 2, 740, c, "c")
    d = prog(t, 0.7)
    text(img, "경기 끝나면 적중 결과도 올려요", "Bold", 44, CHALK, W // 2, 900, d, "c")
    e = prog(t, 1.0)
    rrect(img, (LEFT, 1080, W - LEFT, 1260), 28, (0, 0, 0, 100), e)
    text(img, "예측은 참고용이에요. 맹신하지 마세요.", "Bold", 38, CHALK, W // 2, 1110, e, "c")
    text(img, "도박 문제 상담 국번 없이 1336", "Medium", 32, MUTED, W // 2, 1180, e, "c")


SCENES = [
    ("title", scene_title, 2.8),
    ("probs", scene_probs, 4.2),
    ("analysts", scene_analysts, 4.6),
    ("goals", scene_goals, 3.6),
    ("end", scene_end, 3.0),
]
FADE = 0.2  # 장면 끝 0.2초 어둡게(다음 장면으로 자연스럽게)


def frame(fn, D, t, dur) -> Image.Image:
    img = background().copy()
    fn(img, D, t)
    if t > dur - FADE:
        k = (t - (dur - FADE)) / FADE
        img.alpha_composite(Image.new("RGBA", (W, H), PITCH_D + (int(255 * k * 0.85),)))
    if t < FADE:
        k = 1 - t / FADE
        img.alpha_composite(Image.new("RGBA", (W, H), PITCH_D + (int(255 * k * 0.85),)))
    return img.convert("RGB")


def render_scene(fn, D, dur, out):
    tmp = out + ".part.mp4"
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "18",
                          "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", str(FPS), tmp], stdin=subprocess.PIPE)
    n = int(round(dur * FPS))
    for i in range(n):
        p.stdin.write(frame(fn, D, i / FPS, dur).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit(f"ffmpeg 실패: {out}")
    os.replace(tmp, out)


def stills(D, outdir):
    """가장 꽉 찬 순간을 그림으로 확인용."""
    os.makedirs(outdir, exist_ok=True)
    for name, fn, dur in SCENES:
        frame(fn, D, dur - FADE - 0.05, dur).save(f"{outdir}/{name}.jpg", quality=90)


def make(src: str, out: str) -> None:
    D = load(src)
    with tempfile.TemporaryDirectory() as td:
        parts = []
        for name, fn, dur in SCENES:
            f = os.path.join(td, f"{name}.mp4")
            render_scene(fn, D, dur, f)
            parts.append(f)
        lst = os.path.join(td, "list.txt")
        open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
        joined = os.path.join(td, "joined.mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
        # 무음 오디오 트랙(일부 앱이 소리 트랙 없는 영상을 싫어함). 음악은 업로드 때 앱에서 고르기
        tmp = out + ".part.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", joined, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", tmp], check=True)
        os.replace(tmp, out)


def main():
    src, out = sys.argv[1], sys.argv[2]
    if "--stills" in sys.argv:
        stills(load(src), out)
        return
    make(src, out)


if __name__ == "__main__":
    main()
