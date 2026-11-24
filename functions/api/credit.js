// Cloudflare Pages 함수: Claude 크레딧 잔액 입력 (Console 잔액은 밖에서 읽을 수 없어서 직접 넣는다).
// 비밀번호는 '분석 요청'과 같은 RUN_PASSWORD. 기록은 저장소의 data/credit.json 에 쌓인다 (aa/credit.py 가 계산).
//
// POST /api/credit  {"password", "value": "68.75"}   Console 에 보이는 잔액으로 맞추기
//                   {"password", "value": "+20"}     충전한 금액만 더하기

const PATH = "/contents/data/credit.json";

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
  const raw = String(body.value ?? "").replace(/[$,\s]/g, "");
  const add = raw.startsWith("+");
  const usd = Math.round(Number(add ? raw.slice(1) : raw) * 100) / 100;
  if (!Number.isFinite(usd) || usd < 0 || usd > 100000 || (add && usd <= 0)) {
    return json({ error: "금액을 달러로 넣으세요. 예: 48.75 (잔액) 또는 +20 (충전한 금액)" }, 400);
  }
  const type = add ? "add" : "set";

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await gh(env, PATH + "?ref=main");
    let sha, data = { events: [] };
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      try {
        data = JSON.parse(fromBase64(j.content));
      } catch {
        data = { events: [] };
      }
    } else if (cur.status !== 404) {
      return json({ error: `GitHub 읽기 실패 ${cur.status}` }, 502);
    }
    data.events = data.events || [];
    data.events.push({ at: new Date().toISOString(), type, usd });
    const r = await gh(env, PATH, {
      method: "PUT",
      body: JSON.stringify({
        message: add ? `Claude 크레딧 충전 +$${usd}` : `Claude 크레딧 잔액 $${usd}`,
        content: toBase64(JSON.stringify(data, null, 2) + "\n"),
        branch: "main",
        ...(sha ? { sha } : {}),
      }),
    });
    if (r.ok) return json({ ok: true, type, usd });
    if (r.status !== 409 && r.status !== 422) {
      const hint = r.status === 401 || r.status === 403 ? " (GH_TOKEN 이 만료됐거나 권한이 부족합니다)" : "";
      return json({ error: `저장 실패 ${r.status}${hint}` }, 502);
    }
  }
  return json({ error: "다른 저장과 겹쳤습니다. 잠시 뒤 다시 눌러 주세요." }, 409);
}
