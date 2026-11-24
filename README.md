# AA 스포츠 분석

AI 분석가 여러 명이 경기를 **각자 분석 → 토론 → 가중 투표**해서 승무패와 언더/오버 결론을 내는 프로그램입니다.
지금은 축구분석팀에 분석가 3명(김데이터, 박현장, 이역발)이 있고, 인원과 부서는 설정 파일만 고치면 늘어납니다.

## 실행

Python 3.10 이상과 PyYAML, Flask 가 필요합니다.

```bash
pip install pyyaml flask

python -m aa roster                                   # 조직도
python -m aa analyze data/sample_match.json --mock    # 키 없이 모의 실행 (흐름 확인용)

export ANTHROPIC_API_KEY=sk-...                       # 실제 분석
python -m aa analyze data/sample_match.json

python -m aa analyze data/2026-11-29_ARS-MCI.json --replay data/2026-11-29_ARS-MCI.responses.json
                                                      # 미리 받아 둔 분석가 답변으로 실행 (API 없이)

python -m aa settle SAMPLE-001 2-1                    # 경기 결과 입력 (홈-원정)
python -m aa review                                   # 인사평가: 분석가별 성적과 다음 투표 비중
python -m pytest -q                                   # 테스트
```

리포트는 `reports/<경기 id>.md` 에, 모든 예측과 결과는 `data/ledger.sqlite` 에 쌓입니다.
모의 실행 기록은 인사평가에서 빠집니다.

## 웹사이트

```bash
export AA_ADMIN_TOKEN=아무도-모르는-긴-문자열   # 관리 화면용 (경기 수집, 분석, 채점)
python -m aa serve --port 8000                  # http://127.0.0.1:8000
```

화면은 경기 목록, 경기 상세(확률 사다리, 배당 대비 가치, 분석가 의견과 토론), 분석팀, 인사평가, 관리로 구성됩니다.
휴대폰에서는 아래쪽 탭으로 바뀌고, 홈 화면에 추가하면 앱처럼 열립니다(PWA).
앱으로 갈 때는 같은 JSON API(`/api/...`)를 그대로 쓰면 됩니다. 목록은 `aa/web/app.py` 맨 위에 있습니다.

서버 없이 화면만 보여 줄 때: `python tools/build_preview.py` → `dist/preview.html` (현재 분석 결과가 들어간 한 장짜리 HTML).

## 데이터 자동 수집

```bash
export API_FOOTBALL_KEY=...     # api-football.com 무료 키 (하루 100회)
export ODDS_API_KEY=...         # the-odds-api.com 무료 키 (월 500 크레딧)

python -m aa collect --days 3 --league 39     # 프리미어리그 3일치 예정 경기 → data/matches/
python -m aa analyze data/matches/AF-123.json # 분석
python -m aa sync                             # 끝난 경기 결과 자동 채점
```

- 리그 번호와 배당 종목 키는 `company.yaml` 의 `data_sources.leagues` 에 있습니다.
- 경기 하나에 API-Football 6회(`--light` 면 3회)를 쓰고, 모든 응답은 캐시합니다. 하루·월 한도에 닿으면 호출 전에 멈춥니다.
- 무료 플랜의 기초 모델은 xG 대신 홈/원정 경기당 득실을 쓰고, 경기 수가 적으면 리그 평균 쪽으로 보정합니다.
- 두 API 의 팀 이름이 다르면 `team_aliases` 에 짝을 넣으세요.

## 폴더 구조

```
company.yaml        조직도: 회사 규칙, 부서, 직원
personas/           직원별 인격 지시문 (한 명당 파일 하나)
prompts/            단계별 지시문: analysis(독립 분석), debate(토론), lead_summary(팀장 코멘트)
data/               경기 자료 JSON, 예측 기록부
reports/            분석 리포트
tools/              미리보기 생성 등 보조 도구
aa/                 프로그램
  web/              웹 서버(Flask)와 화면(static/)
  sources/          API-Football, The Odds API 연동과 캐시
  collect.py        경기 자료 자동 생성, 결과 자동 채점
  pipeline.py       분석 흐름
  voting.py         가중 투표와 관망 규칙
  ledger.py         기록과 채점, 성적 기반 투표 비중
  sports/           종목 모듈 (soccer 구현, baseball 자리만 있음)
```

## 회사 키우기

**직원 한 명 추가**: `personas/새사람.md` 를 만들고 `company.yaml` 의 `members` 에 한 항목을 넣습니다.
투표 규칙은 인원수와 상관없이 "1위 선택지의 가중 득표율이 50%를 넘으면 픽, 아니면 관망"입니다.

**팀장 두기**: `role: lead`, `votes: false` 로 넣으면 투표 결과를 바꾸지 않고 고객용 최종 코멘트를 씁니다.

**부서 추가**: `departments` 에 항목을 넣습니다. 경기 JSON 의 `sport` 값으로 담당 부서가 자동으로 정해집니다.
야구는 `aa/sports/baseball.py` 에 득점 모델을 채우고 야구분석팀을 `active: true` 로 바꾸면 됩니다.

**직원마다 다른 모델**: 직원 항목에 `model: claude-opus-5-5` 처럼 적으면 그 사람만 다른 모델을 씁니다.

## 경기 자료 형식

`data/sample_match.json` 을 복사해서 채우면 됩니다. 꼭 필요한 항목은 `id, sport, league, kickoff, home, away, odds`
그리고 축구 득점 모델용 `stats.home.xg_for / xg_against`, `stats.away.xg_for / xg_against`, `league_avg` 입니다.
그 밖의 항목(라인업, 일정, 동기, 메모 등)은 이름과 상관없이 분석가에게 그대로 전달됩니다.
자료에 없는 내용은 분석가가 지어내지 않고 "자료 없음"으로 씁니다.

## 주의

이 프로그램은 분석 참고용이며 결과를 보장하지 않습니다. 최소 100~200경기를 기록·채점해서
실제로 시장보다 나은지 확인한 뒤 신뢰하세요.
