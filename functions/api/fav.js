// 관심 경기 (☆) — 회원 전용. 회원 계정에 저장해서 폰·PC 어디서든 같다.
// GET  /api/fav               → {ids: ["AF-1", ...]}
// POST /api/fav {id, on}      → 켜기/끄기 (한 사람 최대 300개)
import { currentUser, json } from "../../lib/members.js";

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: "준비 중" }, 503);
  const me = await currentUser(env, request);
  if (!me) return json({ error: "회원 전용 기능이에요.", login: true }, 401);
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT mid FROM favs WHERE uid = ? ORDER BY created DESC LIMIT 300").bind(me.id).all();
    return json({ ids: results.map((r) => r.mid) });
  }
  if (request.method !== "POST") return json({ error: "method" }, 405);
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "forbidden" }, 403);
  let d = {};
  try { d = await request.json(); } catch (e) {}
  const id = String(d.id || "").slice(0, 40);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return json({ error: "bad id" }, 400);
  if (d.on) {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM favs WHERE uid = ?").bind(me.id).first()).n;
    if (n >= 300) return json({ error: "관심 경기는 300개까지예요." }, 400);
    await env.DB.prepare("INSERT OR IGNORE INTO favs (uid, mid, created) VALUES (?, ?, ?)").bind(me.id, id, Date.now()).run();
  } else {
    await env.DB.prepare("DELETE FROM favs WHERE uid = ? AND mid = ?").bind(me.id, id).run();
  }
  return json({ ok: true });
}
