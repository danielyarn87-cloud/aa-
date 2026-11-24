# 운영하기

두 가지 방법이 있습니다. 처음에는 **A. 무료 운영**을 추천합니다.

| | A. 무료 운영 (GitHub + Cloudflare) | B. 서버 1대 (Docker) |
| --- | --- | --- |
| 비용 | 0원 (Claude API 사용료만) | 서버비 + 도메인 |
| 자동 분석 | GitHub Actions 가 하루 두 번 | 서버의 worker 가 하루 두 번 |
| 사이트 | Cloudflare Pages (읽기 전용) | 관리 화면까지 |
| 나중에 로그인·앱 | B 로 옮기면 됨 | 바로 가능 |

# A. 무료 운영: GitHub Actions + Cloudflare Pages

GitHub 가 하루 두 번(10:17, 22:17 한국 시각) 채점 → 수집 → 분석을 돌리고, 결과로 만든 사이트를
`site` 브랜치에 올립니다. Cloudflare Pages 는 `site` 브랜치를 보고 있다가 사이트를 바꿉니다.

## 1. API 키 3개를 GitHub 에 넣기

저장소 **Settings → Secrets and variables → Actions → New repository secret** 에서 세 개를 만듭니다.
값은 이 화면에만 넣고, 코드나 대화창에는 쓰지 마세요.

| Name | 값 |
| --- | --- |
| `ANTHROPIC_API_KEY` | console.anthropic.com 에서 발급한 Claude 키 (사용한 만큼 요금, 크레딧 충전 필요) |
| `API_FOOTBALL_KEY` | API-Football 키 |
| `ODDS_API_KEY` | The Odds API 키 |

## 2. 원할 때 분석하기 (처음 한 번도 이렇게)

저장소 **Actions → 매일 분석 → Run workflow** 를 누르면 바로 돌아갑니다. 휴대폰 GitHub 앱에서도 됩니다.
빈칸은 비워 두면 평소 설정대로 돌고, 이번만 바꾸고 싶을 때 채웁니다.

| 칸 | 예 | 뜻 |
| --- | --- | --- |
| 리그 번호 | `39,140` | 프리미어리그와 라리가만 (39 프리미어리그, 140 라리가, 135 세리에A, 78 분데스리가, 61 리그1, 2 챔스, 292 K리그1) |
| 며칠 뒤까지 | `5` | 5일 뒤 경기까지 수집 |
| 킥오프 몇 시간 안 | `120` | 5일 안의 경기까지 분석 |
| 최대 경기 수 | `3` | 이번에는 3경기만 분석 (오늘 한도와 별도) |
| 모의 실행 | 체크 | Claude 비용 없이 흐름만 확인 |

처음에는 **모의 실행**에 체크해서 돌려 보세요. 끝나면 저장소에 `site` 브랜치가 생깁니다.

## 3. Cloudflare Pages 연결 (한 번만)

Cloudflare 대시보드 **Workers & Pages → 만들기(Create) → Pages → Git 에 연결(Connect to Git)**:

- 저장소: `danielyarn87-cloud/aa-`
- 프로덕션 브랜치: **`site`**
- 프레임워크: 없음 / 빌드 명령: **비움** / 출력 디렉터리: **`/`** (비워 두어도 됨)

저장하면 `프로젝트이름.pages.dev` 주소가 생깁니다. 내 도메인을 붙이려면 그 프로젝트의 **사용자 지정 도메인**에서 추가합니다.

## 4. 운영

- 자동 실행 기록: 저장소 **Actions** 탭. 실패하면 GitHub 가 메일로 알려 줍니다.
- 예측·결과 기록(`data/ledger.sqlite`)과 분석 리포트(`reports/`)는 실행할 때마다 저장소에 커밋됩니다. 그래서 따로 백업할 필요가 없습니다.
- 비용 조절은 `company.yaml` 의 `automation`(리그, 하루 분석 한도)에서 합니다. 실행 시각은 `.github/workflows/daily.yml` 의 `cron` 에서 바꿉니다 (UTC 기준, 한국 시각 −9시간).
- 저장소를 **비공개**로 바꿔도 됩니다. 비공개 저장소의 Actions 무료 시간은 한 달 2,000분이고, 이 작업은 한 번에 몇 분이라 충분합니다.

