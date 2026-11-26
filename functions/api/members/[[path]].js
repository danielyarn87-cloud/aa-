// 회원 관리 (운영자 주소에서만. Cloudflare Access 로 잠긴 raise-bet.com · aa-2kp.pages.dev)
// GET  /api/members?q=닉네임      회원 목록 + 요약 숫자 + 채팅 제한 상태
// GET  /api/members/reports       채팅 신고함·제재 기록 (30일)
// POST /api/members/ban     {uid, nick, days}   채팅 제한 (days 0 = 영구)
// POST /api/members/unban   {uid}               제한 해제
// POST /api/members/done    {id, undo}          신고 처리 표시
// POST /api/members/hide    {id}                신고된 글 가리기
// POST /api/members/delete  {uid}               강제 탈퇴 (회원 정보·관심 경기·로그인 모두 삭제)
import { isAdmin, json } from "../../../lib/members.js";

const DAY = 86400e3;
const kstMidnight = (now) => { const d = new Date(now + 9 * 3600e3); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 9 * 3600e3; };

// 이메일은 앞 두 글자만 보여 준다 (da***@gmail.com)
const maskEmail = (e) => {
  if (!e) return null;
  const [id, host] = String(e).split("@");
  return (id.slice(0, 2) + "***") + (host ? "@" + host : "");
};

const room = (env) => env.CHAT && env.CHAT.get(env.CHAT.idFromName("main"));
const roomCall = async (env, op, body) => {
  const r = room(env);
  if (!r) return null;
  const res = await r.fetch(new Request("https://chat/admin/" + op, {
    method: body ? "POST" : "GET",
    headers: { "X-Chat-Role": "admin", "X-Chat-Uid": "admin", "X-Chat-Nick": "운영자", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return res.ok ? res.json() : null;
};

export async function onRequest({ request, env, params }) {
  if (!isAdmin(request)) return json({ error: "운영자만 볼 수 있어요." }, 403);
  if (!env.DB) return json({ error: "회원 저장소가 연결되지 않았어요." }, 503);
  const url = new URL(request.url);
  const op = (params.path || [])[0] || "";

  if (request.method === "GET") {
    if (op === "reports") {
      const r = room(env);
      if (!r) return json({ reports: [], bans: [] });
      return r.fetch(new Request("https://chat/reports", { headers: { "X-Chat-Role": "admin" } }));
    }
    if (op) return json({ error: "not found" }, 404);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 20);
    const now = Date.now();
    const list = await env.DB.prepare(
      `SELECT u.id, u.nick, u.provider_id, u.email, u.created, u.last_login,
              (SELECT COUNT(*) FROM favs f WHERE f.uid = u.id) AS favs
         FROM users u ${q ? "WHERE u.nick LIKE ?1" : ""}
        ORDER BY u.created DESC LIMIT 500`
    ).bind(...(q ? [`%${q}%`] : [])).all();
    const t0 = kstMidnight(now);
    const sum = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(created >= ?1) AS today,
              SUM(created >= ?2) AS week,
              SUM(last_login >= ?1) AS active_today,
              SUM(provider_id LIKE 'k:%') AS kakao,
              SUM(provider_id LIKE 'g:%') AS google
         FROM users`
    ).bind(t0, t0 - 6 * DAY).first();
    const users = (list.results || []).map((u) => ({
      id: u.id, nick: u.nick, provider: String(u.provider_id).startsWith("k:") ? "kakao" : "google",
      email: maskEmail(u.email), created: u.created, last_login: u.last_login, favs: u.favs,
    }));
    const chat = (await roomCall(env, "status", { uids: users.map((u) => String(u.id)) }).catch(() => null)) || { bans: {}, chatsToday: 0, openReports: 0, online: 0 };
    return json({ users, summary: { ...sum, chatsToday: chat.chatsToday, openReports: chat.openReports, online: chat.online }, bans: chat.bans });
  }

  if (request.method !== "POST") return json({ error: "method" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
  const d = await request.json().catch(() => ({}));
  const uid = Number(d.uid);

  if (op === "ban" || op === "unban") {
    if (!uid) return json({ error: "회원 번호가 없어요." }, 400);
    const r = await roomCall(env, op, { uid: String(uid), nick: d.nick, days: d.days, reason: d.reason });
    return r ? json(r) : json({ error: "채팅방에 연결하지 못했어요." }, 503);
  }
  if (op === "done" || op === "hide") {
    const r = await roomCall(env, op, { id: d.id, undo: !!d.undo });
    return r ? json(r) : json({ error: "채팅방에 연결하지 못했어요." }, 503);
  }
  if (op === "delete") {
    if (!uid) return json({ error: "회원 번호가 없어요." }, 400);
    const u = await env.DB.prepare("SELECT nick FROM users WHERE id = ?").bind(uid).first();
    if (!u) return json({ error: "이미 없는 회원이에요." }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM favs WHERE uid = ?").bind(uid),
      env.DB.prepare("DELETE FROM sessions WHERE uid = ?").bind(uid),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid),
    ]);
    await roomCall(env, "gone", { uid: String(uid) }).catch(() => null);
    return json({ ok: true, nick: u.nick });
  }
  return json({ error: "not found" }, 404);
}
