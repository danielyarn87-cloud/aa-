// 경기별 진짜 주소: /match/노팅엄-포리스트-vs-첼시-2026-11-28
// 검색 로봇이 읽을 수 있게 제목·설명·분석 본문을 처음부터 HTML 에 넣어 돌려준다.
// 사람에게는 app.js 가 window.AA_MATCH 를 보고 평소 경기 화면을 그대로 그린다.
// 자료: 정적 파일 /api/slugs.json(주소→경기 번호), /api/matches/<id>.json (tools/export_static.py 가 만듦)

const MEMBER_ORIGIN = "https://raise-fulltime.com";
const MEMBER = /(^|\.)raise-fulltime\.com$/;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 회원 주소에서는 배당 표현을 '시장 예상'으로 (app.js soften 과 같은 규칙)
const soften = (t) => String(t ?? "").replace(/배당이 후한지 비싼지/g, "시장 예상이 높은지 낮은지").replace(/시장 배당/g, "시장 예상")
  .replace(/배당 흐름/g, "시장 예상 흐름").replace(/배당/g, "시장 예상").replace(/정배/g, "인기 팀").replace(/[배베]팅/g, "선택").replace(/시장 예상 시장/g, "시장");
const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const cut = (t, n) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

const asset = async (ctx, url, path) => {
  const r = await ctx.env.ASSETS.fetch(new Request(new URL(path, url).toString()));
  return r.ok ? r : null;
};

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const notFound = () => ctx.env.ASSETS.fetch(new Request(new URL("/404.html", url).toString())).then((r) => new Response(r.body, { status: 404, headers: r.headers }));
  let slug = "";
  try { slug = decodeURIComponent(url.pathname.replace(/^\/match\/+/, "").replace(/\/+$/, "")); } catch (e) { return notFound(); }
  if (!slug || slug.includes("/")) return notFound();

  const idx = await asset(ctx, url, "/api/slugs.json");
  const hit = idx && (await idx.json())[slug];
  if (!hit) return notFound();
  const [dr, ir] = await Promise.all([asset(ctx, url, `/api/matches/${encodeURIComponent(hit.id)}.json`), asset(ctx, url, "/")]);
  if (!dr || !ir) return notFound();
  const d = await dr.json();
  let html = await ir.text();

  const member = MEMBER.test(url.hostname);
  const T = member ? soften : (t) => String(t ?? "");
  const m = d.match || {}, s = d.summary || {}, dec = d.decision || {};
  const home = m.home || s.home, away = m.away || s.away;
  const league = String(s.league || m.league || "").replace(/Regular Season - (\d+)/, "$1라운드");
  const ko = String(s.kickoff || m.kickoff || "");
  const day = ko.slice(5, 10).replace(/^0?(\d+)-0?(\d+)$/, "$1월 $2일");
  const time = ko.slice(11, 16);
  const p = s.probs || (dec.one_x_two || {}).probs || {};
  const line = s.line ?? dec.line ?? 2.5;
  const over = Number(s.over_prob ?? ((dec.over_under || {}).probs || {}).over ?? 0.5);
  const pickName = { home: `${home} 승`, draw: "무승부", away: `${away} 승` }[s.pick_1x2] || "";
  const ouName = s.pick_ou === "over" ? `${line}골 오버` : `${line}골 언더`;
  const res = s.result && s.result.home_goals != null ? `${s.result.home_goals} : ${s.result.away_goals}` : "";

  const title = `${home} vs ${away} 분석 · ${day} ${league}`;
  const finals = Array.isArray(d.final) && d.final.length ? d.final : (d.initial || []);
  const lead = finals.map((f) => f.summary).find(Boolean) || "";
  const desc = cut(T(`AI 분석가 ${finals.length || 4}명의 예측: ${home} 승 ${pct(p.home)} · 무 ${pct(p.draw)} · ${away} 승 ${pct(p.away)}. ${ouName} ${pct(s.pick_ou === "over" ? over : 1 - over)}.${res ? ` 결과 ${res}.` : ""} ${lead}`), 155);
  const canon = `${MEMBER_ORIGIN}/match/${encodeURIComponent(slug)}`;

  const h2h = ((m.data || {}).head_to_head || []).slice(0, 5);
  const body = `<article class="band seo-match"><div class="wrap narrow">
<p class="small mute"><a href="/">경기 목록</a> › ${esc(league)}</p>
<h1>${esc(home)} vs ${esc(away)} 분석</h1>
<p>${esc(day)} ${esc(time)} (한국 시간) · ${esc(league)}${res ? ` · 결과 <b>${esc(res)}</b>` : ""}</p>
<h2>AI 예측</h2>
<ul><li>${esc(home)} 승 ${pct(p.home)} · 무승부 ${pct(p.draw)} · ${esc(away)} 승 ${pct(p.away)}</li>
<li>예측: <b>${esc(pickName)}</b>, <b>${esc(ouName)}</b> (${line}골 초과 가능성 ${pct(over)})</li></ul>
${finals.map((f) => `<h3>${esc((d.members && d.members[f.member_id] && d.members[f.member_id].name) || f.member_name || "")}</h3><p>${esc(T(f.summary || (f.key_reasons || []).slice(0, 2).join(" ")))}</p>`).join("\n")}
${h2h.length ? `<h2>최근 맞대결</h2><ul>${h2h.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
<p class="small mute">RAISE의 분석은 참고용 정보이며 결과를 보장하지 않습니다.</p>
</div></article>`;

  const ld = { "@context": "https://schema.org", "@type": "SportsEvent", name: `${home} vs ${away}`, startDate: hit.kickoff, sport: "Soccer",
    homeTeam: { "@type": "SportsTeam", name: home }, awayTeam: { "@type": "SportsTeam", name: away }, description: desc, url: canon,
    organizer: { "@type": "Organization", name: String(league) } };

  const setMeta = (re, val) => { html = html.replace(re, (all, a, _old, b) => a + esc(val) + b); };
  setMeta(/(<title>)([^<]*)(<\/title>)/, `${title} · RAISE`);
  setMeta(/(<meta name="description" content=")([^"]*)(">)/, desc);
  setMeta(/(<link rel="canonical" href=")([^"]*)(">)/, canon);
  setMeta(/(<meta property="og:type" content=")([^"]*)(">)/, "article");
  setMeta(/(<meta property="og:title" content=")([^"]*)(">)/, title);
  setMeta(/(<meta property="og:description" content=")([^"]*)(">)/, desc);
  setMeta(/(<meta property="og:url" content=")([^"]*)(">)/, canon);
  html = html.replace("</head>", `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>\n<script>window.AA_MATCH=${JSON.stringify(hit.id)};</script>\n</head>`);
  html = html.replace(/<main id="view" aria-live="polite">[\s\S]*?<\/main>/, `<main id="view" aria-live="polite">${body}</main>`);

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
