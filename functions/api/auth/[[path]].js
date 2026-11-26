// 회원 로그인 (카카오 · 구글). 비밀번호는 저장하지 않는다.
//
// GET  /api/auth/kakao            → 카카오 로그인 화면으로
// GET  /api/auth/google           → 구글 로그인 화면으로
// GET  /api/auth/{kakao|google}/callback
//        이미 가입한 사람 → 세션 만들고 첫 화면으로
//        처음 온 사람     → 15분짜리 '가입 대기' 표 만들고 /#join (닉네임·19세·약관 동의 화면)
// POST /api/auth/join   {nick, adult, terms}  → 가입 완료 + 세션
// POST /api/auth/logout
// POST /api/auth/delete  → 회원 탈퇴 (회원 정보·관심 경기·세션 모두 삭제)
// GET  /api/auth/nick?n= → 닉네임 사용 가능 여부
import { PENDING_COOKIE, SESSION_COOKIE, STATE_COOKIE, cookie, currentUser, json, randomToken, setCookie, sha, startSession } from "../../../lib/members.js";

const PROVIDERS = {
  kakao: {
    authorize: "https://kauth.kakao.com/oauth/authorize",
    token: "https://kauth.kakao.com/oauth/token",
    id: (env) => env.KAKAO_REST_KEY, secret: (env) => env.KAKAO_SECRET,
    scope: "profile_nickname",
    async profile(tok) {
      const r = await fetch("https://kapi.kakao.com/v2/user/me", { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!r.ok) throw new Error("kakao profile " + r.status);
      const p = await r.json();
      return { pid: "k:" + p.id, email: null, name: (p.properties && p.properties.nickname) || (p.kakao_account && p.kakao_account.profile && p.kakao_account.profile.nickname) || "" };
    },
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    id: (env) => env.GOOGLE_CLIENT_ID, secret: (env) => env.GOOGLE_SECRET,
    scope: "openid email profile",
    async profile(tok) {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!r.ok) throw new Error("google profile " + r.status);
      const p = await r.json();
      return { pid: "g:" + p.sub, email: p.email_verified ? p.email : null, name: p.name || "" };
    },
  },
};

const RESERVED = /(운영|관리|admin|레이즈|raise|공지|매니저|staff|system|시스템)/i;
const NICK_OK = /^[가-힣A-Za-z0-9_]{2,12}$/;

