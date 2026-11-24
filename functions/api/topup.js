// Cloudflare Pages 함수: 배팅 게임 계좌에 가상 금액 추가 (올인으로 잔액이 바닥났을 때 등).
// 비밀번호는 '분석 요청'과 같은 RUN_PASSWORD. 기록은 저장소의 data/topups.json 에 쌓이고,
// 사이트를 다시 만들 때와 다음 자동 실행 때 계좌에 한 번만 반영된다 (aa/betting.py).
//
// POST /api/topup  {"password", "member_id": "hogu", "amount": 500000}

const MEMBERS = ["kim_data", "park_field", "lee_contra", "hogu"];
const MAX_AMOUNT = 10_000_000;
const PATH = "/contents/data/topups.json";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function gh(env, path, init = {}) {
  const repo = env.GH_REPO || "danielyarn87-cloud/aa-";
  return fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aa-sports-site",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function sameText(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

export async function onRequestPost({ request, env }) {
  if (!env.GH_TOKEN || !env.RUN_PASSWORD) {
    return json({ error: "아직 설정이 끝나지 않았습니다. Cloudflare Pages 에 GH_TOKEN 과 RUN_PASSWORD 를 넣어 주세요." }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 잘못됐습니다." }, 400);
  }
  if (!sameText(body.password || "", env.RUN_PASSWORD)) return json({ error: "비밀번호가 맞지 않습니다." }, 401);
  const member = String(body.member_id || "");
  if (!MEMBERS.includes(member)) return json({ error: "누구에게 넣을지 고르세요." }, 400);
  const amount = Math.floor(Number(body.amount) / 1000) * 1000;
  if (!(amount >= 10_000 && amount <= MAX_AMOUNT)) return json({ error: "1만원 ~ 1,000만원 사이로 넣으세요." }, 400);

  // 동시에 두 번 눌러도 기록이 사라지지 않게, 충돌이 나면 다시 읽어서 붙인다
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await gh(env, PATH + "?ref=main");
    let sha, data = { topups: [] };
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      try {
        data = JSON.parse(fromBase64(j.content));
      } catch {
        data = { topups: [] };
      }
    } else if (cur.status !== 404) {
      return json({ error: `GitHub 읽기 실패 ${cur.status}` }, 502);
    }
    const at = new Date().toISOString();
    data.topups = data.topups || [];
    data.topups.push({ id: `${at}-${member}`, member_id: member, amount, at });
    const r = await gh(env, PATH, {
      method: "PUT",
      body: JSON.stringify({
        message: `배팅 게임 금액 추가: ${member} ${amount.toLocaleString("ko-KR")}원`,
        content: toBase64(JSON.stringify(data, null, 2) + "\n"),
        branch: "main",
        ...(sha ? { sha } : {}),
      }),
    });
    if (r.ok) return json({ ok: true, member_id: member, amount });
    if (r.status !== 409 && r.status !== 422) {
      const hint = r.status === 401 || r.status === 403 ? " (GH_TOKEN 이 만료됐거나 권한이 부족합니다)" : "";
      return json({ error: `저장 실패 ${r.status}${hint}` }, 502);
    }
  }
  return json({ error: "다른 저장과 겹쳤습니다. 잠시 뒤 다시 눌러 주세요." }, 409);
}
