// 회원 로그인·세션 공통 도우미 (functions/api 의 Pages 함수들이 가져다 씀. functions 폴더 밖이라 주소로는 열리지 않는다).
//
// Cloudflare Pages → 설정에 필요한 것 (코드에 쓰지 않음):
//   D1 바인딩  DB    (raise-members, 스키마는 db/members.sql)
//   비밀 KAKAO_REST_KEY, KAKAO_SECRET          카카오 로그인
//   비밀 GOOGLE_CLIENT_ID, GOOGLE_SECRET       구글 로그인

export const SESSION_COOKIE = "rs";
export const PENDING_COOKIE = "rp";
export const STATE_COOKIE = "ro";
export const SESSION_DAYS = 30;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
export const setCookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

// 운영자 주소: Cloudflare Access 로 잠겨 있어서, 여기까지 온 요청은 운영자 본인이다
export const isOperatorHost = (host) => host === "raise-bet.com" || host === "www.raise-bet.com" || host === "aa-2kp.pages.dev" || host.endsWith(".aa-2kp.pages.dev");
export const isAdmin = (request) => isOperatorHost(new URL(request.url).hostname) && !!request.headers.get("Cf-Access-Jwt-Assertion");

export async function currentUser(env, request) {
  const tok = cookie(request, SESSION_COOKIE);
  if (!tok || !env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.nick FROM sessions s JOIN users u ON u.id = s.uid WHERE s.hash = ? AND s.exp > ?"
  ).bind(await sha(tok), Date.now()).first();
  return row || null;
}

export async function startSession(env, uid) {
  const tok = randomToken();
  await env.DB.prepare("INSERT INTO sessions (hash, uid, exp) VALUES (?, ?, ?)").bind(await sha(tok), uid, Date.now() + SESSION_DAYS * 86400e3).run();
  await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(Date.now(), uid).run();
  return setCookie(SESSION_COOKIE, tok, SESSION_DAYS * 86400);
}
