// Cloudflare Pages 함수: 분석한 경기의 배당 변화 기록 + 배당 API 사용량.
//
// GET  /api/odds          {usage, hist: {"AF-1": [{t, k, home, draw, away, over, under, line}]}, at}
// POST /api/odds/refresh  (GitHub Actions 가 매시 17분·47분에 부름) 아래 두 가지만 한다:
//        - 1시간마다: 분석했고 아직 시작 안 한 48시간 안 경기들의 배당 (k: "hour")
//        - 마감 직전: 15~50분 뒤 시작하는 분석 경기의 마지막 배당, 경기마다 한 번 (k: "final")
//        누가 몇 번 불러도 위 조건을 넘는 호출은 하지 않는다 (배당 API 크레딧 보호).
// POST /api/odds/usage    배당 API 사용량만 새로 읽기 (크레딧을 쓰지 않는 종목 목록 조회, 1분에 한 번)
//
// 배당 API 는 리그 단위로 부르므로 비용 = 리그 수 x 2 크레딧 (승무패+언더오버). 사이트를 다시 만들지 않고
// Cloudflare KV 에 저장한다 (월 500회 빌드 한도와 무관).
//
// Cloudflare Pages → 설정에 필요한 것 (코드에 쓰지 않음):
//   KV 바인딩 ODDS       (Workers 및 Pages → KV 에서 만든 저장 공간)
//   ODDS_API_KEY        The Odds API 키 (GitHub 비밀과 같은 값)

const BASE = "https://api.the-odds-api.com/v4";
const STATE = "state-v1";
const HOUR_GAP = 50 * 60e3;          // 1시간 갱신 사이 최소 간격
const AHEAD = 48 * 3600e3;           // 이 안에 시작하는 경기만
const KEEP = 3 * 24 * 3600e3;        // 시작하고 3일 지난 기록은 지운다

const json = (data, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });

async function loadState(env) {
  const s = (await env.ODDS.get(STATE, "json")) || {};
  return { hist: s.hist || {}, final: s.final || {}, last_hour: s.last_hour || 0, usage: s.usage || null, at: s.at || null };
}

function readUsage(r, state) {
  const used = r.headers.get("x-requests-used"), rem = r.headers.get("x-requests-remaining");
  if (used != null && rem != null) state.usage = { used: +used, remaining: +rem, at: new Date().toISOString() };
}

const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

// 여러 북메이커 배당 평균 (aa/sources/odds_api.py 의 consensus 와 같은 방식). 기준점은 분석 때 기준점에 고정.
export function consensus(ev, line) {
  const H = [], D = [], A = [], O = [], U = [];
  for (const b of ev.bookmakers || []) {
    for (const m of b.markets || []) {
      if (m.key === "h2h") {
        const p = {};
        for (const o of m.outcomes) {
          const k = o.name === ev.home_team ? "h" : o.name === ev.away_team ? "a" : String(o.name).toLowerCase() === "draw" ? "d" : null;
          if (k) p[k] = +o.price;
        }
        if (p.h && p.d && p.a) { H.push(p.h); D.push(p.d); A.push(p.a); }
      } else if (m.key === "totals") {
        const p = {};
        for (const o of m.outcomes) if (+o.point === +line) p[String(o.name).toLowerCase()] = +o.price;
        if (p.over && p.under) { O.push(p.over); U.push(p.under); }
      }
    }
  }
  return { home: avg(H), draw: avg(D), away: avg(A), over: avg(O), under: avg(U), line };
}

async function trackedMatches(env, request) {
  const r = await env.ASSETS.fetch(new URL("/api/matches.json", request.url));
  if (!r.ok) return [];
  const now = Date.now();
  return ((await r.json()).matches || []).filter((m) => {
    const o = m.odds_now || m.odds || {};
    const ko = Date.parse(m.kickoff_iso || "");
    return m.status === "analyzed" && !m.result && o.event_id && o.sport && ko > now && ko - now < AHEAD;
  });
}

async function fetchSport(env, sport, ids, state) {
  const q = new URLSearchParams({ apiKey: env.ODDS_API_KEY, regions: "eu", markets: "h2h,totals", oddsFormat: "decimal", eventIds: ids.join(",") });
  const r = await fetch(`${BASE}/sports/${sport}/odds?${q}`);
  readUsage(r, state);
  if (!r.ok) throw new Error(`배당 API ${r.status}`);
  return r.json();
}

async function refresh(env, request) {
  const state = await loadState(env);
  const now = Date.now();
  const matches = await trackedMatches(env, request);
  const hourly = now - state.last_hour >= HOUR_GAP;
  const finals = matches.filter((m) => { const d = Date.parse(m.kickoff_iso) - now; return d > 15 * 60e3 && d < 50 * 60e3 && !state.final[m.id]; });
  const want = hourly ? matches : finals;
  const done = { hour: 0, final: 0, sports: 0 };
  if (want.length) {
    const bySport = {};
    for (const m of want) (bySport[(m.odds_now || m.odds).sport] ||= []).push(m);
    for (const [sport, ms] of Object.entries(bySport)) {
      let events;
      try { events = await fetchSport(env, sport, ms.map((m) => (m.odds_now || m.odds).event_id), state); } catch (e) { continue; }
      done.sports++;
      const byId = Object.fromEntries(events.map((e) => [e.id, e]));
      for (const m of ms) {
        const ev = byId[(m.odds_now || m.odds).event_id];
        if (!ev) continue;
        const isFinal = finals.some((f) => f.id === m.id);
        const snap = { t: new Date(now).toISOString(), k: isFinal ? "final" : "hour", ...consensus(ev, m.line ?? (m.odds_now || m.odds).line ?? 2.5) };
        if (snap.home == null) continue;
        (state.hist[m.id] ||= []).push(snap);
        if (isFinal) { state.final[m.id] = true; done.final++; } else done.hour++;
      }
    }
    if (hourly) state.last_hour = now;
  }
  // 오래된 기록 정리
  const live = new Set(matches.map((m) => m.id));
  for (const id of Object.keys(state.hist)) {
    const last = state.hist[id][state.hist[id].length - 1];
    if (!live.has(id) && last && now - Date.parse(last.t) > KEEP) { delete state.hist[id]; delete state.final[id]; }
  }
  state.at = new Date(now).toISOString();
  await env.ODDS.put(STATE, JSON.stringify(state));
  return { ok: true, tracked: matches.length, hourly, ...done, usage: state.usage };
}

export async function onRequest({ request, env, params }) {
  if (!env.ODDS) return json({ error: "no_kv", hist: {} }, 200, "public, max-age=300");
  const action = (params.path || [])[0] || "";
  if (request.method === "GET" && !action) {
    const s = await loadState(env);
    return json({ hist: s.hist, usage: s.usage, at: s.at }, 200, "public, max-age=60");
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (!env.ODDS_API_KEY) return json({ error: "no_key" }, 503);
  if (action === "refresh") return json(await refresh(env, request));
  if (action === "usage") {
    const state = await loadState(env);
    if (state.usage && Date.now() - Date.parse(state.usage.at) < 60e3) return json({ ok: true, usage: state.usage });
    const r = await fetch(`${BASE}/sports?apiKey=${encodeURIComponent(env.ODDS_API_KEY)}`);   // 크레딧 0
    readUsage(r, state);
    await env.ODDS.put(STATE, JSON.stringify(state));
    return json({ ok: r.ok, usage: state.usage });
  }
  return json({ error: "unknown" }, 404);
}
