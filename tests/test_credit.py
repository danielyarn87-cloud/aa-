import json
from datetime import datetime, timezone

from aa import credit


def test_cost_uses_model_price():
    u = {"input_tokens": 1_000_000, "output_tokens": 100_000}
    assert abs(credit.cost("claude-sonnet-5-5", u) - 3.0) < 1e-9      # 2 + 1
    assert abs(credit.cost("claude-haiku-5-5", u) - 0.15) < 1e-9      # 0.1 + 0.05


def test_balance_set_add_and_spend(tmp_path):
    (tmp_path / "data").mkdir()
    assert credit.status(tmp_path)["balance"] is None
    credit.credit_path(tmp_path).write_text(json.dumps({"events": [
        {"at": "2026-11-25T00:00:00Z", "type": "set", "usd": 40},          # 옛 값: 무시
        {"at": "2026-11-25T01:00:00Z", "type": "set", "usd": 48.75},
        {"at": "2026-11-25T03:00:00Z", "type": "add", "usd": 20},
    ]}))
    credit.record("claude-sonnet-5-5", {"input_tokens": 100_000, "output_tokens": 0})   # $0.20
    credit.flush(tmp_path, now=datetime(2026, 11, 25, 2, 0, tzinfo=timezone.utc))
    credit.record("claude-sonnet-5-5", {"input_tokens": 0, "output_tokens": 10_000})   # $0.10 (잔액 입력 전)
    credit.flush(tmp_path, now=datetime(2026, 11, 25, 0, 30, tzinfo=timezone.utc))
    s = credit.status(tmp_path)
    assert s["balance"] == round(48.75 + 20 - 0.20, 2)
    assert s["calls"] == 1
    assert credit.flush(tmp_path) is None     # 부른 게 없으면 기록 안 함
