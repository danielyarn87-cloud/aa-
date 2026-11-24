"""종목 모듈. 새 종목은 SportModule 을 구현해 REGISTRY 에 등록하면 된다."""
from __future__ import annotations

from .base import SportModule
from .baseball import Baseball
from .soccer import Soccer

REGISTRY: dict[str, SportModule] = {"soccer": Soccer(), "baseball": Baseball()}


def get_sport(name: str) -> SportModule:
    if name not in REGISTRY:
        raise KeyError(f"지원하지 않는 종목: {name}")
    return REGISTRY[name]
