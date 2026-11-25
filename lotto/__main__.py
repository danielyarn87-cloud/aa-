"""python -m lotto : 동행복권 새 회차 당첨번호 받기 (GitHub Actions 가 매주 실행)."""
import os
from pathlib import Path

from .collect import run

res = run(Path(__file__).resolve().parent.parent)
out = os.environ.get("GITHUB_OUTPUT")
if out:  # 새 회차가 있을 때만 저장·사이트 재배포
    with open(out, "a", encoding="utf-8") as f:
        f.write(f"changed={'true' if res['added'] else 'false'}\n")
