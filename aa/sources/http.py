"""표준 라이브러리 HTTP GET. 테스트에서는 이 함수 대신 가짜 전송 함수를 넣는다."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request


def http_get(url: str, params: dict, headers: dict, timeout: int = 30) -> tuple[dict | list, dict]:
    full = url + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(full, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8")), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {url}: {e.read().decode('utf-8', 'ignore')[:300]}") from e
