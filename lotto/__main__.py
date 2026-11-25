"""python -m lotto : 동행복권 새 회차 당첨번호 받기 (GitHub Actions 가 매주 실행)."""
import os
from pathlib import Path

from .collect import run

res = run(Path(__file__).resolve().parent.parent)
out = os.environ.get("GITHUB_OUTPUT")
if out:  # 받은 게 있으면 저장, 최신 회차가 바뀌었거나 다 채웠을 때만 사이트 재배포
    with open(out, "a", encoding="utf-8") as f:
        f.write(f"changed={'true' if res['added'] else 'false'}\n")
        f.write(f"deploy={'true' if res['deploy'] else 'false'}\n")
