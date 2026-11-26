// 1:1 문의
// GET  /api/inquiry            내 문의 목록 (회원)
// POST /api/inquiry            {kind, title, body} 문의 쓰기 (회원, 하루 5개까지)
// POST /api/inquiry/seen       답변 읽음 표시 (회원)
// GET  /api/inquiry/all?state=open|done   전체 문의 (운영자 주소만)
// POST /api/inquiry/answer     {id, answer} 답변 (운영자 주소만)
import { currentUser, ensureBoard, isAdmin, json } from "../../../lib/members.js";

const KINDS = ["오류 신고", "계정", "제안", "광고·제휴", "기타"];

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ error: "준비 중이에요." }, 503);
  await ensureBoard(env);
  const url = new URL(request.url);
  const op = (params.path || [])[0] || "";
  if (request.method === "POST") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
  }

  if (op === "all" || op === "answer") {
    if (!isAdmin(request)) return json({ error: "운영자만 볼 수 있어요." }, 403);
    if (op === "all") {
      const done = url.searchParams.get("state") === "done";
      const r = await env.DB.prepare(`SELECT * FROM inquiries WHERE answer IS ${done ? "NOT NULL" : "NULL"} ORDER BY created ${done ? "DESC" : "ASC"} LIMIT 200`).all();
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE answer IS NULL").first();
      return json({ inquiries: r.results || [], open: open ? open.n : 0 });
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const d = await request.json().catch(() => ({}));
    const answer = String(d.answer || "").trim().slice(0, 3000);
    if (!answer) return json({ error: "답변을 써 주세요." }, 400);
    await env.DB.prepare("UPDATE inquiries SET answer = ?, answered_at = ?, seen = 0 WHERE id = ?").bind(answer, Date.now(), +d.id).run();
    return json({ ok: true });
  }

  const me = await currentUser(env, request).catch(() => null);
  if (!me) return json({ error: "로그인이 필요해요." }, 401);

  if (request.method === "GET" && !op) {
    const r = await env.DB.prepare("SELECT id, kind, title, body, created, answer, answered_at, seen FROM inquiries WHERE uid = ? ORDER BY created DESC LIMIT 50").bind(me.id).all();
    return json({ inquiries: r.results || [], kinds: KINDS });
  }
  if (request.method === "POST" && op === "seen") {
    await env.DB.prepare("UPDATE inquiries SET seen = 1 WHERE uid = ? AND seen = 0").bind(me.id).run();
    return json({ ok: true });
  }
  if (request.method === "POST" && !op) {
    const d = await request.json().catch(() => ({}));
    const kind = KINDS.includes(d.kind) ? d.kind : "기타";
    const title = String(d.title || "").trim().slice(0, 60), body = String(d.body || "").trim().slice(0, 2000);
    if (title.length < 2 || body.length < 5) return json({ error: "제목은 2자, 내용은 5자 이상 써 주세요." }, 400);
    const day = await env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE uid = ? AND created > ?").bind(me.id, Date.now() - 86400e3).first();
    if (day && day.n >= 5) return json({ error: "문의는 하루 5개까지 남길 수 있어요." }, 429);
    await env.DB.prepare("INSERT INTO inquiries (uid, nick, kind, title, body, created) VALUES (?, ?, ?, ?, ?, ?)").bind(me.id, me.nick, kind, title, body, Date.now()).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
