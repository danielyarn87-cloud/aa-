"""Haiku 배치로 운세 문장을 만들고, 검사해서 날짜별 JSON에 넣는다.

흐름 (매일 한 번 daily 실행):
  1. collect: 끝난 배치의 결과를 받아 검사, 통과한 띠·별자리만 저장
  2. submit: 오늘~이틀 뒤 중 비어 있는 띠·별자리만 모아 배치 제출 (날짜당 최대 3번)
배치는 보통 1시간 안에 끝나지만 최대 24시간이 걸릴 수 있어 이틀 앞서 만든다.
"""
from __future__ import annotations

import datetime as dt
import logging

from . import prompts, validate
from .ilgin import plan_day, today_kst
from .store import Store

log = logging.getLogger("unse")
MAX_ATTEMPTS = 3


def _key(iso: str, kind: str, i: int) -> str:
    return f"{iso}_{kind}_{i}"  # custom_id: 영문·숫자·_·- 만 허용


def _prev_texts(store: Store, d: dt.date, kind: str, i: int) -> dict | None:
    prev = store.day((d - dt.timedelta(days=1)).isoformat())
    item = (prev or {}).get(kind, {}).get(str(i))
    if not item:
        return None
    if kind == "ddi":
        return {"summary": item.get("summary"), "years": [y.get("money", "") + " " + y.get("luck", "") for y in item.get("years", [])]}
    return {"summary": item.get("text"), "lines": item.get("lines")}


def missing(store: Store, d: dt.date) -> list[tuple[str, int]]:
    have = store.day(d.isoformat()) or {}
    return [(k, i) for k in ("ddi", "stars") for i in range(12) if str(i) not in have.get(k, {})]


def build_requests(store: Store, d: dt.date, only: list[tuple[str, int]] | None = None) -> list[dict]:
    plan = plan_day(d)
    reqs = []
    for kind, i in only if only is not None else missing(store, d):
        item = plan[kind][i]
        prev = _prev_texts(store, d, kind, i)
        if kind == "ddi":
            params = prompts.request_params(prompts.ddi_prompt(plan, item, prev), prompts.DDI_TOOL, 2000)
        else:
            params = prompts.request_params(prompts.star_prompt(plan, item, prev), prompts.STAR_TOOL, 900)
        reqs.append({"custom_id": _key(plan["date"], kind, i), "params": params})
    return reqs


def submit(client, store: Store, d: dt.date) -> str | None:
    iso = d.isoformat()
    st = store.state()
    if any(p["date"] == iso for p in st["pending"].values()):
        log.info("%s: 이미 진행 중인 배치가 있음", iso)
        return None
    if st["attempts"].get(iso, 0) >= MAX_ATTEMPTS:
        log.warning("%s: 시도 %d번 넘음, 남은 칸은 기본 문장으로 표시", iso, MAX_ATTEMPTS)
        return None
    reqs = build_requests(store, d)
    if not reqs:
        return None
    batch = client.messages.batches.create(requests=reqs)
    st["pending"][batch.id] = {"date": iso, "count": len(reqs), "submitted_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    st["attempts"][iso] = st["attempts"].get(iso, 0) + 1
    store.save_state(st)
    log.info("%s: 배치 %s 제출 (%d건)", iso, batch.id, len(reqs))
    return batch.id


def _tool_input(message) -> dict | None:
    for block in message.content:
        if getattr(block, "type", None) == "tool_use":
            return block.input
    return None


def _assemble(kind: str, out: dict, item: dict) -> dict:
    """AI 문장 + 계산한 등급·행운 값 → 화면이 읽는 모양."""
    if kind == "ddi":
        by_year = {y["y"]: y for y in out["years"]}
        return {
            "relation_tag": item["relation_tag"], "relation_text": item["relation_text"],
            "summary": out["summary"].strip(), "lucky": item["lucky"],
            "years": [{"y": y["y"], "gm": y["gm"], "gl": y["gl"], "money": by_year[y["y"]]["money"].strip(),
                       "luck": by_year[y["y"]]["luck"].strip() + " " + by_year[y["y"]]["advice"].strip()} for y in item["years"]],
        }
    return {"sc": item["sc"], "total": item["total"], "g": item["g"], "text": out["summary"].strip(),
            "lines": [out[k].strip() for k in ("money", "luck", "love", "health")], "lucky": item["lucky"]}


def apply_results(store: Store, iso: str, results) -> dict:
    """results: (custom_id, message 또는 None) 목록. 통과/실패 개수를 돌려준다."""
    d = dt.date.fromisoformat(iso)
    plan = plan_day(d)
    data = store.day(iso) or {"date": iso, "source": "ai", "model": prompts.MODEL, "ilgin": plan["ilgin"], "ddi": {}, "stars": {}}
    ok = bad = 0
    for cid, message in results:
        _, kind, i = cid.rsplit("_", 2)
        i = int(i)
        item = plan[kind][i]
        out = _tool_input(message) if message is not None else None
        if out is None:
            bad += 1
            log.warning("%s: 결과 없음 또는 도구 답 없음", cid)
            continue
        errs = validate.check_ddi(out, item) if kind == "ddi" else validate.check_star(out)
        if errs:
            bad += 1
            log.warning("%s: 검사 실패 %s", cid, "; ".join(errs[:5]))
            continue
        data[kind][str(i)] = _assemble(kind, out, item)
        ok += 1
    data["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    store.save_day(iso, data)
    return {"ok": ok, "bad": bad}


def collect(client, store: Store) -> list[dict]:
    st = store.state()
    done = []
    for batch_id, info in list(st["pending"].items()):
        b = client.messages.batches.retrieve(batch_id)
        if b.processing_status != "ended":
            continue
        results = []
        for r in client.messages.batches.results(batch_id):
            res = r.result
            results.append((r.custom_id, res.message if res.type == "succeeded" else None))
            if res.type != "succeeded":
                log.warning("%s: %s", r.custom_id, res.type)
        summary = apply_results(store, info["date"], results)
        st["pending"].pop(batch_id)
        done.append({"batch": batch_id, "date": info["date"], **summary})
        log.info("%s: 배치 %s 수거, 통과 %d / 실패 %d", info["date"], batch_id, summary["ok"], summary["bad"])
    store.save_state(st)
    return done


def daily(client, store: Store, ahead: int = 2, today: dt.date | None = None) -> dict:
    today = today or today_kst()
    collected = collect(client, store)
    st = store.state()
    st["attempts"] = {k: v for k, v in st["attempts"].items() if k >= (today - dt.timedelta(days=3)).isoformat()}
    store.save_state(st)
    submitted = []
    for n in range(ahead + 1):
        d = today + dt.timedelta(days=n)
        bid = submit(client, store, d)
        if bid:
            submitted.append({"date": d.isoformat(), "batch": bid})
    return {"collected": collected, "submitted": submitted}
