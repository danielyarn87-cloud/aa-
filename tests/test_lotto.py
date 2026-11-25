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


def test_collect_from_scratch_then_only_new(tmp_path):
    draws = {n: [n % 45 + 1, 2 + n % 40, 10, 20, 30, 44] for n in range(1, 8)}
    g = fake(draws)
    r = collect.run(tmp_path, get=g, pause=0, log=lambda *a: None)
    assert r["added"] == 7 and r["last"] == 7 and len(g.calls) < 7      # 한 번에 여러 회차라 적게 묻는다
    db = json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))
    d1 = db["draws"][0]
    assert d1["no"] == 1 and d1["date"] == "2026-01-01" and d1["nums"] == sorted(d1["nums"])
    assert d1["ranks"][1] == [50, 50000000] and d1["first_type"] == {"auto": 7, "manual": 3, "semi": 0}
    draws[8] = [1, 2, 3, 4, 5, 6]
    r = collect.run(tmp_path, get=fake(draws), pause=0, log=lambda *a: None)
    assert r["added"] == 1 and r["last"] == 8


def test_blocked_site_keeps_old(tmp_path):
    collect.run(tmp_path, get=fake({1: [1, 2, 3, 4, 5, 6]}), pause=0, log=lambda *a: None)
    r = collect.run(tmp_path, get=lambda url: b"<html>blocked</html>", pause=0, log=lambda *a: None)
    assert r["added"] == 0
    assert len(json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))["draws"]) == 1
