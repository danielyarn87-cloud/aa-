{
/* AA 스포츠 분석 화면. 서버 API(/api/...)를 읽는다. window.AA_SNAPSHOT 이 있으면 서버 없이 그 자료로 그린다(미리보기).
   화면 용어는 처음 보는 사람 기준으로 쓴다: 확률→가능성, 기대값→100원당 평균 손익, 가치 알림→이득 신호, 관망→판단 보류. */
const SNAP = window.AA_SNAPSHOT || null;
const STATIC = window.AA_STATIC === true;   /* Cloudflare Pages 등 정적 호스팅: api/*.json 파일을 읽는다 */
const READONLY = !!SNAP || STATIC;
const view = document.getElementById('view');
const CONF = {high: '확신 높음', medium: '확신 보통', low: '확신 낮음'};
const PAL = ['#2563eb', '#15803d', '#ea580c', '#7c3aed', '#0891b2', '#be123c'];
const TH = 0.05;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = (x, d = 0) => x == null ? '-' : (x * 100).toFixed(d) + '%';
/* 기대값을 100원당 평균 손익으로: 0.097 → +10원 */
const won = x => x == null ? '-' : (x >= 0 ? '+' : '−') + Math.abs(Math.round(x * 100)) + '원';
/* 결과 이름: 팀 이름을 쓴다 */
const names = (home, away, line) => {
  const l = Number(line ?? 2.5);
  return {home: `${home} 승`, draw: '무승부', away: `${away} 승`,
          over: `오버 (${Math.ceil(l)}골 이상)`, under: `언더 (${Math.floor(l)}골 이하)`,
          overS: '오버', underS: '언더'};
};
const votes = tally => { const n = (tally || '').split(':').map(Number); const t = n.reduce((a, b) => a + b, 0); return {t, max: Math.max(...n)}; };
const voteText = tally => { const v = votes(tally); return v.t ? `${v.t}명 중 ${v.max}명` : ''; };
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

async function api(path, opts) {
  if (SNAP) {
    if (path === '/api/matches') return SNAP.matches;
    if (path.startsWith('/api/matches/')) {
      const d = SNAP.details[decodeURIComponent(path.split('/').pop())];
      if (!d) throw new Error('아직 분석하지 않은 경기입니다.');
      return d;
    }
    if (path === '/api/company') return SNAP.company;
    if (path === '/api/record') return SNAP.record;
    throw new Error('미리보기에서는 쓸 수 없는 기능입니다.');
  }
  if (STATIC) {
    const file = path === '/api/matches' ? 'api/matches.json'
      : path.startsWith('/api/matches/') ? 'api/matches/' + path.split('/').pop() + '.json'
      : path === '/api/company' ? 'api/company.json' : path === '/api/record' ? 'api/record.json'
      : path === '/api/leagues' ? 'api/leagues.json' : path === '/api/bets' ? 'api/bets.json' : null;
    if (!file) throw new Error('이 사이트에서는 쓸 수 없는 기능입니다.');
    const r = await fetch(file, {cache: 'no-cache'});
    if (!r.ok) throw new Error(r.status === 404 ? '아직 분석하지 않은 경기입니다.' : '불러오기 실패 ' + r.status);
    return r.json();
  }
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('요청 실패 ' + r.status));
  return j;
}
function adminPost(path, body) {
  return api(path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Admin-Token': store.get('aa_admin')}, body: JSON.stringify(body || {})});
}

const tri = p => `<div class="tri" aria-label="홈 ${pct(p.home)}, 무 ${pct(p.draw)}, 원정 ${pct(p.away)}"><i class="h" style="width:${p.home * 100}%"></i><i class="d" style="width:${p.draw * 100}%"></i><i class="a" style="width:${p.away * 100}%"></i></div>`;
const dayOf = k => (k || '').slice(0, 10);
const timeOf = k => { const m = (k || '').match(/(\d{2}:\d{2})/); return m ? m[1] : ''; };
function dayLabel(d) {
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 ${'일월화수목금토'[dt.getDay()]}요일`;
}

/* ---------- 경기 목록 ---------- */
let listFilter = 'all';
let leagueFilter = store.get('aa_league') || 'all';
const lgName = m => m.league_name || (m.league || '').split(' ')[0] || '기타';
async function renderList() {
  const data = await api('/api/matches');
  const all = data.matches;
  const lgCount = {};
  all.forEach(m => { lgCount[lgName(m)] = (lgCount[lgName(m)] || 0) + 1; });
  if (leagueFilter !== 'all' && !lgCount[leagueFilter]) leagueFilter = 'all';
  const ms = all.filter(m => leagueFilter === 'all' || lgName(m) === leagueFilter);
  const done = ms.filter(m => m.status === 'analyzed');
  const vals = done.filter(m => m.value_alerts && m.value_alerts.length).length;
  const shown = ms.filter(m => listFilter === 'all' || (listFilter === 'analyzed' ? m.status === 'analyzed' : listFilter === 'pending' ? m.status === 'pending' : (m.value_alerts || []).length));
  const days = [...new Set(shown.map(m => dayOf(m.kickoff)))];
  const chip = (k, t) => `<button class="chip" data-f="${k}" aria-pressed="${listFilter === k}">${t}</button>`;
  view.innerHTML = `<section class="band"><div class="wrap">
    <div class="listhead"><div><h1>이번 주 경기</h1>
      <p class="mute" style="margin:6px 0 0">분석 완료 <b class="num">${done.length}</b> · 분석 대기 <b class="num">${ms.length - done.length}</b> · 이득 신호 <b class="num">${vals}</b></p></div>
      <div class="chips" role="group" aria-label="경기 거르기">${chip('all', '전체')}${chip('analyzed', '분석 완료')}${chip('value', '이득 신호')}${chip('pending', '분석 대기')}</div></div>
    ${Object.keys(lgCount).length > 1 ? `<div class="chips lgchips" role="group" aria-label="리그 거르기">
      <button class="chip" data-lg="all" aria-pressed="${leagueFilter === 'all'}">모든 리그 <span class="num">${all.length}</span></button>
      ${Object.entries(lgCount).sort((a, b) => b[1] - a[1]).map(([n, c]) => `<button class="chip" data-lg="${esc(n)}" aria-pressed="${leagueFilter === n}">${esc(n)} <span class="num">${c}</span></button>`).join('')}</div>` : ''}
    <p class="small mute" style="margin:0">노란 <span class="tag value">이득</span> 표시는 우리가 본 가능성에 비해 배당이 후하게 나온 선택입니다.</p>
    ${shown.length ? days.map(d => `<h2 class="day">${esc(dayLabel(d))}</h2>${shown.filter(m => dayOf(m.kickoff) === d).map(rowHtml).join('')}`).join('')
      : `<p class="empty">조건에 맞는 경기가 없습니다.${STATIC ? ' <a href="#run">분석 요청</a>에서 리그를 골라 경기를 가져오세요.' : ''}</p>`}
  </div></section>`;
  view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); });
  view.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => { leagueFilter = b.dataset.lg; store.set('aa_league', leagueFilter); renderList(); });
}
function rowHtml(m) {
  const N = names(m.home, m.away, m.line);
  const head = `<span class="time">${esc(timeOf(m.kickoff))}</span><span class="teams">${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)}<br><span class="lg">${esc(m.league)}</span></span>`;
  if (m.status !== 'analyzed') {
    const o = m.odds || {};
    return `<div class="row">${head}<span class="small mute num odds">${o.home ? `배당 ${esc(o.home)} / ${esc(o.draw)} / ${esc(o.away)}` : '배당 없음'}</span><span class="tags"><span class="tag wait">분석 대기</span></span></div>`;
  }
  const tags = [];
  const od = m.odds || {};
  const at = k => od[k] ? ` <b class="num">${esc(od[k])}</b>` : '';   // 그 선택의 평균 배당
  const lab = k => esc(k === 'over' || k === 'under' ? N[k + 'S'] + ' ' + m.line : N[k]);
  tags.push(`<span class="tag pick">${m.pick_1x2 ? '예측 ' + esc(N[m.pick_1x2]) + at(m.pick_1x2) : '승패 판단 보류'}</span>`);
  tags.push(`<span class="tag">${m.pick_ou ? lab(m.pick_ou) + at(m.pick_ou) : '골 수 판단 보류'}</span>`);
  if (m.value_alerts.length) tags.push(`<span class="tag value">이득 ${m.value_alerts.map(k => lab(k) + at(k)).join(' · ')}</span>`);
  if (m.result) tags.push(`<span class="tag ${m.result.hit_1x2 ? 'hit' : m.result.hit_1x2 === false ? 'miss' : ''}">${esc(m.result.score)} ${m.result.hit_1x2 ? '적중' : m.result.hit_1x2 === false ? '빗나감' : ''}</span>`);
  if (m.mock) tags.push('<span class="tag wait">모의</span>');
  return `<a class="row" href="#m-${encodeURIComponent(m.id)}">${head}${tri(m.probs)}<span class="tags">${tags.join('')}</span></a>`;
}

/* ---------- 경기 상세 ---------- */
async function renderMatch(id) {
  const r = await api('/api/matches/' + encodeURIComponent(id));
  const m = r.match, d = r.decision, one = d.one_x_two, ou = d.over_under, s = r.summary;
  const N = names(m.home, m.away, d.line);
  const color = (mid, i) => (r.members[mid] && r.members[mid].color) || PAL[i % PAL.length];
  const first = Object.fromEntries(r.initial.map(o => [o.member_id, o]));
  const md = m.data || {};
  const mock = /모의/.test(r.engine);
  const odds = m.odds || {};
  const hasMarket = one.market_probs && one.market_probs.home != null;

  const rows = [
    {who: '기본 계산', sub: '득점 통계로 계산', p: r.base.probs, over: r.base.over_prob, c: 'var(--mute)'},
    ...r.final.map((o, i) => ({who: o.member_name, sub: `${N[o.pick_1x2]} · ${CONF[o.confidence]}`, p: o.probs, pick: o.pick_1x2, over: o.over_prob, c: color(o.member_id, i)})),
    {sep: true},
    {who: '회사 종합', sub: one.pick ? `${N[one.pick]} · ${voteText(one.tally)}` : '판단 보류', p: one.probs, pick: one.pick, over: ou.probs.over, c: 'var(--ink)', cls: 'co'},
  ];
  if (hasMarket) rows.push({who: '시장', sub: '배당에 담긴 가능성', p: one.market_probs, over: ou.market_probs && ou.market_probs.over, c: 'var(--mute)', cls: 'mk'});

  const seg = (p, k, pk) => `<i class="${k[0]}${pk === k ? ' pk' : ''}" style="flex:0 0 calc(${p[k] * 100}% - 2px)" title="${esc(N[k])} ${pct(p[k], 1)}">${p[k] >= .09 ? pct(p[k]) : ''}</i>`;
  const ladder = rows.map(x => x.sep ? '<div class="sep"></div>' :
    `<div class="who ${x.cls || ''}"><span class="dot" style="--c:${x.c}"></span><span>${esc(x.who)}<small>${esc(x.sub)}</small></span></div>
     <div class="${x.cls || ''}"><div class="bar">${seg(x.p, 'home', x.pick)}${seg(x.p, 'draw', x.pick)}${seg(x.p, 'away', x.pick)}</div></div>`).join('');
  const ouRows = rows.filter(x => !x.sep && x.over != null).map(x =>
    `<div class="who"><span class="dot" style="--c:${x.c}"></span><span>${esc(x.who)}</span></div>
     <div class="track"><b class="${x.cls === 'mk' ? 'mk' : ''}" style="left:${x.over * 100}%;--c:${x.c}"></b><em style="${x.over > .5 ? 'right:' + (102 - x.over * 100) + '%' : 'left:' + (x.over * 100 + 3) + '%'}">${pct(x.over)}</em></div>`).join('');

  /* 이득 계산 표: 우리가 본 가능성 vs 본전 가능성(1 ÷ 배당) */
  const choices = [
    ...['home', 'draw', 'away'].map(k => ({k, label: N[k], p: one.probs[k], e: one.edges[k], pick: one.pick === k})),
    ...['over', 'under'].map(k => ({k, label: N[k], p: ou.probs[k], e: ou.edges[k], pick: ou.pick === k})),
  ].map(c => ({...c, o: odds[c.k], be: odds[c.k] ? 1 / odds[c.k] : null}));
  const good = choices.filter(c => c.e != null && c.e >= TH);
  const vRow = c => `<tr class="${c.pick ? 'pk' : ''}"><td data-l="선택">${esc(c.label)}${c.pick ? ' <span class="small mute" style="white-space:nowrap">예측</span>' : ''}</td>
    <td data-l="우리가 본 가능성" class="r num">${pct(c.p)}</td><td data-l="본전 가능성" class="r num">${pct(c.be)}</td>
    <td data-l="배당" class="r num">${esc(c.o ?? '-')}</td><td data-l="100원당 평균 손익" class="r"><span class="ev ${c.e != null && c.e >= TH ? 'plus' : ''}">${won(c.e)}</span></td></tr>`;
  const pickName = one.pick ? N[one.pick] : null;
  let lead;
  if (pickName && good.length && !good.some(c => c.k === one.pick)) lead = `가장 일어날 것 같은 결과는 ${pickName}이지만, 배당이 후하게 나온 쪽은 ${good.map(c => c.label).join(', ')}입니다.`;
  else if (pickName && good.some(c => c.k === one.pick)) lead = `${pickName}은 가장 일어날 것 같고, 배당도 후하게 나와 있습니다.`;
  else if (!pickName) lead = '분석가 의견이 갈려 승패는 판단을 보류합니다.' + (good.length ? ` 배당이 후한 쪽: ${good.map(c => c.label).join(', ')}.` : '');
  else lead = '이번 경기는 배당이 후하게 나온 선택이 없습니다.';
  const why = good.map(c => `<li><b>${esc(c.label)}</b>: 우리는 ${pct(c.p)}로 보는데, 이 배당은 ${pct(c.be)}만 돼도 본전입니다. 100원을 걸면 평균 <b>${won(c.e)}</b>.</li>`).join('');

  const res = s.result ? `<span class="result">${esc(s.result.score)}</span>` : '<span class="vs">VS</span>';
  const lu = md.lineup || {};
  const list = a => (a && a.length) ? `<ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="mute small">자료 없음</p>';
  const KEYS = {home_days_rest: `${m.home} 휴식일`, away_days_rest: `${m.away} 휴식일`, home_prev: `${m.home} 직전 경기`, away_prev: `${m.away} 직전 경기`, home_next: `${m.home} 다음 경기`, away_next: `${m.away} 다음 경기`};
  const kv = o => (o && typeof o === 'object' && !Array.isArray(o)) ? `<ul>${Object.entries(o).filter(([k]) => k !== '설명').sort(([a], [b]) => (a.startsWith('home') ? 0 : 1) - (b.startsWith('home') ? 0 : 1)).map(([k, v]) => `<li>${esc(KEYS[k] || k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}${/days_rest/.test(k) ? '일' : ''}</li>`).join('')}</ul>` : Array.isArray(o) ? list(o) : `<p>${esc(o ?? '자료 없음')}</p>`;

  view.innerHTML = `
  <section class="board band"><div class="wrap">
    <p class="meta">${esc(m.league)} · ${esc(m.kickoff)}</p>
    <div class="fixture"><span class="team home">${esc(m.home)}</span>${res}<span class="team">${esc(m.away)}</span></div>
    <div class="verdicts">
      <div class="verdict"><span>누가 이기나</span><b>${pickName ? esc(pickName) : '판단 보류'}</b><span class="small">${esc(voteText(one.tally))}</span></div>
      <div class="verdict"><span>골 수</span><b>${ou.pick ? esc(N[ou.pick]) : '판단 보류'}</b><span class="small">${esc(voteText(ou.tally))}</span></div>
    </div>
  </div></section>
  <section class="band"><div class="wrap">
    ${mock ? '<p class="notice">모의 실행 결과입니다. 실제 AI 분석이 아니라 화면 확인용입니다.</p>' : ''}
    <div class="sheet">
      <div>
        <h2>${hasMarket ? `우리는 시장보다 ${esc(N.home)} 가능성을 ${one.probs.home < one.market_probs.home ? '낮게' : '높게'} 봅니다` : '분석가별 가능성'}</h2>
        <div class="legend"><span style="--c:var(--home)">${esc(N.home)}</span><span style="--c:var(--draw)">무승부</span><span style="--c:var(--away)">${esc(N.away)}</span><span style="--c:var(--card)">노란 테두리 = 고른 결과</span></div>
        <div class="ladder">${ladder}</div>
        <h3 style="margin-top:28px">${Math.ceil(Number(d.line))}골 이상 나올 가능성 (오버)</h3>
        <div class="ou">${ouRows}<span></span><div class="axis"><span>골 적게</span><span>50%</span><span>골 많이</span></div></div>
      </div>
      <div>
        <div class="panel"><h2>배당 이득 계산</h2><p class="lead">${esc(lead)}</p>
          <div class="scroll"><table class="stack vt"><thead><tr><th>선택</th><th class="r">우리 예상</th><th class="r">본전</th><th class="r">배당</th><th class="r">100원당</th></tr></thead><tbody>
          ${choices.map(vRow).join('')}
          </tbody></table></div>
          ${why ? `<ul class="small why">${why}</ul>` : ''}
          <details><summary>이 표 읽는 법</summary><div class="small">
            <p><b>우리 예상</b>은 우리가 본 가능성, <b>본전</b>은 본전 가능성, <b>100원당</b>은 100원당 평균 손익입니다.</p>
            <p><b>본전 가능성</b> = 1 ÷ 배당. 배당 2.00이면 50%입니다. 그 결과가 이보다 자주 일어나야 길게 봤을 때 손해가 아닙니다.</p>
            <p><b>우리가 본 가능성</b>이 본전 가능성보다 높으면 배당이 후하게 나온 것이고, 낮으면 비싸게 나온 것입니다.</p>
            <p><b>100원당 평균 손익</b>은 같은 판단을 아주 여러 번 했을 때 100원마다 평균으로 남거나 잃는 돈입니다. <span class="ev plus">+5원</span> 이상일 때만 노란 <b>이득 신호</b>를 켭니다. 우리 계산에도 오차가 있어서, 작은 차이는 믿지 않습니다.</p>
            <p><b>이득 신호가 이번 경기에서 맞는다는 뜻은 아닙니다.</b> 가능성 31%라면 10번 중 7번은 빗나갑니다. 또 배당이 바뀌면 이득도 바뀝니다.</p>
          </div></details></div>
        <div class="panel small"><b>분석 방식</b><br><span class="mute">${esc(r.engine)}</span><br><b>분석 시각</b> <span class="mute">${esc(r.analyzed_at || '-')}</span><br><b>투표 비중</b> <span class="mute">${r.final.map(o => esc(o.member_name) + ' ' + (d.weights[o.member_id] ?? 1).toFixed(2)).join(', ')}</span></div>
      </div>
    </div>

    <div class="sec"><h2>분석가 최종 의견</h2><div class="crew">
      ${r.final.map((o, i) => `<article class="analyst" style="--c:${color(o.member_id, i)}">
        <div class="ahead"><span class="avatar">${esc(o.member_name.slice(0, 1))}</span><div><h3>${esc(o.member_name)}</h3><small>${esc((r.members[o.member_id] || {}).title || '')}</small></div></div>
        <div class="tags" style="justify-content:flex-start"><span class="tag pick">${esc(N[o.pick_1x2])}</span><span class="tag">${esc(N[o.pick_ou + 'S'])}</span><span class="tag">${esc(CONF[o.confidence])}</span>${first[o.member_id] && first[o.member_id].pick_1x2 !== o.pick_1x2 ? `<span class="tag value">토론 후 ${esc(N[first[o.member_id].pick_1x2])} → ${esc(N[o.pick_1x2])}</span>` : ''}</div>
        <p class="quote">${esc(o.summary)}</p>
        <ul>${o.key_reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${o.risks.length ? `<p class="small mute" style="margin:0">틀릴 수 있는 이유: ${o.risks.map(esc).join(' / ')}</p>` : ''}
        ${o.rebuttal || o.changed ? `<details><summary>토론에서 한 말</summary><div class="debate">
          ${o.rebuttal ? `<p><b>반박</b> ${esc(o.rebuttal)}</p>` : ''}${o.concession ? `<p><b>인정</b> ${esc(o.concession)}</p>` : ''}${o.changed ? `<p><b>바꾼 점</b> ${esc(o.changed)}</p>` : ''}</div></details>` : ''}
        ${first[o.member_id] ? `<details><summary>첫 분석 보기</summary><p class="small">${esc(first[o.member_id].summary)}</p><ul class="small">${first[o.member_id].key_reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
      </article>`).join('')}
    </div></div>

    <div class="sec"><h2>토론 전후 변화</h2><div class="scroll"><table class="stack">
      <thead><tr><th>분석가</th><th>처음 고른 결과</th><th>최종</th><th class="r">처음 가능성 (승/무/패)</th><th class="r">최종 가능성 (승/무/패)</th><th class="r">오버 가능성</th></tr></thead><tbody>
      ${r.final.map(o => { const f = first[o.member_id] || o; return `<tr><td data-l="분석가"><b>${esc(o.member_name)}</b></td><td data-l="처음 고른 결과">${esc(N[f.pick_1x2])}</td><td data-l="최종"><b>${esc(N[o.pick_1x2])}</b></td><td data-l="처음 가능성" class="r num">${pct(f.probs.home)}/${pct(f.probs.draw)}/${pct(f.probs.away)}</td><td data-l="최종 가능성" class="r num">${pct(o.probs.home)}/${pct(o.probs.draw)}/${pct(o.probs.away)}</td><td data-l="오버 가능성" class="r num">${pct(f.over_prob)}→${pct(o.over_prob)}</td></tr>`; }).join('')}
      </tbody></table></div></div>

    <div class="sec"><h2>분석에 쓴 자료</h2><div class="facts">
      <div><h3>${esc(m.home)} 결장·불투명</h3>${list([...(lu.home_absent || []), ...(lu.home_doubtful || []).map(x => '불투명: ' + x)])}</div>
      <div><h3>${esc(m.away)} 결장·불투명</h3>${list([...(lu.away_absent || []), ...(lu.away_doubtful || []).map(x => '불투명: ' + x)])}</div>
      <div><h3>일정</h3>${kv(md.schedule)}</div>
      <div><h3>순위·동기</h3><p>${esc(md.table || '자료 없음')}</p>${md.motivation ? `<p>${esc(md.motivation)}</p>` : ''}</div>
    </div>
    <details><summary>기본 계산 (득점 통계)</summary><pre>${esc(r.base.detail)}</pre></details>
    ${md.sources ? `<details><summary>자료 출처</summary>${list(md.sources)}</details>` : ''}
    ${md.notes ? `<details open><summary>주의</summary>${list(md.notes)}</details>` : ''}
    </div>
    ${!READONLY && store.get('aa_admin') && !s.result ? `<div class="sec panel"><h3>경기 결과 입력</h3><div class="inline" style="margin-top:8px"><input id="score" placeholder="2-1" inputmode="numeric" aria-label="점수"><button class="btn" id="settle">채점</button><span id="settle-msg" class="small mute"></span></div></div>` : ''}
  </div></section>`;
  const b = document.getElementById('settle');
  if (b) b.onclick = async () => {
    const msg = document.getElementById('settle-msg');
    try { await adminPost('/api/admin/settle/' + encodeURIComponent(id), {score: document.getElementById('score').value.trim()}); route(); }
    catch (e) { msg.textContent = e.message; }
  };
}

/* ---------- 분석팀 ---------- */
function personaPoints(md) {
  const sec = (md.split('## 세계관')[1] || '').split('\n## ')[0];
  return sec.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2)).slice(0, 3);
}
async function renderTeam() {
  const c = await api('/api/company');
  view.innerHTML = `<section class="band"><div class="wrap">
    <h1>분석팀</h1><p class="lead mute">분야를 나누지 않고 생각하는 방식을 나눴습니다. 모두가 전술, 데이터, 부상, 동기, 시장을 보지만 무게를 두는 곳이 다릅니다.</p>
    <div class="rules sec">
      <div class="stat"><span class="num">과반</span><span>같은 결과를 고른 사람이 절반을 넘으면 예측, 갈리면 판단 보류</span></div>
      <div class="stat"><span class="num">+${Math.round(c.policy.value_threshold * 100)}원</span><span>100원당 평균 손익이 이 이상이면 이득 신호</span></div>
      <div class="stat"><span class="num">${esc(c.policy.min_samples_for_weight)}경기</span><span>채점이 쌓이면 잘 맞힌 사람의 투표 비중을 올림</span></div>
    </div>
    ${c.departments.map(d => `<div class="dept sec"><h2>${esc(d.name)} <span class="tag ${d.active ? 'pick' : 'wait'}">${d.active ? '운영 중' : '준비 중'}</span></h2>
      ${d.members.length ? `<div class="crew" style="margin-top:12px">${d.members.map((p, i) => `<article class="analyst member" style="--c:${esc(p.color || PAL[i % PAL.length])}">
        <div class="ahead"><span class="avatar">${esc(p.name.slice(0, 1))}</span><div><h3>${esc(p.name)}</h3><small>${esc(p.title)} · ${p.votes ? '투표 참여' : '투표 안 함'}</small></div></div>
        <ul class="persona">${personaPoints(p.persona).map(x => `<li>${esc(x)}</li>`).join('')}</ul></article>`).join('')}</div>`
        : '<p class="mute">아직 배치된 분석가가 없습니다.</p>'}</div>`).join('')}
  </div></section>`;
}

/* ---------- 인사평가 ---------- */
async function renderRecord() {
  const r = await api('/api/record');
  view.innerHTML = `<section class="band"><div class="wrap"><h1>인사평가</h1>
    <p class="lead mute">경기가 끝나면 모든 예측을 채점합니다. ${esc(r.min_samples)}경기 이상 채점된 분석가는 성적에 따라 다음 경기 투표 비중이 바뀝니다. 모의 실행은 빠집니다.</p>
    ${r.departments.map(d => { const c = d.company; return `<div class="sec"><h2>${esc(d.department)}</h2>
      <div class="rules" style="margin-top:12px">
        <div class="stat"><span class="num">${esc(c.settled)}</span><span>채점한 경기</span></div>
        <div class="stat"><span class="num">${pct(c.acc_1x2, 1)}</span><span>승패 적중률 (예측 ${esc(c.picks_1x2)}, 판단 보류 ${esc(c.passes_1x2)})</span></div>
        <div class="stat"><span class="num">${won(c.roi_1x2)}</span><span>승패 예측을 100원씩 샀다면 경기당 평균 손익</span></div>
        <div class="stat"><span class="num">${pct(c.acc_ou, 1)}</span><span>골 수(언더/오버) 적중률</span></div>
      </div>
      ${d.members.length ? `<div class="scroll sec"><table class="stack"><thead><tr><th>분석가</th><th class="r">경기</th><th class="r">승패 적중</th><th class="r">가능성 오차</th><th class="r">골 수 적중</th><th class="r">100원당 손익</th><th class="r">다음 투표 비중</th></tr></thead><tbody>
        ${d.members.map(s => `<tr><td data-l="분석가">${esc(s.name)}</td><td data-l="경기" class="r num">${esc(s.n)}</td><td data-l="승패 적중" class="r num">${pct(s.acc_1x2, 1)}</td><td data-l="가능성 오차" class="r num">${s.brier_1x2.toFixed(3)}</td><td data-l="골 수 적중" class="r num">${pct(s.acc_ou, 1)}</td><td data-l="100원당 손익" class="r num">${won(s.roi_1x2)}</td><td data-l="다음 투표 비중" class="r num">${s.weight.toFixed(2)}</td></tr>`).join('')}
      </tbody></table></div><p class="small mute">가능성 오차는 "몇 %로 봤는데 실제로 어땠나"를 잰 점수(브라이어 점수)로, 낮을수록 잘 맞힌 것입니다.</p>`
        : '<p class="empty">아직 결과가 들어온 경기가 없습니다. 첫 경기가 끝나면 여기에 성적이 쌓입니다.</p>'}</div>`; }).join('')}
  </div></section>`;
}

/* ---------- 배팅 게임: AI 3명이 가상 100만원으로 3·5·7폴더 ---------- */
async function renderBets() {
  const b = await api('/api/bets');
  const W = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ko-KR') + '원';
  const pctx = p => (p * 100).toFixed(1) + '%';
  const st = s => s.status === 'won' ? '<span class="tag hit">적중</span>' : s.status === 'lost' ? '<span class="tag miss">실패</span>' : '<span class="tag wait">진행 중</span>';
  const mark = l => l.hit === true ? '<span class="tag hit">맞음</span>' : l.hit === false ? '<span class="tag miss">틀림</span>' : '';
  const slip = s => `<div class="panel slip"><div class="inline" style="justify-content:space-between;align-items:baseline">
      <h3 style="margin:0">${esc(s.size)}폴더 · <span class="num">${W(s.stake)}</span></h3>${st(s)}</div>
    <p class="small mute" style="margin:4px 0 8px">배당 <b class="num">${esc(s.combined_odds)}</b> · 모두 맞을 가능성 ${pctx(s.prob)} · 적중하면 <b class="num">${W(Math.floor(s.stake * s.combined_odds))}</b>${s.status === 'won' ? ` · 받은 돈 <b class="num">${W(s.payout)}</b>` : ''} · ${esc(s.days.join(', '))} 경기 · ${esc(s.placed_at)}</p>
    <table><tbody>${s.legs.map(l => `<tr><td>${esc(l.kickoff.slice(5, 16))}</td><td><a href="#m-${encodeURIComponent(l.match_id)}">${esc(l.title)}</a></td><td><b>${esc(l.label)}</b></td><td class="r num">${esc(l.odds)}</td><td class="r small mute">${pctx(l.prob)}</td><td class="r">${mark(l)}</td></tr>`).join('')}</tbody></table></div>`;
  view.innerHTML = `<section class="band"><div class="wrap"><h1>배팅 게임</h1>
    <p class="lead mute">분석가 3명이 각자 가상 자금 <b>${W(b.start_bankroll)}</b>으로 자기 예측만 믿고 3폴더·5폴더·7폴더 조합 배팅을 합니다. 한 장에 ${W(b.min_stake)}~${W(b.max_stake)}, 경기는 이틀 안에서만 고릅니다. 실제 돈이 아닌 실력 비교용입니다.</p>
    <div class="grid3">${b.accounts.map(a => `<div class="panel" style="border-top:4px solid ${esc(a.color || '#0d5c35')}">
      <h2 style="margin:0">${esc(a.name)} <span class="small mute">${esc(a.title)}</span></h2>
      <p class="num" style="font-size:28px;margin:8px 0 0">${W(a.value)}</p>
      <p class="small ${a.profit >= 0 ? '' : 'mute'}" style="margin:2px 0 8px">손익 <b class="num">${a.profit >= 0 ? '+' : ''}${W(a.profit)}</b> (${((a.profit / b.start_bankroll) * 100).toFixed(1)}%)</p>
      <p class="small mute" style="margin:0">남은 돈 ${W(a.bankroll)} · 걸어 둔 돈 ${W(a.at_risk)} · 적중 ${esc(a.won)}/${esc(a.settled)}장</p></div>`).join('')}</div>
    ${b.accounts.map(a => {
      const mine = b.slips.filter(s => s.member_id === a.member_id);
      return `<h2 style="margin-top:28px">${esc(a.name)}의 배팅</h2>${mine.length ? mine.map(slip).join('') : '<p class="empty">아직 배팅이 없습니다. 분석이 끝난 경기가 생기면 자동으로 겁니다.</p>'}`;
    }).join('')}
    <p class="small mute" style="margin-top:24px">고르는 법: 각자 자기 최종 가능성이 45% 이상인 선택 중 100원당 평균 손익이 큰 경기부터 담습니다. 금액은 켈리 기준의 1/4(자신 있을수록 많이)을 한도 안에서 1,000원 단위로. 배당은 북메이커 평균. 배당 자료가 없는 리그(K리그2·J2리그)는 빠집니다.</p>
  </div></section>`;
}

/* ---------- 분석 요청 (정적 사이트: Cloudflare 함수 /api/run → GitHub Actions) ---------- */
let runPoll = null;
async function renderRun() {
  const L = await api('/api/leagues');
  const saved = store.get('aa_run_leagues');
  let picked = new Set(saved ? saved.split(',').map(Number) : L.defaults);
  const groups = [...new Set(L.leagues.map(l => l.group))];
  const u = L.usage || {};
  const last = L.last_run;
  view.innerHTML = `<section class="band"><div class="wrap"><h1>분석 요청</h1>
    <p class="lead mute">리그를 고르고 <b>분석 시작</b>을 누르면 분석팀이 경기 자료와 배당을 모아 분석합니다. 끝나면 이 사이트에 자동으로 올라옵니다 (보통 5~20분).</p>
    <div class="sheet sec"><div>
      <div class="inline" style="justify-content:space-between"><h2>리그 고르기</h2>
        <span class="inline"><button class="btn ghost" id="lgDefault" type="button">기본 리그</button><button class="btn ghost" id="lgNone" type="button">모두 해제</button></span></div>
      ${groups.map(g => `<fieldset class="lgroup"><legend>${esc(g)}</legend><div class="chips">
        ${L.leagues.filter(l => l.group === g).map(l => `<button type="button" class="chip pickchip" data-id="${l.id}" aria-pressed="${picked.has(l.id)}">${esc(l.name)}</button>`).join('')}
      </div></fieldset>`).join('')}
      <p class="small mute" id="pickedText"></p>
    </div><div>
      <div class="panel"><h2>분석 조건</h2>
        <div class="form" style="margin-top:12px">
          <label for="rdays">경기 기간</label>
          <select id="rdays"><option value="1">오늘~내일 (24시간 안 킥오프)</option><option value="2" selected>2일 안</option><option value="3">3일 안</option><option value="7">일주일 안</option></select>
          <label for="rmax">최대 분석 경기 수</label>
          <input id="rmax" type="number" min="1" max="30" value="${esc(store.get('aa_run_max') || 10)}">
          <label><input type="checkbox" id="rdef" style="width:auto"> 이 리그를 매일 자동 분석(10시·22시)의 기본 리그로 저장</label>
          <label for="rpw">분석 요청 비밀번호</label>
          <input id="rpw" type="password" autocomplete="current-password" value="${esc(store.get('aa_run_pw'))}">
          <label><input type="checkbox" id="rkeep" style="width:auto" ${store.get('aa_run_pw') ? 'checked' : ''}> 이 기기에서 비밀번호 기억</label>
          <button class="btn" id="rgo" type="button">분석 시작</button>
        </div>
        <div id="rmsg" class="log" style="margin-top:12px" role="status"></div>
      </div>
      <div class="panel"><h2>진행 상황</h2><div id="rstat" class="small">불러오는 중…</div></div>
      <div class="panel"><h2>비용과 한도</h2><ul class="small mute why" style="margin-top:6px">
        <li>경기 1개를 분석할 때 Claude 를 6번 부릅니다 (분석가 3명 × 1차 분석·토론).</li>
        <li>경기 자료 API-Football: 오늘 <b class="num">${esc(u.api_football_today ?? '-')}</b> / ${esc(u.api_football_limit ?? 100)}회. 분석할 경기는 경기당 약 6회, 목록에만 올릴 경기는 리그당 2회.</li>
        <li>배당 The Odds API: 이번 달 <b class="num">${esc(u.odds_month ?? '-')}</b> / ${esc(u.odds_limit ?? 500)} 크레딧. 리그 하나에 2크레딧.</li>
        <li class="small">사용량은 마지막 분석 때 기준입니다${last ? ` (${esc(last.at)})` : ''}.</li></ul></div>
    </div></div></div></section>`;
  const days = document.getElementById('rdays');
  days.value = store.get('aa_run_days') || '2';
  const sync = () => {
    view.querySelectorAll('.pickchip').forEach(b => b.setAttribute('aria-pressed', picked.has(+b.dataset.id)));
    const names = L.leagues.filter(l => picked.has(l.id)).map(l => l.name);
    document.getElementById('pickedText').textContent = names.length ? `고른 리그 ${names.length}개: ${names.join(', ')}` : '고른 리그가 없습니다.';
    store.set('aa_run_leagues', [...picked].join(','));
  };
  view.querySelectorAll('.pickchip').forEach(b => b.onclick = () => { const id = +b.dataset.id; picked.has(id) ? picked.delete(id) : picked.add(id); sync(); });
  document.getElementById('lgDefault').onclick = () => { picked = new Set(L.defaults); sync(); };
  document.getElementById('lgNone').onclick = () => { picked = new Set(); sync(); };
  sync();
  const msg = t => { document.getElementById('rmsg').textContent = t; };
  document.getElementById('rgo').onclick = async e => {
    const btn = e.target;
    if (!picked.size) { msg('리그를 하나 이상 고르세요.'); return; }
    const pw = document.getElementById('rpw').value;
    if (!pw) { msg('비밀번호를 넣으세요.'); return; }
    const max = Math.min(Math.max(+document.getElementById('rmax').value || 10, 1), 30);
    store.set('aa_run_max', max); store.set('aa_run_days', days.value);
    store.set('aa_run_pw', document.getElementById('rkeep').checked ? pw : '');
    btn.disabled = true; msg('요청 보내는 중…');
    try {
      const r = await fetch('/api/run', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({password: pw, leagues: [...picked], days: +days.value, max, save_default: document.getElementById('rdef').checked})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('요청 실패 ' + r.status));
      msg(`분석을 시작했습니다. 리그 ${picked.size}개, ${days.options[days.selectedIndex].text}, 최대 ${max}경기${j.saved_default ? ' · 기본 리그로 저장함' : ''}.\n끝나면 경기 목록에 올라옵니다.`);
      setTimeout(status, 4000);
    } catch (err) { msg(err.message); }
    btn.disabled = false;
  };
  const label = x => x.status === 'completed'
    ? (x.conclusion === 'success' ? '<span class="tag hit">끝남</span>' : `<span class="tag miss">${x.conclusion === 'cancelled' ? '취소됨' : '실패'}</span>`)
    : x.status === 'in_progress' ? '<span class="tag value">분석 중</span>' : '<span class="tag wait">대기 중</span>';
  const when = s => { const d = new Date(s); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  async function status() {
    const el = document.getElementById('rstat');
    if (!el) { clearInterval(runPoll); return; }
    try {
      const r = await fetch('/api/run', {cache: 'no-store'});
      const j = await r.json();
      if (!j.configured) { el.innerHTML = '분석 요청 기능이 아직 설정되지 않았습니다 (Cloudflare 에 GH_TOKEN, RUN_PASSWORD 필요).'; return; }
      if (!j.runs.length) { el.textContent = '아직 실행 기록이 없습니다.'; return; }
      const busy = j.runs.some(x => x.status !== 'completed');
      el.innerHTML = `<table><tbody>${j.runs.map(x => `<tr><td class="num">#${esc(x.number)}</td><td>${x.event === 'schedule' ? '자동 (10시·22시)' : '요청'}</td><td>${esc(when(x.created_at))}</td><td class="r">${label(x)}</td></tr>`).join('')}</tbody></table>
        <p class="small mute" style="margin:8px 0 0">${busy ? '분석이 끝나면 사이트가 1~2분 안에 새로 고쳐집니다. 이 화면은 15초마다 다시 확인합니다.' : '끝난 분석은 경기 목록에서 볼 수 있습니다.'}</p>`;
    } catch (err) { el.textContent = '상태를 불러오지 못했습니다.'; }
  }
  clearInterval(runPoll);
  status();
  runPoll = setInterval(status, 15000);
}

/* ---------- 관리 ---------- */
async function renderAdmin() {
  if (READONLY) { view.innerHTML = '<section class="band"><div class="wrap"><h1>관리</h1><p class="lead">이 사이트는 읽기 전용입니다. 경기 수집·분석·채점은 GitHub Actions 가 하루 두 번 자동으로 하고, 바로 돌리려면 GitHub 저장소의 Actions 탭에서 "Run workflow" 를 누르세요.</p></div></section>'; return; }
  const ms = (await api('/api/matches')).matches.filter(m => m.status === 'pending');
  view.innerHTML = `<section class="band"><div class="wrap"><h1>관리</h1>
    <div class="sheet sec"><div>
      <div class="form"><label for="tok">관리자 토큰</label><input id="tok" type="password" autocomplete="off" value="${esc(store.get('aa_admin'))}"><button class="btn ghost" id="save">저장</button></div>
      <div class="form sec"><h2>경기 수집</h2>
        <label for="days">오늘부터 며칠</label><input id="days" type="number" min="1" max="14" value="3">
        <label for="lg">리그 (API-Football 번호, 비우면 전체)</label><input id="lg" placeholder="39">
        <label><input type="checkbox" id="light" style="width:auto"> 호출 절약 (상대 전적·직전 경기 생략)</label>
        <button class="btn" id="collect">수집</button></div>
      <div class="form sec"><h2>결과 자동 채점</h2><button class="btn" id="sync">끝난 경기 채점</button></div>
    </div><div>
      <div class="panel"><h2>분석 대기</h2>${ms.length ? `<table><tbody>${ms.map(m => `<tr><td>${esc(m.kickoff)}<br><b>${esc(m.home)} vs ${esc(m.away)}</b></td><td class="r"><button class="btn" data-run="${esc(m.id)}">분석</button></td></tr>`).join('')}</tbody></table>` : '<p class="mute">대기 중인 경기가 없습니다.</p>'}</div>
      <div class="panel"><h2>API 사용량</h2><div id="usage" class="small mute">토큰을 저장하면 보입니다.</div></div>
      <div class="panel"><h2>기록</h2><div id="log" class="log"></div></div>
    </div></div></div></section>`;
  const log = t => { document.getElementById('log').textContent = t; };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { log(e.message); } btn.disabled = false; };
  document.getElementById('save').onclick = () => { store.set('aa_admin', document.getElementById('tok').value.trim()); usage(); log('저장했습니다.'); };
  document.getElementById('collect').onclick = e => busy(e.target, async () => {
    const r = await adminPost('/api/admin/collect', {days: +document.getElementById('days').value, league: document.getElementById('lg').value, light: document.getElementById('light').checked});
    log(r.log.join('\n')); renderAdmin();
  });
  document.getElementById('sync').onclick = e => busy(e.target, async () => { const r = await adminPost('/api/admin/sync'); log(`결과 ${r.settled}경기 채점`); });
  view.querySelectorAll('[data-run]').forEach(b => b.onclick = e => busy(e.target, async () => {
    log('분석 중… 분석가 3명이 따로 분석한 뒤 토론합니다 (1~2분).');
    await adminPost('/api/admin/analyze/' + encodeURIComponent(b.dataset.run), {engine: 'claude'});
    location.hash = '#m-' + encodeURIComponent(b.dataset.run);
  }));
  async function usage() {
    try { const u = await api('/api/admin/usage', {headers: {'X-Admin-Token': store.get('aa_admin')}});
      document.getElementById('usage').innerHTML = `API-Football 오늘 <b class="num">${esc(u.api_football.used_today)}</b> / ${esc(u.api_football.limit)}회<br>The Odds API 이번 달 <b class="num">${esc(u.odds_api.used_month)}</b> / ${esc(u.odds_api.limit)} 크레딧`;
    } catch (e) { document.getElementById('usage').textContent = e.message; }
  }
  if (store.get('aa_admin')) usage();
}

/* ---------- 길찾기 ---------- */
async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const navKey = !h || h.startsWith('m-') ? 'list' : h;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === navKey));
  if (READONLY) document.querySelectorAll('.admin-link').forEach(a => a.hidden = true);
  document.querySelectorAll('.run-link').forEach(a => a.hidden = !STATIC);
  if (h !== 'run') clearInterval(runPoll);
  try {
    if (h.startsWith('m-')) await renderMatch(decodeURIComponent(h.slice(2)));
    else if (h === 'team') await renderTeam();
    else if (h === 'record') await renderRecord();
    else if (h === 'bets') await renderBets();
    else if (h === 'admin') await renderAdmin();
    else if (h === 'run' && STATIC) await renderRun();
    else await renderList();
  } catch (e) {
    view.innerHTML = `<section class="band"><div class="wrap"><h1>불러오지 못했습니다</h1><p class="lead">${esc(e.message)}</p><p><a href="#">경기 목록으로</a></p></div></section>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
}
