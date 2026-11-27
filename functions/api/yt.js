// 회원·운영자 경기 화면의 '이 경기 쇼츠로 보기'용: RAISE Fulltime 유튜브 채널의 최근 영상 목록.
// 유튜브가 공개로 열어 둔 채널 RSS 를 읽어 {id, title, published} 로 돌려준다 (API 키·비용 없음).
// 10분 동안 Cloudflare 캐시에 둔다. 경기와의 연결은 화면(app.js)이 제목의 '홈 vs 원정'으로 한다.
const CHANNEL = "UCV7HEKoes_TA6RzeXGvghpQ";   // RAISE Fulltime (@raise-fulltime)

const unxml = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export async function onRequestGet({ env, request, waitUntil }) {
  const id = env.YT_CHANNEL || CHANNEL;
  const cache = caches.default;
  const key = new Request(new URL("/api/yt?c=" + id, request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;
  let items = [];
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { cf: { cacheTtl: 600 } });
    if (r.ok) {
      const xml = await r.text();
      items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
        id: (e.match(/<yt:videoId>([\w-]{6,20})<\/yt:videoId>/) || [])[1],
        title: unxml((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""),
        published: (e.match(/<published>([^<]+)<\/published>/) || [])[1] || "",
      })).filter((x) => x.id);
    }
  } catch (e) { /* 유튜브가 안 되면 빈 목록 → 화면은 쇼츠 칸 없이 그대로 */ }
  const res = new Response(JSON.stringify({ items }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=600" },
  });
  waitUntil(cache.put(key, res.clone()));
  return res;
}
