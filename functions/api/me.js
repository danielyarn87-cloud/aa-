// GET /api/me → 지금 보는 사람: {user: {nick} | null, admin: bool, ready: {kakao, google, db}}
import { currentUser, ensureBoard, isAdmin, json } from "../../lib/members.js";

export async function onRequestGet({ request, env }) {
  const user = await currentUser(env, request).catch(() => null);
  let unread = 0;   // 답변이 달렸는데 아직 안 본 1:1 문의
  if (user) {
    try { await ensureBoard(env); const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE uid = ? AND seen = 0").bind(user.id).first(); unread = r ? r.n : 0; } catch (e) {}
  }
  return json({
    user: user ? { nick: user.nick, unread } : null,
    admin: isAdmin(request),
    ready: { db: !!env.DB, kakao: !!env.KAKAO_REST_KEY, google: !!env.GOOGLE_CLIENT_ID, chat: !!env.CHAT },
  });
}
