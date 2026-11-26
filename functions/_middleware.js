// 주소(도메인)별로 보여 줄 화면을 나눈다. 모든 요청이 여기를 먼저 지난다 (Cloudflare Pages Functions).
//   raise-lucky.com → /fortune/ (오늘의 운세) 만
//   raise-lotto.com → /lotto/   (로또) 만
//   raise-fulltime.com → RAISE 회원 화면 (검색 허용, 관리·분석 요청 API 막음. 화면 차이는 app.js 의 MEMBER)
//   raise-bet.com, aa-2kp.pages.dev → RAISE 운영자 화면 (검색엔진에 안 뜨게 noindex)
// 운세·로또 주소로 들어온 요청은 무엇을 치든 그 폴더 안의 파일만 돌려준다.
// 그래서 RAISE 관리 화면·분석 요청·/api/* 는 두 도메인에서 절대 보이지 않는다.
const SITES = {
  "raise-lucky.com": "/fortune",
  "www.raise-lucky.com": "/fortune",
  "raise-lotto.com": "/lotto",
  "www.raise-lotto.com": "/lotto",
};

const MEMBER_HOSTS = new Set(["raise-fulltime.com", "www.raise-fulltime.com"]);
const MEMBER_ORIGIN = "https://raise-fulltime.com";
// 회원 주소에서 막는 API: 분석 요청·관리·충전 (화면에서도 숨기지만 주소를 직접 쳐도 안 되게)
const MEMBER_BLOCK = /^\/api\/(run|admin|topup)(\/|$)/;

async function raise(ctx, url) {
  const host = url.hostname;
  if (MEMBER_HOSTS.has(host)) {
    if (host.startsWith("www.")) return Response.redirect(MEMBER_ORIGIN + url.pathname + url.search, 301);
    if (url.pathname === "/robots.txt")
      return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${MEMBER_ORIGIN}/sitemap.xml\n`, {headers: {"content-type": "text/plain; charset=utf-8"}});
    if (url.pathname === "/sitemap.xml")
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${MEMBER_ORIGIN}/</loc><changefreq>hourly</changefreq></url></urlset>\n`, {headers: {"content-type": "application/xml; charset=utf-8"}});
    // 배당 갱신(POST /api/odds/refresh)은 예외: 시계(raise-clock)가 여기로 부른다. 운영자 주소는 잠겨 있어서.
    //   갱신은 몇 번 불러도 정해진 간격을 넘는 호출을 하지 않게 만들어져 있다.
    const oddsRefresh = url.pathname === "/api/odds/refresh" && ctx.request.method === "POST";
    // 회원 기능(로그인·가입·탈퇴·관심 경기)은 POST 허용
    const memberPost = /^\/api\/(auth\/(join|logout|delete)|fav)$/.test(url.pathname) && ctx.request.method === "POST";
    if (MEMBER_BLOCK.test(url.pathname) || (!oddsRefresh && !memberPost && url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(ctx.request.method)))
      return new Response("Not Found", {status: 404});
    return ctx.next();
  }
  // 운영자 주소: 검색엔진에 올리지 않는다
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", {headers: {"content-type": "text/plain; charset=utf-8"}});
  const res = await ctx.next();
  const out = new Response(res.body, res);
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const base = SITES[url.hostname];
  if (!base) return raise(ctx, url);                  // RAISE: 회원·운영자 주소별로
  if (!["GET", "HEAD"].includes(ctx.request.method)) return new Response("Method Not Allowed", { status: 405 });
  let p = url.pathname;                                // URL 이 이미 ../ 를 정리해 둠
  if (p !== base && !p.startsWith(base + "/")) p = base + (p === "/" ? "/" : p);
  else if (p === base) p = base + "/";
  url.pathname = p;
  const res = await ctx.env.ASSETS.fetch(new Request(url.toString(), { method: ctx.request.method, headers: ctx.request.headers }));
  // 이 폴더 밖으로 넘기는 주소 이동(리다이렉트)은 막는다
  const loc = res.headers.get("location");
  if (loc) {
    const to = new URL(loc, url);
    if (to.hostname === url.hostname && !to.pathname.startsWith(base + "/")) return new Response("Not Found", { status: 404 });
  }
  return res;
}
