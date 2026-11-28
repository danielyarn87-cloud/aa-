// Cloudflare Pages 함수: 분석이 끝난 경기의 언더/오버 기준점 바꾸기 (운영자 주소에서만, 비밀번호 필요).
//
// POST /api/lines  {"password", "id": "AF-1", "line": 3.5}
//   → data/lines.json 저장 → GitHub Actions '기준점 적용'(lines.yml)이 분석 결과·채점 기록을 고치고
//     사이트를 다시 만든다(회원 사이트에 1~3분 뒤 반영) → 끝나면 '쇼츠 만들기'가 그 경기 쇼츠를 다시 만든다.
// 다시 분석하지 않는다: 분석가들이 처음에 2.5·3.5·4.5 모두의 오버 가능성을 답해 두었다 (aa/lines.py).
// 회원 주소(raise-fulltime.com)에서는 _middleware.js 가 막는다.
import { LINES, saveLines } from "../../lib/lines.js";
import { gh, sameText } from "./run.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env.GH_TOKEN || !env.RUN_PASSWORD) return json({ error: "아직 설정이 끝나지 않았습니다." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 잘못됐습니다." }, 400); }
  if (!sameText(body.password || "", env.RUN_PASSWORD)) return json({ error: "비밀번호가 맞지 않습니다." }, 401);
  const id = String(body.id || ""), line = Number(body.line);
  if (!/^[A-Z]{1,5}-\d{1,12}$/.test(id)) return json({ error: "경기 번호가 올바르지 않습니다." }, 400);
  if (!LINES.includes(line)) return json({ error: "기준점은 2.5 · 3.5 · 4.5 중 하나입니다." }, 400);
  try {
    await saveLines(gh, env, { [id]: line }, `${id} → ${line}`);
  } catch (e) {
    return json({ error: e.message }, 502);
  }
  return json({ ok: true, id, line });
}
