import io
import json

from aa.llm import ClaudeClient
from aa.pipeline import SCHEMAS


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_claude_client_requests_json_schema_output(monkeypatch):
    sent = {}
    answer = {"probs": {"home": 0.5, "draw": 0.3, "away": 0.2}, "summary": '"흐름"이라는 말을 써도 깨지지 않음'}

    def fake_urlopen(req, timeout=None):
        sent.update(json.loads(req.data.decode("utf-8")))
        body = {"content": [{"type": "text", "text": json.dumps(answer, ensure_ascii=False)}], "stop_reason": "end_turn"}
        return FakeResp(json.dumps(body).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    c = ClaudeClient(model="m", api_key="k")
    out = c.complete("sys", "prompt", {"schema": SCHEMAS["initial"]})
    assert json.loads(out) == answer
    fmt = sent["output_config"]["format"]
    assert fmt["type"] == "json_schema" and fmt["schema"]["required"][0] == "probs"
    assert "tools" not in sent and "tool_choice" not in sent
