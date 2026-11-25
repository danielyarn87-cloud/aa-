import json

from lotto import collect


def fake(results):
    def get(url):
        no = int(url.rsplit("=", 1)[1])
        if no in results:
            n = results[no]
            return json.dumps({"returnValue": "success", "drwNo": no, "drwNoDate": f"2026-01-{no:02d}",
                               **{f"drwtNo{i + 1}": x for i, x in enumerate(n)}, "bnusNo": 45,
                               "firstPrzwnerCo": 10, "firstWinamnt": 2000000000, "totSellamnt": 1}).encode()
        return json.dumps({"returnValue": "fail"}).encode()
    return get


def test_collect_from_scratch_then_only_new(tmp_path):
    r = collect.run(tmp_path, get=fake({1: [10, 3, 5, 20, 30, 40], 2: [1, 2, 3, 4, 5, 6]}), pause=0, log=lambda *a: None)
    assert r["added"] == 2 and r["last"] == 2
    db = json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))
    assert db["draws"][0]["nums"] == [3, 5, 10, 20, 30, 40] and db["draws"][1]["no"] == 2
    r = collect.run(tmp_path, get=fake({1: [1] * 6, 2: [1] * 6, 3: [7, 8, 9, 10, 11, 12]}), pause=0, log=lambda *a: None)
    assert r["added"] == 1 and r["last"] == 3


def test_blocked_site_keeps_old(tmp_path):
    collect.run(tmp_path, get=fake({1: [1, 2, 3, 4, 5, 6]}), pause=0, log=lambda *a: None)
    r = collect.run(tmp_path, get=lambda url: b"<html>blocked</html>", pause=0, log=lambda *a: None)
    assert r["added"] == 0
    assert len(json.loads(collect.path(tmp_path).read_text(encoding="utf-8"))["draws"]) == 1
