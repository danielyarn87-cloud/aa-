// RAISE 알람 시계 (Cloudflare Worker "raise-clock", 무료 요금제의 예약 실행 사용)
//
// GitHub Actions 의 예약 실행(schedule)은 10~50분씩 늦거나 가끔 건너뛴다.
// Cloudflare 예약 실행은 1분 안쪽으로 정확하므로, 정해진 시각에 GitHub 에 "지금 실행" 신호(workflow_dispatch)만 보낸다.
// 작업 내용은 그대로 GitHub Actions 가 한다. 배당 갱신은 사이트에 직접 요청한다.
//
// Cloudflare → Workers → raise-clock → 설정에 넣을 값 (코드에 쓰지 않음):
//   GH_TOKEN  레이즈 '분석 요청'에 쓰는 것과 같은 GitHub 토큰 (Actions 실행 권한)
//
// 예약 실행 (UTC, 무료 요금제 한도 5개):
//   "17,47 * * * *"       결과 확인 + 배당 갱신
//   "3 5,21 * * *"        매일 분석 (한국 14:03, 06:03)
//   "11 3,9,15,21 * * *"  오늘의 운세 (한국 12:11, 18:11, 00:11, 06:11)
//   "41 */3 * * *"        스포츠 뉴스 (3시간마다)
//   "37 * * * *"          로또 당첨번호

const REPO = "danielyarn87-cloud/aa-";
const SITE = "https://raise-fulltime.com";   // 운영자 주소(aa-2kp.pages.dev)는 Cloudflare Access 로 잠겨 있다

// 실행 시각(UTC)의 분·시로 할 일을 고른다 (예약 문자열 표기가 달라도 안전하게)
export function planFor(date) {
  const m = date.getUTCMinutes(), h = date.getUTCHours();
  if (m === 17 || m === 47) return { workflows: ["results.yml"], odds: true };
  if (m === 3 && (h === 5 || h === 21)) return { workflows: ["daily.yml"] };
  if (m === 11 && h % 6 === 3) return { workflows: ["fortune.yml"] };
  if (m === 41 && h % 3 === 0) return { workflows: ["news.yml"] };
  if (m === 37) return { workflows: ["lotto.yml"] };
  return null;
}

async function dispatch(env, wf) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${wf}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "raise-clock",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  return `${wf} ${r.status}`;
}

export async function runPlan(date, env) {
  const p = planFor(date);
  if (!p) return [`nothing at ${date.toISOString()}`];
  const done = [];
  if (env.GH_TOKEN) {
    for (const wf of p.workflows) done.push(await dispatch(env, wf));
  } else {
    done.push("no GH_TOKEN");
  }
  if (p.odds) {
    const r = await fetch(`${SITE}/api/odds/refresh`, { method: "POST", headers: { "Content-Type": "application/json" } });
    done.push(`odds ${r.status}`);
  }
  return done;
}

export default {
  async scheduled(event, env, ctx) {
    const done = await runPlan(new Date(event.scheduledTime), env);
    console.log(event.cron, done.join(" · "));
  },
  async fetch() {
    return new Response("raise-clock", { status: 404 });
  },
};
