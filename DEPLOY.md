# 서버에 올리기

리눅스 서버 한 대에 Docker로 띄우는 방법입니다. 서버는 메모리 1GB 이상이면 충분합니다
(예: AWS Lightsail 서울 리전, 네이버 클라우드, DigitalOcean, Vultr 등 어디든 같은 방법).

올리고 나면 이렇게 돌아갑니다.

| 구성 | 하는 일 |
| --- | --- |
| web | 웹사이트와 API (`/api/...`). 나중에 앱도 이 API를 씁니다 |
| worker | 매일 10:00, 22:00(한국 시각)에 끝난 경기 채점 → 예정 경기 수집 → 새 경기 분석 |
| caddy | 도메인에 HTTPS 인증서를 자동으로 붙임 |

## 1. 준비물

- API 키 3개: Claude(console.anthropic.com), API-Football(dashboard.api-football.com), The Odds API(the-odds-api.com)
- 도메인 하나 (예: `analysis.내도메인.com`). 서버 IP를 가리키는 A 레코드를 만들어 두세요.

## 2. 서버에서

```bash
# Docker 설치 (Ubuntu 기준)
curl -fsSL https://get.docker.com | sh

# 코드 받기 (GitHub에 올렸다면 git clone, 아니면 zip을 올려서 풀기)
git clone https://github.com/<계정>/aa-sports.git && cd aa-sports

# 설정
cp .env.example .env
nano .env            # 도메인, 관리자 토큰, API 키 3개 입력
mkdir -p data reports && sudo chown -R 1000:1000 data reports

# 실행
docker compose up -d --build
```

## 3. 확인

- `https://도메인/api/health` 가 `{"ok": true}` 를 돌려주면 정상입니다.
- `https://도메인/#admin` 에서 관리자 토큰을 넣고 "경기 수집"을 눌러 보세요.
- 자동 실행 기록: `docker compose logs -f worker`, 또는 `data/daily_log.jsonl`
- 바로 한 번 돌려 보기: `docker compose run --rm worker python -m aa daily`
  (API 비용 없이 흐름만 보려면 `... python -m aa daily --mock`)

## 4. 운영

- **업데이트**: `git pull && docker compose up -d --build`
- **백업**: `data/ledger.sqlite`(모든 예측과 결과)와 `reports/` 폴더가 회사 기록 전부입니다. 매일 다른 곳에 복사해 두세요.
  예: `crontab -e` 에 `0 5 * * * tar czf ~/backup/aa-$(date +\%F).tgz -C ~/aa-sports data reports`
- **비용 조절**: `company.yaml` 의 `automation`
  - `leagues`: 자동으로 다룰 리그 (처음엔 프리미어리그 39만)
  - `max_analyses_per_day`: 하루 분석 경기 수 상한 (경기당 Claude 호출 6회)
  - `run_at`: 실행 시각
- **API 한도**: 무료 API-Football은 하루 100회, 경기당 6회입니다. 리그를 늘리면 Pro 플랜이 필요하고,
  그때 `company.yaml` 의 `daily_limit` 를 함께 올리세요.

## 5. 공개 전에 확인할 것

- 지금은 누구나 사이트를 볼 수 있고, 관리 기능만 토큰으로 막혀 있습니다. 회원제나 유료 공개를 하려면 로그인 기능을 먼저 붙여야 합니다.
- 해외 배당을 보여주고 "100원당 손익"을 표시하는 서비스를 일반에 공개하기 전에는, 국내 법(국민체육진흥법 등)에 걸리는 부분이 없는지 전문가 검토를 받으세요.
