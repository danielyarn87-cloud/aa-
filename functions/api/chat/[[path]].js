// 실시간 채팅방 입구. 누가 들어오는지 확인해서 채팅 서버(raise-chat 워커의 ChatRoom)로 넘긴다.
// GET /api/chat           (WebSocket)  회원·운영자는 말하기, 비회원은 읽기만
// GET /api/chat/reports   운영자만: 신고·차단 기록 30일
//
// Cloudflare Pages → 바인딩: Durable Object CHAT → 워커 raise-chat 의 ChatRoom
import { currentUser, isAdmin, json } from "../../../lib/members.js";

export async function onRequestGet({ request, env, params }) {
  if (!env.CHAT) return json({ error: "채팅방 준비 중이에요." }, 503);
  const admin = isAdmin(request);
  const sub = (params.path || [])[0] || "";
  const h = new Headers();
  if (admin) { h.set("X-Chat-Role", "admin"); h.set("X-Chat-Uid", "admin"); h.set("X-Chat-Nick", "운영자"); }
  else {
    const me = await currentUser(env, request).catch(() => null);
    if (me) { h.set("X-Chat-Role", "member"); h.set("X-Chat-Uid", String(me.id)); h.set("X-Chat-Nick", me.nick); }
    else h.set("X-Chat-Role", "guest");
  }
  const room = env.CHAT.get(env.CHAT.idFromName("main"));
  if (sub === "reports") {
    if (!admin) return json({ error: "forbidden" }, 403);
    return room.fetch(new Request("https://chat/reports", { headers: h }));
  }
  if (request.headers.get("Upgrade") !== "websocket") return json({ error: "websocket only" }, 426);
  // 다른 사이트에서 몰래 붙는 것 막기
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "forbidden" }, 403);
  h.set("Upgrade", "websocket");
  return room.fetch(new Request("https://chat/ws", { headers: h }));
}
