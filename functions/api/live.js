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
const GOOD_KEY = "https://aa-live.cache/v1/good";   // 마지막으로 제대로 받은 점수 (10분 보관: 배포 직후·한도 초과 때 대신 준다)
const GOOD_TTL = 600;
let memo = null;                                  // 같은 서버 안에서 한 번 더 아끼는 저장 {t, body}
let good = null;                                  // 마지막으로 제대로 받은 값 (API 오류 때 대신 준다)

const out = (body, maxAge = TTL - 5) =>
  new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
  });

// 경기 사건(events)에서 카드 수: yh·ya 옐로(홈·원정), rh·ra 레드(경고 누적 퇴장 포함). 0장은 넣지 않는다.
export function cardsOf(x) {
  const home = ((x.teams || {}).home || {}).id, c = {};
  for (const e of (x && x.events) || []) {
    if (e.type !== "Card") continue;
    const d = String(e.detail || "").toLowerCase();
    const k = (d.includes("red") || d.includes("second") ? "r" : "y") + ((e.team || {}).id === home ? "h" : "a");
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

export function shrink(apiBody) {
  const live = {};
  for (const x of (apiBody && apiBody.response) || []) {
    const f = x.fixture || {}, g = x.goals || {};
    if (f.id == null) continue;
    live["AF-" + f.id] = { s: (f.status || {}).short || "", m: (f.status || {}).elapsed ?? null, h: g.home ?? 0, a: g.away ?? 0, ...cardsOf(x) };
  }
  return live;
}

// API 가 실패하면: 이 서버가 기억하는 점수 → 캐시에 10분 보관한 점수 → 그래도 없으면 오류 표시.
// 그 답을 30초 동안 캐시에 두어, 같은 지역의 다른 서버들도 그동안 API 를 다시 두드리지 않게 한다.
async function fallback(cache, now, errBody) {
  let b = good;
  if (!b && cache) {
    const hit = await cache.match(GOOD_KEY);
    if (hit) b = await hit.text();
  }
  b = b || errBody;
  memo = { t: now - (TTL - 30) * 1000, body: b };
  if (cache) await cache.put(CACHE_KEY, new Response(b, { headers: { "Cache-Control": "public, max-age=30" } }));
  return out(b, 30);
}

// ---- 끝난 경기 최종 스코어 ----
// GET /api/live?ended=AF-1,AF-2 → {"at": "...", "final": {"AF-1": {"s": "FT", "h": 2, "a": 1}}}
// 실시간 목록(live=all)은 끝난 경기를 빼 버려서, '결과 반영 대기' 경기의 최종 점수는 경기 번호로 따로 묻는다 (20경기까지 요청 1회).
// 최종 점수는 바뀌지 않으므로 한 번 받으면 이 서버와 캐시에 하루 보관한다. 같은 서버에서는 1분에 한 번만 API 에 묻는다.
const FINAL_DONE = ["FT", "AET", "PEN", "AWD", "WO"];
const finals = {};
let endedAt = 0;
const finalKey = id => "https://aa-live.cache/v1/final/" + id;

export function pickFinals(apiBody) {
  const out = {};
  for (const x of (apiBody && apiBody.response) || []) {
    const f = x.fixture || {}, s = (f.status || {}).short || "";
    if (f.id == null || !FINAL_DONE.includes(s)) continue;
    const g = x.goals || {}, pen = (x.score || {}).penalty || {};
    const v = { s, h: g.home ?? 0, a: g.away ?? 0, ...cardsOf(x) };
    if (pen.home != null && pen.away != null) v.p = [pen.home, pen.away];
    out["AF-" + f.id] = v;
  }
  return out;
}

async function ended(env, raw, now) {
  const want = [...new Set(String(raw).split(","))].filter(id => /^AF-\d+$/.test(id)).slice(0, 20);
  const res = {}, miss = [];
  for (const id of want) finals[id] ? (res[id] = finals[id]) : miss.push(id);
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (cache) {
    for (const id of miss.slice()) {
      const hit = await cache.match(finalKey(id));
      if (hit) { finals[id] = res[id] = await hit.json(); miss.splice(miss.indexOf(id), 1); }
    }
  }
  if (miss.length && env.API_FOOTBALL_KEY && now - endedAt > 60e3) {
    endedAt = now;
    try {
      const r = await fetch("https://v3.football.api-sports.io/fixtures?ids=" + miss.map(id => id.slice(3)).join("-"), {
        headers: { "x-apisports-key": env.API_FOOTBALL_KEY },
      });
      const got = pickFinals(await r.json());
      for (const [id, v] of Object.entries(got)) {
        finals[id] = res[id] = v;
        if (cache) await cache.put(finalKey(id), new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } }));
      }
    } catch (e) { /* 오류면 다음 번에 다시 */ }
  }
  return out(JSON.stringify({ at: new Date(now).toISOString(), final: res }));
}

export async function onRequestGet({ request, env }) {
  const now = Date.now();
  const q = request ? new URL(request.url).searchParams.get("ended") : null;
  if (q) return await ended(env, q, now);
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
      // 오류(예: 1분당 한도 초과)면 직전에 제대로 받은 점수를 그대로 준다. 30초 동안은 다시 묻지 않는다.
      return await fallback(cache, now, JSON.stringify({ at: new Date(now).toISOString(), error: "api_error", detail: errs, live: {} }));
    }
    body = JSON.stringify({ at: new Date(now).toISOString(), live: shrink(j) });
  } catch (e) {
    return await fallback(cache, now, JSON.stringify({ error: "fetch_failed", detail: String(e.message || e), live: {} }));
  }
  good = body;
  if (cache) await cache.put(GOOD_KEY, new Response(body, { headers: { "Cache-Control": `public, max-age=${GOOD_TTL}` } }));

  memo = { t: now, body };
  if (cache) await cache.put(CACHE_KEY, new Response(body, { headers: { "Cache-Control": `public, max-age=${TTL}` } }));
  return out(body);
}
