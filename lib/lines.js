// 언더/오버 기준점 (2.5 · 3.5 · 4.5) 저장: GitHub 저장소 data/lines.json 에 {"lines": {"AF-1": 3.5}} 로 남긴다.
// - 분석 요청(functions/api/run.js): 고른 경기의 기준점을 먼저 저장하고 분석을 시작한다.
// - 분석 뒤 변경(functions/api/lines.js): 저장하면 GitHub Actions '기준점 적용'(lines.yml)이 결과를 고치고
//   사이트(회원·운영자)를 다시 만들고 쇼츠도 다시 만든다.
// 커밋 메시지에 [CF-Pages-Skip] 을 넣어 이 저장만으로는 사이트를 다시 만들지 않는다 (무료 배포 횟수 아끼기).

export const LINES = [2.5, 3.5, 4.5];
const PATH = "/contents/data/lines.json";

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(String(b64).replace(/\s/g, "")), (c) => c.charCodeAt(0)));

export function cleanLines(raw) {
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    if (/^[A-Z]{1,5}-\d{1,12}$/.test(id) && LINES.includes(Number(v))) out[id] = Number(v);
  }
  return out;
}

// gh(env, path, init) 는 run.js 의 GitHub 호출 함수. 같은 파일을 동시에 고치면 409 → 다시 읽고 한 번 더.
export async function saveLines(gh, env, add, note) {
  for (let i = 0; i < 3; i++) {
    const cur = await gh(env, PATH + "?ref=main");
    let lines = {}, sha;
    if (cur.ok) {
      const j = await cur.json();
      sha = j.sha;
      try { lines = JSON.parse(fromBase64(j.content)).lines || {}; } catch { lines = {}; }
    }
    const merged = { ...lines, ...add };
    const body = {
      message: `기준점 ${note} [CF-Pages-Skip]`,
      content: toBase64(JSON.stringify({ lines: merged, updated_at: new Date().toISOString() }, null, 2) + "\n"),
      branch: "main",
      ...(sha ? { sha } : {}),
    };
    const r = await gh(env, PATH, { method: "PUT", body: JSON.stringify(body) });
    if (r.ok) return merged;
    if (r.status !== 409 && r.status !== 422) throw new Error(`기준점 저장 실패 (GitHub ${r.status})`);
  }
  throw new Error("기준점 저장이 겹쳤습니다. 잠시 뒤 다시 눌러 주세요.");
}
