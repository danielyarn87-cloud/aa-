// GET /api/me → 지금 보는 사람: {user: {nick} | null, admin: bool, ready: {kakao, google, db}}
import { currentUser, isAdmin, json } from "../../lib/members.js";

export async function onRequestGet({ request, env }) {
  const user = await currentUser(env, request).catch(() => null);
  return json({
    user: user ? { nick: user.nick } : null,
    admin: isAdmin(request),
    ready: { db: !!env.DB, kakao: !!env.KAKAO_REST_KEY, google: !!env.GOOGLE_CLIENT_ID, chat: !!env.CHAT },
  });
}
