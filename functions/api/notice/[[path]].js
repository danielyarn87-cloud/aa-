// 공지사항
// GET  /api/notice          목록 (고정 먼저, 최신 순) — 누구나
// GET  /api/notice/<id>     글 하나 — 누구나
// POST /api/notice/save     {id?, title, body, pinned, banner} — 운영자 주소만
// POST /api/notice/delete   {id} — 운영자 주소만
import { ensureBoard, isAdmin, json } from "../../../lib/members.js";

export async function onRequest({ request, env, params }) {
  if (!env.DB) return json({ notices: [] });
  await ensureBoard(env);
  const url = new URL(request.url);
  const op = (params.path || [])[0] || "";

  if (request.method === "GET") {
    if (/^\d+$/.test(op)) {
      const n = await env.DB.prepare("SELECT * FROM notices WHERE id = ?").bind(+op).first();
      return n ? json({ notice: n }) : json({ error: "없는 공지예요." }, 404);
    }
    const r = await env.DB.prepare("SELECT id, title, substr(body, 1, 120) AS excerpt, pinned, banner, created, updated FROM notices ORDER BY pinned DESC, created DESC LIMIT 100").all();
    return json({ notices: r.results || [] });
  }

  if (request.method !== "POST") return json({ error: "method" }, 405);
  if (!isAdmin(request)) return json({ error: "운영자만 쓸 수 있어요." }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "forbidden" }, 403);
  const d = await request.json().catch(() => ({}));
  const now = Date.now();
  if (op === "save") {
    const title = String(d.title || "").trim().slice(0, 80), body = String(d.body || "").trim().slice(0, 5000);
    if (!title || !body) return json({ error: "제목과 내용을 써 주세요." }, 400);
    const pinned = d.pinned ? 1 : 0, banner = d.banner ? 1 : 0;
    if (banner) await env.DB.prepare("UPDATE notices SET banner = 0").run();   // 띠는 하나만
    if (d.id) {
      await env.DB.prepare("UPDATE notices SET title = ?, body = ?, pinned = ?, banner = ?, updated = ? WHERE id = ?").bind(title, body, pinned, banner, now, +d.id).run();
      return json({ ok: true, id: +d.id });
    }
    const r = await env.DB.prepare("INSERT INTO notices (title, body, pinned, banner, created, updated) VALUES (?, ?, ?, ?, ?, ?)").bind(title, body, pinned, banner, now, now).run();
    return json({ ok: true, id: r.meta && r.meta.last_row_id });
  }
  if (op === "delete") {
    await env.DB.prepare("DELETE FROM notices WHERE id = ?").bind(+d.id).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
