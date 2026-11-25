"""Claude 배치 API 클라이언트. aa/llm.py 처럼 표준 라이브러리만 쓴다 (추가 설치 불필요).

batch.py 가 쓰는 세 가지만 있다: create, retrieve, results.
돌려주는 모양은 공식 SDK 와 같게 맞춰서, 시험용 가짜 클라이언트와 바꿔 끼울 수 있다.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from types import SimpleNamespace as NS

BASE = "https://api.anthropic.com/v1/messages/batches"


class BatchClient:
    def __init__(self, api_key: str | None = None, timeout: int = 120):
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise RuntimeError("ANTHROPIC_API_KEY 환경변수가 없습니다.")
        self.timeout = timeout
        self.messages = NS(batches=self)  # client.messages.batches.create(...) 모양

    def _call(self, url: str, body: dict | None = None) -> bytes:
        headers = {"x-api-key": self.api_key, "anthropic-version": "2023-06-01"}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        for attempt in range(4):
            req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise RuntimeError(f"Claude 배치 API 오류 {e.code}: {e.read().decode('utf-8', 'ignore')[:300]}") from e
        raise RuntimeError("Claude 배치 API 재시도 한도 초과")

    def create(self, requests: list[dict]):
        j = json.loads(self._call(BASE, {"requests": requests}))
        return NS(id=j["id"], processing_status=j.get("processing_status"))

    def retrieve(self, batch_id: str):
        j = json.loads(self._call(f"{BASE}/{batch_id}"))
        return NS(id=j["id"], processing_status=j.get("processing_status"), results_url=j.get("results_url"))

    def results(self, batch_id: str):
        url = self.retrieve(batch_id).results_url or f"{BASE}/{batch_id}/results"
        for line in self._call(url).decode("utf-8").splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            res = r.get("result") or {}
            msg = res.get("message")
            message = None
            if msg:
                message = NS(content=[NS(type=b.get("type"), input=b.get("input"), text=b.get("text")) for b in msg.get("content", [])])
            yield NS(custom_id=r.get("custom_id"), result=NS(type=res.get("type"), message=message))
