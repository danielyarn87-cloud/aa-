"""운영 서버(gunicorn) 진입점: gunicorn aa.web.wsgi:app"""
import os

from ..config import load_company
from .app import create_app

app = create_app(load_company(os.environ.get("AA_COMPANY", "company.yaml")))
