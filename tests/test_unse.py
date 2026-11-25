"""API 키 없이 가짜 Claude로 전체 흐름(계획 → 배치 제출 → 수거 → 검사 → 저장 → 화면 API)을 시험한다."""
import datetime as dt
import re
from types import SimpleNamespace as NS

import pytest

from unse import batch, ilgin, validate
from unse.store import Store

D = dt.date(2026, 11, 25)


def test_ilgin():
    assert ilgin.gz_name(ilgin.day_ganzhi(dt.date(2000, 1, 1))) == "무오"
    assert ilgin.gz_name(ilgin.day_ganzhi(D)) == "계묘"
    assert ilgin.gz_name(ilgin.year_ganzhi(2026)) == "병오"


@pytest.mark.parametrize("year,lo,hi", [(2026, 1959, 2006), (2027, 1960, 2007)])
def test_birth_years(year, lo, hi):
    allys = sorted(y for b in range(12) for y in ilgin.birth_years(b, year))
    assert allys == list(range(lo, hi + 1))
    for b in range(12):
        assert all((y - 4) % 12 == b for y in ilgin.birth_years(b, year))


def test_plan_is_stable():
    assert ilgin.plan_day(D) == ilgin.plan_day(D)
    p = ilgin.plan_day(D)
    assert len(p["ddi"]) == 12 and all(len(x["years"]) == 4 for x in p["ddi"])
    assert p["ddi"][3]["relation_tag"] == "같은 기운"  # 계묘일 - 토끼띠


def test_validate():
    assert validate.check_text("지출을 한 번 점검하세요. 새는 돈이 보입니다.", 2, "x") == []
    assert validate.check_text("오늘은 베팅하기 좋은 날입니다.", 1, "x")
    assert validate.check_text("만 원을 아끼면 좋습니다.", 1, "x") == []
    assert validate.check_text("10만 원이 들어옵니다.", 1, "x")
    assert validate.check_text("한 문장뿐입니다.", 2, "x")
    assert validate.check_text("<b>굵게</b> 씁니다.", 1, "x")


# ---------- 가짜 Claude ----------
def fake_answer(params, bad=False):
    prompt = params["messages"][0]["content"]
    tool = params["tool_choice"]["name"]
    if tool == "save_ddi_fortune":
        years = [int(y) for y in re.findall(r"- (\d{4})년생", prompt)]
        out = {"summary": "오늘은 돈의 흐름이 차분하게 이어집니다.",
               "years": [{"y": y, "money": f"{y % 100}년생은 지갑을 단단히 챙기세요. {y % 100}년생에게 작은 정산이 들어옵니다.",
                          "luck": f"{y % 100}년생에게 반가운 소식이 옵니다.", "advice": f"{y % 100}년생은 계획을 적어 두세요."} for y in years]}
    else:
        out = {"summary": "차분한 하루입니다. 대화 속에서 좋은 생각이 떠오릅니다.",
               "money": "들어오고 나가는 돈이 비슷합니다. 고정 지출을 살펴보세요.",
               "luck": "익숙한 사람에게서 좋은 정보를 얻습니다. 오후에 기회가 옵니다.",
               "love": "먼저 안부를 건네면 좋습니다." if not bad else "오늘은 베팅이 잘 맞습니다.",
               "health": "가벼운 산책이 보약입니다."}
    return NS(content=[NS(type="tool_use", input=out)])


class FakeBatches:
    def __init__(self, bad_ids=()):
        self.store, self.n, self.bad_ids = {}, 0, set(bad_ids)

    def create(self, requests):
        self.n += 1
        bid = f"msgbatch_{self.n}"
        self.store[bid] = requests
        return NS(id=bid, processing_status="in_progress")

    def retrieve(self, bid):
        return NS(id=bid, processing_status="ended")

    def results(self, bid):
        for r in self.store[bid]:
            msg = fake_answer(r["params"], bad=r["custom_id"] in self.bad_ids)
            yield NS(custom_id=r["custom_id"], result=NS(type="succeeded", message=msg))


def fake_client(bad_ids=()):
    return NS(messages=NS(batches=FakeBatches(bad_ids)))


def test_end_to_end(tmp_path):
    store = Store(tmp_path)
    c = fake_client(bad_ids={"2026-11-26_stars_5"})
    first = batch.daily(c, store, ahead=2, today=D)
    assert [s["date"] for s in first["submitted"]] == ["2026-11-25", "2026-11-26", "2026-11-27"]
    req = c.messages.batches.store["msgbatch_1"][0]
    assert req["params"]["model"] == "claude-haiku-5-5" and req["params"]["tool_choice"]["type"] == "tool"

    second = batch.daily(c, store, ahead=2, today=D)  # 수거 후, 실패한 1건만 다시 제출
    assert sum(x["ok"] for x in second["collected"]) == 71
    assert sum(x["bad"] for x in second["collected"]) == 1
    assert second["submitted"] == [{"date": "2026-11-26", "batch": "msgbatch_4"}]
    assert [r["custom_id"] for r in c.messages.batches.store["msgbatch_4"]] == ["2026-11-26_stars_5"]

    day = store.day("2026-11-25")
    item = day["ddi"]["3"]
    assert item["relation_tag"] == "같은 기운" and len(item["years"]) == 4
    assert item["years"][0]["luck"].endswith("계획을 적어 두세요.")  # 행운 + 조언
    assert day["stars"]["0"]["lines"][0].startswith("들어오고")

    # 다음 날 요청에는 어제 문장이 들어가 되풀이를 막는다
    nxt = batch.build_requests(store, dt.date(2026, 11, 26), only=[("ddi", 3)])
    assert "어제 이 띠에 쓴 문장" in nxt[0]["params"]["messages"][0]["content"]


def test_rest_client_parses_results(monkeypatch):
    import json
    from unse.api import BatchClient
    c = BatchClient(api_key="test")
    lines = [{"custom_id": "2026-11-25_stars_0", "result": {"type": "succeeded", "message": {"content": [{"type": "tool_use", "input": {"summary": "a"}}]}}},
             {"custom_id": "2026-11-25_stars_1", "result": {"type": "expired"}}]
    calls = []

    def fake_call(url, body=None):
        calls.append((url, body))
        if url.endswith("/results"):
            return "\n".join(json.dumps(x) for x in lines).encode()
        if body is not None:
            return json.dumps({"id": "msgbatch_x", "processing_status": "in_progress"}).encode()
        return json.dumps({"id": "msgbatch_x", "processing_status": "ended", "results_url": "https://api.anthropic.com/v1/messages/batches/msgbatch_x/results"}).encode()

    monkeypatch.setattr(c, "_call", fake_call)
    assert c.messages.batches.create([{"custom_id": "a", "params": {}}]).id == "msgbatch_x"
    assert c.messages.batches.retrieve("msgbatch_x").processing_status == "ended"
    out = list(c.messages.batches.results("msgbatch_x"))
    assert out[0].result.message.content[0].input == {"summary": "a"} and out[1].result.message is None
    assert calls[0][1] == {"requests": [{"custom_id": "a", "params": {}}]}