# B. 서버 1대 (Docker)

리눅스 서버 한 대에 Docker로 띄우는 방법입니다. 서버는 메모리 1GB 이상이면 충분합니다
(예: AWS Lightsail 서울 리전, 네이버 클라우드, DigitalOcean, Vultr 등 어디든 같은 방법).

올리고 나면 이렇게 돌아갑니다.

| 구성 | 하는 일 |
| --- | --- |
| web | 웹사이트와 API (`/api/...`). 나중에 앱도 이 API를 씁니다 |
| worker | 매일 10:00, 22:00(한국 시각)에 끝난 경기 채점 → 예정 경기 수집 → 새 경기 분석 |
| caddy | 도메인에 HTTPS 인증서를 자동으로 붙임 |

## B-1. 준비물

- API 키 3개: Claude(console.anthropic.com), API-Football(dashboard.api-football.com), The Odds API(the-odds-api.com)
- 도메인 하나 (예: `analysis.내도메인.com`). 서버 IP를 가리키는 A 레코드를 만들어 두세요.

## B-2. 서버에서

```bash
# Docker 설치 (Ubuntu 기준)
curl -fsSL https://get.docker.com | sh

# 코드 받기 (GitHub에 올렸다면 git clone, 아니면 zip을 올려서 풀기)
git clone https://github.com/danielyarn87-cloud/aa-.git && cd aa-

# 설정
cp .env.example .env
nano .env            # 도메인, 관리자 토큰, API 키 3개 입력
mkdir -p data reports && sudo chown -R 1000:1000 data reports

# 실행
docker compose up -d --build
```

## B-3. 확인

- `https://도메인/api/health` 가 `{"ok": true}` 를 돌려주면 정상입니다.
- `https://도메인/#admin` 에서 관리자 토큰을 넣고 "경기 수집"을 눌러 보세요.
- 자동 실행 기록: `docker compose logs -f worker`, 또는 `data/daily_log.jsonl`
- 바로 한 번 돌려 보기: `docker compose run --rm worker python -m aa daily`
  (API 비용 없이 흐름만 보려면 `... python -m aa daily --mock`)

## B-4. 운영

- **업데이트**: `git pull && docker compose up -d --build`
- **백업**: `data/ledger.sqlite`(모든 예측과 결과)와 `reports/` 폴더가 회사 기록 전부입니다. 매일 다른 곳에 복사해 두세요.
  예: `crontab -e` 에 `0 5 * * * tar czf ~/backup/aa-$(date +\%F).tgz -C ~/aa- data reports`
- **비용 조절**: `company.yaml` 의 `automation`
  - `leagues`: 자동으로 다룰 리그 (처음엔 프리미어리그 39만)
  - `max_analyses_per_day`: 하루 분석 경기 수 상한 (경기당 Claude 호출 6회)
  - `run_at`: 실행 시각
- **API 한도**: 무료 API-Football은 하루 100회, 경기당 6회입니다. 리그를 늘리면 Pro 플랜이 필요하고,
  그때 `company.yaml` 의 `daily_limit` 를 함께 올리세요.

# 공개 전에 확인할 것

- 지금은 누구나 사이트를 볼 수 있고, 관리 기능만 토큰으로 막혀 있습니다. 회원제나 유료 공개를 하려면 로그인 기능을 먼저 붙여야 합니다.
- 해외 배당을 보여주고 "100원당 손익"을 표시하는 서비스를 일반에 공개하기 전에는, 국내 법(국민체육진흥법 등)에 걸리는 부분이 없는지 전문가 검토를 받으세요.
