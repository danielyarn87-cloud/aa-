// 운영자 '쇼츠' 화면용 (회원 주소에서는 미들웨어가 막음, 운영자 주소는 Cloudflare Access 잠금)
//
// GET  /api/shorts              쇼츠 목록 (shorts 브랜치의 index.json) + 고른 리그(data/shorts.json)
// GET  /api/shorts/file/<이름>  영상(.mp4)·썸네일(.jpg) 내려받기 (내려받기 창이 뜨게 이름을 붙여 보냄)
// POST /api/shorts/leagues      {"leagues": [39, 140]} 쇼츠 만들 리그 저장 → 다음 분석 실행부터 적용
//
// 영상은 GitHub Actions(daily.yml)가 tools/make_shorts_batch.py 로 만들어 'shorts' 브랜치에 올린다.
const REPO = (env) => env.GH_REPO || "danielyarn87-cloud/aa-";
const raw = (env, ref, path) => `https://raw.githubusercontent.com/${REPO(env)}/${ref}/${path}`;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO(env)}${path}`, {
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

async function readJson(url) {
  const r = await fetch(url, { cf: { cacheTtl: 30 } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

export async function onRequestGet({ env, params }) {
  const parts = params.path || [];
  if (parts[0] === "file" && parts[1]) {
    const name = String(parts[1]);
    if (!/^[A-Z]{1,5}-\d{1,12}-[0-9a-f]{6,40}(-t\d{1,3})?\.(mp4|jpg)$/.test(name)) return new Response("Not Found", { status: 404 });
    const jpg = name.endsWith(".jpg");
    const r = await fetch(raw(env, "shorts", name), { cf: { cacheTtl: 3600 } });
    if (!r.ok) return new Response("영상이 없어요. 경기가 이미 시작됐거나 다시 만들어졌을 수 있어요.", { status: 404 });
    return new Response(r.body, {
      headers: {
        "Content-Type": jpg ? "image/jpeg" : "video/mp4",
        "Content-Disposition": `attachment; filename="raise-${jpg ? name.replace(/(-t\d+)?\.jpg$/, "-thumbnail.jpg") : name}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  }
  const [index, cfg] = await Promise.all([readJson(raw(env, "shorts", "index.json")), readJson(raw(env, "main", "data/shorts.json"))]);
  return json({ index: index || { items: [] }, leagues: (cfg && cfg.leagues) || [] });
}

export async function onRequestPost({ request, env, params }) {
  const parts = params.path || [];
  if (parts[0] !== "leagues") return json({ error: "Not Found" }, 404);
  if (!env.GH_TOKEN) return json({ error: "GH_TOKEN 이 없어 저장할 수 없어요." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 잘못됐어요." }, 400); }
  const leagues = [...new Set((body.leagues || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0 && n < 100000).sort((a, b) => a - b);
  if (leagues.length > 40) return json({ error: "리그가 너무 많아요." }, 400);
  const path = "/contents/data/shorts.json";
  const cur = await gh(env, path + "?ref=main");
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const r = await gh(env, path, {
    method: "PUT",
    body: JSON.stringify({
      message: `쇼츠 리그 저장: ${leagues.join(",") || "없음"}`,
      content: toBase64(JSON.stringify({ leagues, updated_at: new Date().toISOString() }, null, 2) + "\n"),
      branch: "main",
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) return json({ error: `저장 실패 (GitHub ${r.status})` }, 502);
  return json({ ok: true, leagues });
}
