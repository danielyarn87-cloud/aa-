// 주소(도메인)별로 보여 줄 화면을 나눈다. 모든 요청이 여기를 먼저 지난다 (Cloudflare Pages Functions).
//   raise-lucky.com → /fortune/ (오늘의 운세) 만
//   raise-lotto.com → /lotto/   (로또) 만
//   그 밖(aa-2kp.pages.dev 등) → 지금 그대로 RAISE
// 운세·로또 주소로 들어온 요청은 무엇을 치든 그 폴더 안의 파일만 돌려준다.
// 그래서 RAISE 관리 화면·분석 요청·/api/* 는 두 도메인에서 절대 보이지 않는다.
const SITES = {
  "raise-lucky.com": "/fortune",
  "www.raise-lucky.com": "/fortune",
  "raise-lotto.com": "/lotto",
  "www.raise-lotto.com": "/lotto",
};

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const base = SITES[url.hostname];
  if (!base) return ctx.next();                       // RAISE: 그대로
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
