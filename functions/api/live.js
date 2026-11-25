// Cloudflare Pages 함수: 실시간 스코어.
//
// GET /api/live  →  {"at": "...", "live": {"AF-123": {"s": "2H", "m": 67, "h": 1, "a": 0}}}
//
// API-Football 에 "지금 진행 중인 경기 전부"를 한 번에 묻는다 (경기 수와 상관없이 요청 1회).
// 보는 사람이 몇 명이든 1분에 한 번만 묻도록 결과를 60초 동안 저장해 두고 나눠 준다.
// 저장소(GitHub)에는 아무것도 쓰지 않는다: 사이트 다시 만들기(월 500회 한도)를 쓰지 않는다.
//
// Cloudflare Pages → 설정 → 변수 및 비밀에 넣을 값 (코드에 쓰지 않음):
//   API_FOOTBALL_KEY  GitHub 비밀에 넣은 것과 같은 API-Football 키

const TTL = 60;                                   // 초: 이 시간 안에는 API-Football 에 다시 묻지 않는다
const CACHE_KEY = "https://aa-live.cache/v1/live";
let memo = null;                                  // 같은 서버 안에서 한 번 더 아끼는 저장 {t, body}
let good = null;                                  // 마지막으로 제대로 받은 값 (API 오류 때 대신 준다)

const out = (body, maxAge = TTL - 5) =>
  new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
  });

export function shrink(apiBody) {
  const live = {};
  for (const x of (apiBody && apiBody.response) || []) {
    const f = x.fixture || {}, g = x.goals || {};
    if (f.id == null) continue;
    live["AF-" + f.id] = { s: (f.status || {}).short || "", m: (f.status || {}).elapsed ?? null, h: g.home ?? 0, a: g.away ?? 0 };
  }
  return live;
}

export async function onRequestGet({ env }) {
  const now = Date.now();
  if (memo && now - memo.t < TTL * 1000) return out(memo.body);

  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    const hit = await cache.match(CACHE_KEY);
    if (hit) return out(await hit.text());
  }

  if (!env.API_FOOTBALL_KEY) return out(JSON.stringify({ error: "no_key", live: {} }), 300);

  let body;
  try {
    const r = await fetch("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": env.API_FOOTBALL_KEY },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    // API-Football 은 키가 틀리거나 한도를 넘어도 200 으로 답하고 errors 에 이유를 담는다 → "0경기"와 구분
    const errs = j && j.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
      // 오류(예: 1분당 한도 초과)면 직전에 제대로 받은 점수를 그대로 준다. 30초 뒤에 다시 시도.
      const b = good || JSON.stringify({ at: new Date(now).toISOString(), error: "api_error", detail: errs, live: {} });
      memo = { t: now - (TTL - 30) * 1000, body: b };   // 30초 동안은 다시 묻지 않는다
      return out(b, 30);
    }
    body = JSON.stringify({ at: new Date(now).toISOString(), live: shrink(j) });
  } catch (e) {
    // 실패하면 직전 값이라도 준다 (없으면 빈 값). 30초 뒤에 다시 시도.
    return out(good || JSON.stringify({ error: "fetch_failed", detail: String(e.message || e), live: {} }), 30);
  }
  good = body;

  memo = { t: now, body };
  if (cache) await cache.put(CACHE_KEY, new Response(body, { headers: { "Cache-Control": `public, max-age=${TTL}` } }));
  return out(body);
}
