import io
import json

from aa.llm import ClaudeClient
from aa.pipeline import SCHEMAS


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_claude_client_uses_forced_tool_and_returns_its_input(monkeypatch):
    sent = {}
    answer = {"probs": {"home": 0.5, "draw": 0.3, "away": 0.2}, "summary": '"흐름"이라는 말을 써도 깨지지 않음'}

    def fake_urlopen(req, timeout=None):
        sent.update(json.loads(req.data.decode("utf-8")))
        body = {"content": [{"type": "tool_use", "name": "submit", "input": answer}]}
        return FakeResp(json.dumps(body).encode("utf-8"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    c = ClaudeClient(model="m", api_key="k")
    out = c.complete("sys", "prompt", {"schema": SCHEMAS["initial"]})
    assert json.loads(out) == answer
    assert sent["tool_choice"] == {"type": "tool", "name": "submit"}
    assert sent["tools"][0]["input_schema"]["required"][0] == "probs"