const redirect = (to, cookies = []) => {
  const h = new Headers({ Location: to, "cache-control": "no-store" });
  cookies.forEach((c) => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
};

async function nickProblem(env, nick) {
  if (!NICK_OK.test(nick)) return "닉네임은 한글·영문·숫자 2~12자로 정해 주세요.";
  if (RESERVED.test(nick)) return "쓸 수 없는 닉네임이에요.";
  const taken = await env.DB.prepare("SELECT 1 FROM users WHERE nick = ?").bind(nick).first();
  return taken ? "이미 쓰는 닉네임이에요." : null;
}

export async function onRequest({ request, env, params }) {
  const url = new URL(request.url);
  const [name, step] = params.path || [];
  if (!env.DB) return json({ error: "회원 저장소가 아직 연결되지 않았어요." }, 503);

  const p = PROVIDERS[name];
  if (p && request.method === "GET") {
    if (!p.id(env)) return json({ error: `${name === "kakao" ? "카카오" : "구글"} 로그인이 아직 준비 중이에요.` }, 503);
    const redirectUri = `${url.origin}/api/auth/${name}/callback`;
    if (!step) {
      const state = randomToken().slice(0, 32);
      const q = new URLSearchParams({ client_id: p.id(env), redirect_uri: redirectUri, response_type: "code", state, scope: p.scope });
      if (name === "google") q.set("prompt", "select_account");
      return redirect(`${p.authorize}?${q}`, [setCookie(STATE_COOKIE, state, 600)]);
    }
    if (step === "callback") {
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if (!code || !state || state !== cookie(request, STATE_COOKIE)) return redirect("/#login-fail");
      const body = new URLSearchParams({ grant_type: "authorization_code", client_id: p.id(env), redirect_uri: redirectUri, code });
      if (p.secret(env)) body.set("client_secret", p.secret(env));
      const tr = await fetch(p.token, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      if (!tr.ok) return redirect("/#login-fail");
      let prof;
      try { prof = await p.profile(await tr.json()); } catch (e) { return redirect("/#login-fail"); }
      const clear = setCookie(STATE_COOKIE, "", 0);
      const user = await env.DB.prepare("SELECT id FROM users WHERE provider_id = ?").bind(prof.pid).first();
      if (user) return redirect("/", [clear, await startSession(env, user.id)]);
      const tok = randomToken();
      await env.DB.prepare("DELETE FROM pending WHERE exp < ?").bind(Date.now()).run();
      await env.DB.prepare("INSERT INTO pending (hash, provider_id, email, name, exp) VALUES (?, ?, ?, ?, ?)")
        .bind(await sha(tok), prof.pid, prof.email, prof.name.slice(0, 40), Date.now() + 15 * 60e3).run();
      return redirect("/#join", [clear, setCookie(PENDING_COOKIE, tok, 900)]);
    }
  }

  if (name === "pending" && request.method === "GET") {
    const tok = cookie(request, PENDING_COOKIE);
    const row = tok && await env.DB.prepare("SELECT name, exp FROM pending WHERE hash = ?").bind(await sha(tok)).first();
    if (!row || row.exp < Date.now()) return json({ pending: false });
    const guess = String(row.name || "").replace(/[^가-힣A-Za-z0-9_]/g, "").slice(0, 12);
    return json({ pending: true, suggest: guess.length >= 2 ? guess : "" });
  }

  if (name === "nick" && request.method === "GET") {
    const n = String(url.searchParams.get("n") || "").trim();
    const why = await nickProblem(env, n);
    return json({ ok: !why, why });
  }

  if (request.method !== "POST") return json({ error: "not found" }, 404);
  // 다른 사이트에서 몰래 보내는 요청 막기
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);

  if (name === "join") {
    const tok = cookie(request, PENDING_COOKIE);
    const row = tok && await env.DB.prepare("SELECT * FROM pending WHERE hash = ?").bind(await sha(tok)).first();
    if (!row || row.exp < Date.now()) return json({ error: "가입 시간이 지났어요. 다시 로그인해 주세요." }, 400);
    let d = {};
    try { d = await request.json(); } catch (e) {}
    const nick = String(d.nick || "").trim();
    if (!d.adult) return json({ error: "만 19세 이상만 가입할 수 있어요." }, 400);
    if (!d.terms) return json({ error: "이용약관과 개인정보 처리방침에 동의해 주세요." }, 400);
    const why = await nickProblem(env, nick);
    if (why) return json({ error: why }, 400);
    const now = Date.now();
    const exists = await env.DB.prepare("SELECT id FROM users WHERE provider_id = ?").bind(row.provider_id).first();
    const uid = exists ? exists.id : (await env.DB.prepare(
      "INSERT INTO users (provider_id, nick, email, adult_at, terms_at, created) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
    ).bind(row.provider_id, nick, row.email, now, now, now).first()).id;
    await env.DB.prepare("DELETE FROM pending WHERE hash = ?").bind(await sha(tok)).run();
    const h = new Headers({ "content-type": "application/json; charset=utf-8" });
    h.append("Set-Cookie", await startSession(env, uid));
    h.append("Set-Cookie", setCookie(PENDING_COOKIE, "", 0));
    return new Response(JSON.stringify({ ok: true, nick }), { headers: h });
  }

  if (name === "logout") {
    const tok = cookie(request, SESSION_COOKIE);
    if (tok) await env.DB.prepare("DELETE FROM sessions WHERE hash = ?").bind(await sha(tok)).run();
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  }

  if (name === "delete") {
    const me = await currentUser(env, request);
    if (!me) return json({ error: "로그인이 필요해요." }, 401);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM favs WHERE uid = ?").bind(me.id),
      env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(me.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(me.id),
    ]);
    return json({ ok: true }, 200, { "Set-Cookie": setCookie(SESSION_COOKIE, "", 0) });
  }

  return json({ error: "not found" }, 404);
}
