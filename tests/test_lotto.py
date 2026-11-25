import json

from lotto import collect


def row(no, nums):
    return {"ltEpsd": no, "ltRflYmd": f"202601{no:02d}", **{f"tm{i + 1}WnNo": x for i, x in enumerate(nums)},
            "bnsWnNo": 45, "rnk1WnNope": 10, "rnk1WnAmt": 2000000000, "rnk2WnNope": 50, "rnk2WnAmt": 50000000,
            "rnk3WnNope": 3000, "rnk3WnAmt": 1500000, "rnk4WnNope": 150000, "rnk4WnAmt": 50000,
            "rnk5WnNope": 2500000, "rnk5WnAmt": 5000, "winType1": 7, "winType2": 3, "winType3": 0,
            "wholEpsdSumNtslAmt": 1}


def fake(results, window=2):
    """기준 회차 주변(앞뒤 window)을 함께 주는 동행복권 흉내"""
    calls = []

    def get(url):
        no = int(url.rsplit("=", 1)[1])
        calls.append(no)
        lst = [row(n, results[n]) for n in sorted(results, reverse=True) if abs(n - no) <= window]
        return json.dumps({"resultCode": None, "data": {"list": lst}}).encode()
    get.calls = calls
    return get


def at(no):
    """no 회차 결과가 올라온 직후 시각"""
    return collect.FIRST_DRAW + collect.timedelta(days=7 * (no - 1), hours=1)


def test_expected_latest():
    assert collect.expected_latest(at(1)) == 1
    assert collect.expected_latest(collect.datetime(2026, 11, 25, 19, 0, tzinfo=collect.KST)) == 1251
    assert collect.expected_latest(collect.datetime(2026, 11, 28, 21, 30, tzinfo=collect.KST)) == 1252


def test_newest_first_backfill_skips_deploy(tmp_path):
    """옛 회차가 빠져 있으면 최신부터 받고, 옛 회차만 채운 실행은 사이트를 다시 만들지 않는다"""
    draws = {n: [1, 2, 3, 4, 5, 6] for n in range(1, 31)}
    calls = []

    def flaky(url):  # 처음 두 번만 답하고 그다음은 막힘
        calls.append(int(url.rsplit("=", 1)[1]))
        if len(calls) > 2:
            raise OSError("slow")
        return fake(draws)(url)
    r = collect.run(tmp_path, get=flaky, pause=0, log=lambda *a: None, now=at(30))
    assert calls[0] == 30 and r["last"] == 30 and r["left"] > 0 and r["deploy"]
    r = collect.run(tmp_path, get=fake(draws, window=3), pause=0, log=lambda *a: None, now=at(30))
    assert r["added"] > 0 and r["left"] == 0 and r["deploy"]          # 다 채운 실행은 배포
    collect.path(tmp_path).write_text(json.dumps({"draws": [x for x in json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))["draws"] if x["no"] not in (2, 3)]}), encoding="utf-8")
    draws.pop(2)
    r = collect.run(tmp_path, get=fake(draws), pause=0, log=lambda *a: None, now=at(30))
    assert r["added"] == 1 and r["left"] == 1 and not r["deploy"]     # 옛 회차만 → 배포 안 함 (2회는 안 옴)


def test_collect_from_scratch_then_only_new(tmp_path):
    draws = {n: [n % 45 + 1, 2 + n % 40, 10, 20, 30, 44] for n in range(1, 8)}
    g = fake(draws)
    r = collect.run(tmp_path, get=g, pause=0, log=lambda *a: None, now=at(7))
    assert r["added"] == 7 and r["last"] == 7 and len(g.calls) < 7      # 한 번에 여러 회차라 적게 묻는다
    assert g.calls[0] == 7 and r["left"] == 0 and r["deploy"]           # 최신 회차부터
    db = json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))
    d1 = db["draws"][0]
    assert d1["no"] == 1 and d1["date"] == "2026-01-01" and d1["nums"] == sorted(d1["nums"])
    assert d1["ranks"][1] == [50, 50000000] and d1["first_type"] == {"auto": 7, "manual": 3, "semi": 0}
    draws[8] = [1, 2, 3, 4, 5, 6]
    r = collect.run(tmp_path, get=fake(draws), pause=0, log=lambda *a: None, now=at(8))
    assert r["added"] == 1 and r["last"] == 8 and r["deploy"]


def test_blocked_site_keeps_old(tmp_path):
    collect.run(tmp_path, get=fake({1: [1, 2, 3, 4, 5, 6]}), pause=0, log=lambda *a: None, now=at(1))
    r = collect.run(tmp_path, get=lambda url: b"<html>blocked</html>", pause=0, log=lambda *a: None, now=at(1))
    assert r["added"] == 0
    assert len(json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))["draws"]) == 1
