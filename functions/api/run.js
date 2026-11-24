// Cloudflare Pages 함수: 사이트의 '분석 요청' 버튼 → GitHub Actions "매일 분석" 실행.
//
// Cloudflare Pages → 설정 → 변수 및 비밀(Variables and Secrets)에 넣을 값 (코드에 쓰지 않음):
//   GH_TOKEN      GitHub 세분화된 토큰. 저장소 aa- 하나만, 권한 Actions: 읽기/쓰기, Contents: 읽기/쓰기
//   RUN_PASSWORD  분석 요청 비밀번호 (아무나 눌러서 API 비용을 쓰지 못하게)
//   GH_REPO       (선택) 기본값 danielyarn87-cloud/aa-
//
// POST /api/run  {"password", "ids": ["AF-1", "AF-2"]}              고른 경기만 분석 (최대 40)
//                {"password", "leagues": [39, 140], "save_default"}   경기 목록만 새로 모으기 (분석 없음)
// GET  /api/run  최근 실행 3개의 상태 (비밀번호 필요 없음)

const WORKFLOW = "daily.yml";

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

// 길이가 달라도 시간이 같게 비교 (비밀번호 추측 방지)
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

async function saveDefault(env, leagues) {
  const path = "/contents/data/settings.json";
  const cur = await gh(env, path + "?ref=main");
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const body = {
    message: `기본 리그 저장: ${leagues.join(",")}`,
    content: toBase64(JSON.stringify({ leagues, updated_at: new Date().toISOString() }, null, 2) + "\n"),
    branch: "main",
    ...(sha ? { sha } : {}),
  };
  const r = await gh(env, path, { method: "PUT", body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`기본 리그 저장 실패 (GitHub ${r.status})`);
}

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

  // 고른 경기만 분석: {"ids": ["AF-1", ...]}  /  경기 목록만 새로 모으기(분석 없음, Claude 비용 없음): {"leagues": [...]}
  const ids = [...new Set((body.ids || []).map(String))].filter((x) => /^[A-Z]{1,5}-\d{1,12}$/.test(x));
  if ((body.ids || []).length && !ids.length) return json({ error: "고른 경기 번호가 올바르지 않습니다." }, 400);
  if (ids.length > 40) return json({ error: "한 번에 40경기까지 고를 수 있습니다." }, 400);

  let inputs;
  if (ids.length) {
    inputs = { ids: ids.join(","), light: "false", mock: "false" };
  } else {
    const leagues = [...new Set((body.leagues || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (!leagues.length || leagues.length > 20) return json({ error: "리그를 1~20개 고르세요." }, 400);
    try {
      if (body.save_default) await saveDefault(env, leagues);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    inputs = { leagues: leagues.join(","), days: "7", light: "false", mock: "false" };
  }
  const r = await gh(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (r.status !== 204) {
    const detail = await r.text();
    const hint = r.status === 401 || r.status === 403 ? " (GH_TOKEN 이 만료됐거나 권한이 부족합니다)" : "";
    return json({ error: `GitHub 실행 요청 실패 ${r.status}${hint}`, detail: detail.slice(0, 300) }, 502);
  }
  return json({ ok: true, inputs, picked: ids.length, saved_default: !ids.length && !!body.save_default });
}

export async function onRequestGet({ env }) {
  if (!env.GH_TOKEN) return json({ configured: false, runs: [] });
  const r = await gh(env, `/actions/workflows/${WORKFLOW}/runs?per_page=3`);
  if (!r.ok) return json({ configured: true, error: `GitHub ${r.status}`, runs: [] }, 502);
  const data = await r.json();
  const runs = (data.workflow_runs || []).map((x) => ({
    number: x.run_number,
    status: x.status, // queued | in_progress | completed
    conclusion: x.conclusion, // success | failure | cancelled | null
    event: x.event, // schedule | workflow_dispatch
    created_at: x.created_at,
    updated_at: x.updated_at,
  }));
  return json({ configured: true, runs });
}
