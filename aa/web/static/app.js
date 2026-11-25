{
/* AA 스포츠 분석 화면. 서버 API(/api/...)를 읽는다. window.AA_SNAPSHOT 이 있으면 서버 없이 그 자료로 그린다(미리보기).
   화면 용어는 처음 보는 사람 기준으로 쓴다: 확률→가능성, 기대값→5,000원당 평균 손익, 가치 알림→이득 신호, 관망→판단 보류. */
const SNAP = window.AA_SNAPSHOT || null;
const STATIC = window.AA_STATIC === true;   /* Cloudflare Pages 등 정적 호스팅: api/*.json 파일을 읽는다 */
const READONLY = !!SNAP || STATIC;
const view = document.getElementById('view');
const CONF = {high: '확신 높음', medium: '확신 보통', low: '확신 낮음'};
const PAL = ['#2563eb', '#15803d', '#ea580c', '#7c3aed', '#0891b2', '#be123c'];
const TH = 0.05;

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = (x, d = 0) => x == null ? '-' : (x * 100).toFixed(d) + '%';
/* 기대값을 5,000원당 평균 손익으로: 0.097 → +485원 */
const OX = h => h === true ? '<span class="ox o">○</span>' : h === false ? '<span class="ox x">✕</span>' : '';
const rate = (h, n) => n ? `${h}/${n} <b>${Math.round(h / n * 100)}%</b>` : '-';
const UNIT = 5000;  /* 우리 배팅 최소 금액: 손익은 5,000원 걸었을 때 기준으로 보여 준다 */
const won = x => x == null ? '-' : (x >= 0 ? '+' : '−') + Math.abs(Math.round(x * UNIT)).toLocaleString('ko-KR') + '원';
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

/* 화면 크기: 폰마다 보기 편하게 (자동 + 직접 고르기: 작게·보통·크게) */
const ZOOMS = [{k: 's', t: '작게', z: 0.88}, {k: 'm', t: '보통', z: 1}, {k: 'l', t: '크게', z: 1.12}];
function applyZoom() {
  const k = store.get('aa_zoom') || 'm';
  const z = (ZOOMS.find(x => x.k === k) || ZOOMS[1]).z;
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
  const b = document.getElementById('zoomBtn');
  if (b) b.textContent = '글자 ' + (ZOOMS.find(x => x.k === k) || ZOOMS[1]).t;
}
(function zoomButton() {
  const top = document.querySelector('.top');
  if (!top || document.getElementById('zoomBtn')) return;
  const b = document.createElement('button');
  b.id = 'zoomBtn'; b.type = 'button'; b.className = 'zoombtn'; b.setAttribute('aria-label', '글자 크기 바꾸기');
  b.onclick = () => { const i = ZOOMS.findIndex(x => x.k === (store.get('aa_zoom') || 'm')); store.set('aa_zoom', ZOOMS[(i + 1) % ZOOMS.length].k); applyZoom(); };
  top.querySelector('.brand').after(b);
  applyZoom();
})();

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
  if (STATIC && path === '/api/odds') {   /* 배당 변화 기록: Cloudflare 함수가 바로 답한다 */
    const r = await fetch('/api/odds', {cache: 'no-cache'});
    return r.ok ? r.json() : null;
  }
  if (STATIC) {
    const file = path === '/api/matches' ? 'api/matches.json'
      : path.startsWith('/api/matches/') ? 'api/matches/' + path.split('/').pop() + '.json'
      : path === '/api/company' ? 'api/company.json' : path === '/api/record' ? 'api/record.json'
      : path === '/api/leagues' ? 'api/leagues.json' : path === '/api/bets' ? 'api/bets.json'
      : path === '/api/credit' ? 'api/credit.json' : path === '/api/news' ? 'api/news.json' : null;
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

/* 목록 승무패 막대: 칸 안에 비중(%) (12% 미만 좁은 칸은 생략), 아래에 칸 이름, 우리 예측은 굵게 */
const tri = (p, pk) => {
  const seg = (k, c) => { const v = Math.round((p[k] || 0) * 100); return `<i class="${c}" style="width:${(p[k] || 0) * 100}%">${v >= 12 ? v + '%' : ''}</i>`; };
  const nm = (k, c, t) => `<span><i class="${c}"></i>${pk === k ? `<b>${t}</b>` : t}</span>`;
  return `<div class="tri-w"><div class="tri" aria-label="홈 ${pct(p.home)}, 무 ${pct(p.draw)}, 원정 ${pct(p.away)}">${seg('home', 'h')}${seg('draw', 'd')}${seg('away', 'a')}</div>`
    + `<div class="tri-n">${nm('home', 'h', '홈 승')}${nm('draw', 'd', '무')}${nm('away', 'a', '원정 승')}</div></div>`;
};
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
let resQuery = '', resDate = '', resHit = 'all';
let lgOpen = !!store.get('aa_lg_open');
const lgName = m => m.league_name || (m.league || '').split(' ')[0] || '기타';
/* ---------- 스포츠 뉴스 ----------
   aa/news.py 가 3시간마다 모은 '경기에 영향 줄 소식'(감독·부상/결장·이적·징계). 제목은 Haiku 가 다시 쓴 한 줄 요약. */
const NCAT = {manager: ['감독', 'n-mgr'], injury: ['부상·결장', 'n-inj'], transfer: ['이적', 'n-tr'], suspension: ['징계', 'n-sus']};
const NIMP = {high: ['영향 큼', 'i-hi'], mid: ['영향 보통', 'i-mid'], low: ['영향 작음', 'i-lo']};
let NEWS = null, NEWS_BY = {};
async function loadNews(force) {
  if (NEWS && !force) return NEWS;
  NEWS = await api('/api/news').catch(() => null) || {items: []};
  NEWS_BY = {};
  (NEWS.items || []).forEach(x => (x.match_ids || []).forEach(id => (NEWS_BY[id] = NEWS_BY[id] || []).push(x)));
  return NEWS;
}
const ago = iso => {
  const t = Date.parse(iso); if (!t) return '';
  const mi = Math.round((Date.now() - t) / 60e3);
  return mi < 60 ? `${Math.max(mi, 1)}분 전` : mi < 1440 ? `${Math.round(mi / 60)}시간 전` : `${Math.round(mi / 1440)}일 전`;
};
/* 경기 목록의 작은 표시: 가장 영향 큰 분류 + 건수 */
function newsBadge(m) {
  const xs = NEWS_BY[m.id] || [];
  if (!xs.length) return '';
  const rank = {high: 0, mid: 1, low: 2};
  const top = [...xs].sort((a, b) => rank[a.impact] - rank[b.impact])[0];
  const same = xs.filter(x => x.category === top.category).length;
  const lab = xs.length === same ? `${NCAT[top.category][0]} ${same}` : `뉴스 ${xs.length}`;
  return `<span class="nbadge ${NCAT[top.category][1]}" title="${esc(xs.map(x => x.summary).join(' / '))}">📰 ${esc(lab)}</span>`;
}
function newsItem(x, matchLabel) {
  const [cl, cc] = NCAT[x.category] || [x.category, ''];
  const [il, ic] = NIMP[x.impact] || ['', ''];
  return `<div class="nitem"><span class="ncat ${cc}">${esc(cl)}</span><div><div class="nt">${esc(x.summary || x.title)}</div>
    <div class="small mute">${esc(x.team || '')} · ${esc(x.source || '')} · ${esc(ago(x.published))}${/^https?:\/\//.test(x.link || '') ? ` · <a href="${esc(x.link)}" target="_blank" rel="noopener nofollow">원문 보기 ↗</a>` : ''}</div>
    ${matchLabel ? `<div class="nm">${matchLabel}</div>` : ''}</div><span class="nimp ${ic}">${esc(il)}</span></div>`;
}
let newsCat = 'all', newsOnlyMatch = false;
async function renderNews() {
  const [n, data] = await Promise.all([loadNews(true), api('/api/matches').catch(() => ({matches: []}))]);
  const byId = Object.fromEntries((data.matches || []).map(m => [m.id, m]));
  const items = n.items || [];
  const cnt = c => items.filter(x => c === 'all' || x.category === c).length;
  const shown = items.filter(x => (newsCat === 'all' || x.category === newsCat)
    && (!newsOnlyMatch || (x.match_ids || []).some(id => byId[id] && byId[id].status === 'analyzed')));
  const label = x => {
    const ms = (x.match_ids || []).map(id => byId[id]).filter(m => m && !m.result).sort((a, b) => (a.kickoff > b.kickoff ? 1 : -1));
    return ms.length ? '관련 경기: ' + ms.slice(0, 2).map(m => `<a href="#m-${encodeURIComponent(m.id)}">${esc(m.kickoff.slice(5, 16).replace('-', '/'))} ${esc(m.home)} vs ${esc(m.away)} →</a>`).join(' · ') : '';
  };
  view.innerHTML = `<section class="band"><div class="wrap">
    <h1>경기에 영향 줄 소식</h1>
    <p class="lead small">다가오는 경기 팀의 감독·부상/결장·이적·징계 소식만 3시간마다 모읍니다. 요약은 AI가 제목을 보고 다시 쓴 것이라, 자세한 내용은 원문을 확인하세요.${n.updated ? ` · 마지막 갱신 ${esc(ago(n.updated))}` : ''}</p>
    <div class="nchips">${[['all', '전체'], ...Object.entries(NCAT).map(([k, v]) => [k, v[0]])].map(([k, l]) => `<button class="chip${newsCat === k ? ' on' : ''}" data-ncat="${k}">${esc(l)} ${cnt(k)}</button>`).join('')}
      <label class="small"><input type="checkbox" id="nOnly" ${newsOnlyMatch ? 'checked' : ''}> 분석한 경기 관련만</label></div>
    ${shown.length ? shown.map(x => newsItem(x, label(x))).join('') : '<p class="mute">아직 모인 소식이 없습니다. 3시간마다 자동으로 모입니다.</p>'}
  </div></section>`;
  view.querySelectorAll('[data-ncat]').forEach(b => b.onclick = () => { newsCat = b.dataset.ncat; renderNews(); });
  const o = document.getElementById('nOnly'); if (o) o.onchange = () => { newsOnlyMatch = o.checked; renderNews(); };
}

async function renderList() {
  const data = await api('/api/matches');
  await loadNews();
  const credit = await api('/api/credit').catch(() => null);
  ODDS_H = await api('/api/odds').catch(() => null);
  const lgInfo = await api('/api/leagues').catch(() => null);
  const all = data.matches;
  const lgCount = {};
  all.forEach(m => { lgCount[lgName(m)] = (lgCount[lgName(m)] || 0) + 1; });
  if (leagueFilter !== 'all' && !lgCount[leagueFilter]) leagueFilter = 'all';
  const inLg = all.filter(m => leagueFilter === 'all' || lgName(m) === leagueFilter);
  const finished = inLg.filter(m => m.result);                // 결과가 나온 경기는 '경기 결과' 탭으로
  const ms = inLg.filter(m => !m.result);
  const done = ms.filter(m => m.status === 'analyzed');
  const vals = done.filter(m => m.value_alerts && m.value_alerts.length).length;
  const isRes = listFilter === 'results';
  const shown = isRes ? [] : ms.filter(m => listFilter === 'all' || (listFilter === 'analyzed' ? m.status === 'analyzed' : listFilter === 'pending' ? m.status === 'pending' : (m.value_alerts || []).length));
  const days = [...new Set(shown.map(m => dayOf(m.kickoff)))];
  const chip = (k, t, cls = '') => `<button class="seg ${cls}" data-f="${k}" aria-pressed="${listFilter === k}">${t}</button>`;
  view.innerHTML = `<section class="band"><div class="wrap">
    <div class="listhead"><div><h1>누적 적중률 · 전체</h1></div>
      <div class="segbar" role="group" aria-label="경기 거르기">${chip('all', '전체')}${chip('analyzed', '분석 완료')}${chip('value', '이득 신호')}${chip('pending', '분석 대기')}${chip('results', `경기 결과 <span class="num">${finished.length}</span>`, 'res')}</div></div>
    ${kpiCards(all, ms.length - done.length, done.length, vals, credit, lgInfo)}
    ${Object.keys(lgCount).length > 1 ? `<button type="button" class="lgtoggle" id="lgtoggle" aria-expanded="${lgOpen}"><span><b>리그</b> · ${leagueFilter === 'all' ? `모든 리그 (${all.length})` : `${esc(leagueFilter)} (${lgCount[leagueFilter]})`}</span><span>${lgOpen ? '접기 ▴' : '펼치기 ▾'}</span></button>
    <div class="chips lgchips" role="group" aria-label="리그 거르기" ${lgOpen ? '' : 'hidden'}>
      <button class="chip" data-lg="all" aria-pressed="${leagueFilter === 'all'}">모든 리그 <span class="num">${all.length}</span></button>
      ${Object.entries(lgCount).sort((a, b) => b[1] - a[1]).map(([n, c]) => `<button class="chip" data-lg="${esc(n)}" aria-pressed="${leagueFilter === n}">${esc(n)} <span class="num">${c}</span></button>`).join('')}</div>` : ''}
    <p class="small mute" style="margin:0"><span class="tag pick">예측</span> 가장 유력하다고 본 결과 · 하늘색 <span class="tag value">이득</span> 우리가 본 가능성에 비해 배당이 후한 선택 · <span class="tag both"><span class="star">★ 예측+이득</span></span> 노란 바탕 빨간 글씨, 둘 다 해당 (가장 강한 신호) · 줄 색 <span class="lgnd hot">초록 = 예측+이득</span> <span class="lgnd val">분홍 = 이득</span> · 막대 <span class="trilegend"><span><i class="h"></i>홈 승</span><span><i class="d"></i>무</span><span><i class="a"></i>원정 승</span></span></p>
    ${isRes ? `<div class="ressearch">
        <input type="search" id="rq" placeholder="팀 이름·리그로 검색 (예: 대전, 챔피언스리그)" value="${esc(resQuery)}">
        <input type="date" id="rd" value="${esc(resDate)}" title="날짜">
        <select id="rh"><option value="all">적중 여부 전체</option><option value="hit">승무패 맞힌 경기</option><option value="miss">승무패 틀린 경기</option></select>
        <button type="button" class="btn ghost sm" id="rclear">초기화</button></div><div id="reslist"></div>`
      : shown.length ? days.map(d => `<h2 class="day">${esc(dayLabel(d))}</h2>${shown.filter(m => dayOf(m.kickoff) === d).map(rowHtml).join('')}`).join('')
      : `<p class="empty">조건에 맞는 경기가 없습니다.${STATIC ? ' <a href="#run">분석 요청</a>에서 리그를 골라 경기를 가져오세요.' : ''}</p>`}
  </div></section>`;
  if (isRes) {
    const rq = document.getElementById('rq'), rd = document.getElementById('rd'), rh = document.getElementById('rh');
    rh.value = resHit;
    const draw = () => {
      resQuery = rq.value.trim(); resDate = rd.value; resHit = rh.value;
      const q = resQuery.toLowerCase();
      const list = finished.filter(m => (!q || `${m.home} ${m.away} ${m.league} ${lgName(m)}`.toLowerCase().includes(q))
        && (!resDate || dayOf(m.kickoff) === resDate)
        && (resHit === 'all' || (resHit === 'hit' ? m.result.hit_1x2 === true : m.result.hit_1x2 === false)))
        .sort((x, y) => (x.kickoff < y.kickoff ? 1 : -1));            // 최근 경기부터
      const ds = [...new Set(list.map(m => dayOf(m.kickoff)))];
      const h1 = list.filter(m => m.result.hit_1x2 != null), ho = list.filter(m => m.result.hit_ou != null);
      document.getElementById('reslist').innerHTML = list.length
        ? `<p class="small" style="margin:6px 0 0"><b>${list.length}</b>경기 · 승무패 ${rate(h1.filter(m => m.result.hit_1x2).length, h1.length)} · 언더/오버 ${rate(ho.filter(m => m.result.hit_ou).length, ho.length)}</p>`
          + ds.map(d => `<h2 class="day">${esc(dayLabel(d))}</h2>${list.filter(m => dayOf(m.kickoff) === d).map(rowHtml).join('')}`).join('')
        : '<p class="empty">조건에 맞는 경기 결과가 없습니다.</p>';
    };
    rq.oninput = draw; rd.onchange = draw; rh.onchange = draw;
    document.getElementById('rclear').onclick = () => { rq.value = ''; rd.value = ''; rh.value = 'all'; draw(); };
    draw();
  }
  view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); });
  view.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => { leagueFilter = b.dataset.lg; store.set('aa_league', leagueFilter); renderList(); });
  const lt = document.getElementById('lgtoggle');
  if (lt) lt.onclick = () => { lgOpen = !lgOpen; store.set('aa_lg_open', lgOpen ? '1' : ''); renderList(); };
  view.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    const s = pickSet(); const id = b.dataset.pick;
    s.has(id) ? s.delete(id) : s.add(id);
    store.set('aa_pick_ids', [...s].join(','));
    b.setAttribute('aria-pressed', s.has(id)); b.textContent = s.has(id) ? '✓ 분석에 담음' : '＋ 분석하기';
    pickBar();
  });
  pickBar();
  liveTick();
  wireCredit();
  wireApiCard();
}
function kpiCards(all, waiting, analyzed, vals, credit, lgInfo) {
  const done = all.filter(m => m.result);
  const p1 = done.filter(m => m.result.hit_1x2 != null), po = done.filter(m => m.result.hit_ou != null);
  const h1 = p1.filter(m => m.result.hit_1x2).length, ho = po.filter(m => m.result.hit_ou).length;
  const pc = (h, n) => n ? `${Math.round(h / n * 100)}%` : '-';
  /* 이득 적중: 결과가 나온 경기에서 이득 표시(하늘색·★)가 붙었던 선택 하나하나가 맞았는지, 5,000원씩 걸었다면 손익 */
  let vn = 0, vh = 0, vpl = 0;
  done.forEach(m => {
    const sc = String(m.result.score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
    if (!sc) return;
    const a = +sc[1], b = +sc[2], line = parseFloat(m.line) || 2.5;
    (m.value_alerts || []).forEach(k => {
      const win = {home: a > b, draw: a === b, away: a < b, over: a + b > line, under: a + b < line}[k];
      if (win === undefined) return;
      const o = parseFloat((m.odds || {})[k]) || 0;
      vn++; if (win) vh++;
      vpl += win ? (o - 1) * UNIT : -UNIT;
    });
  });
  const card = (cls, label, num, sub) => `<div class="kpi ${cls}"><span class="kl">${label}</span><span class="kn">${num}</span><span class="ks">${sub}</span></div>`;
  return `<div class="kpis">
    ${card('k1', '승무패 적중', pc(h1, p1.length), p1.length ? `${h1} / ${p1.length}경기` : '결과 대기')}
    ${card('k5', '이득 적중', pc(vh, vn), vn ? `${vh} / ${vn}개 · 5,000원씩 <b class="${vpl >= 0 ? 'plus' : ''}">${(vpl >= 0 ? '+' : '−') + Math.abs(Math.round(vpl)).toLocaleString('ko-KR')}원</b>` : '결과 대기')}
    ${card('k2', '언더/오버 적중', pc(ho, po.length), po.length ? `${ho} / ${po.length}경기` : '결과 대기')}
    ${card('k3', '채점한 경기', done.length, '누적')}
    ${card('k4', '분석 대기', waiting, `분석 완료 ${analyzed} · 이득 ${vals}`)}
    ${creditCard(credit)}
    ${apiCard(lgInfo)}
  </div>`;
}
/* Claude 크레딧: Console 잔액은 밖에서 못 읽어서, 입력한 잔액에서 분석할 때 쓴 만큼(실제 토큰 수 × 가격)을 뺀 추정값 */
const usd = v => '$' + (+v).toFixed(2);
const kst = iso => new Date(iso).toLocaleString('ko-KR', {timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false});
function creditCard(c) {
  const has = c && c.balance != null;
  const sub = has
    ? `${esc(kst(c.set_at))} 입력 ${usd(c.set_usd)}${c.added ? ` · 충전 +${usd(c.added)}` : ''} · 이후 사용 −${usd(c.spent)}`
    : 'Console 잔액을 넣으면 분석할 때마다 자동으로 빠집니다';
  return `<div class="kpi k6"><span class="kl">Claude 크레딧 (추정)</span>
    <span class="kn">${has ? '<small>약 </small>' + usd(c.balance) : '-'}</span><span class="ks">${sub}</span>
    ${STATIC ? `<button type="button" class="cr-open">갱신</button>
    <div class="cr-form" hidden>
      <input type="text" inputmode="decimal" class="cr-val" placeholder="예: 48.75 또는 +20">
      <input type="password" class="cr-pw" placeholder="분석 요청 비밀번호" value="${esc(store.get('aa_run_pw'))}" autocomplete="current-password">
      <button type="button" class="btn sm cr-go">저장</button>
      <p class="small cr-msg" role="status">Console 에 보이는 잔액을 그대로 넣으세요. 충전한 금액만 더하려면 앞에 + 를 붙이세요.</p>
    </div>` : ''}</div>`;
}
function wireCredit() {
  const box = view.querySelector('.k6');
  if (!box || !box.querySelector('.cr-open')) return;
  const f = box.querySelector('.cr-form'), msg = box.querySelector('.cr-msg');
  box.querySelector('.cr-open').onclick = () => { f.hidden = !f.hidden; box.classList.toggle('open', !f.hidden); if (!f.hidden) box.querySelector('.cr-val').focus(); };
  box.querySelector('.cr-go').onclick = async e => {
    const v = box.querySelector('.cr-val').value.trim(), pw = box.querySelector('.cr-pw').value;
    if (!/^\+?\$?\d+(\.\d{1,2})?$/.test(v.replace(/,/g, ''))) { msg.textContent = '달러 금액으로 넣으세요. 예: 48.75 또는 +20'; return; }
    if (!pw) { msg.textContent = '비밀번호를 넣으세요.'; return; }
    e.target.disabled = true; msg.textContent = '저장 중…';
    try {
      const r = await fetch('/api/credit', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pw, value: v})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('실패 ' + r.status));
      msg.textContent = (j.type === 'add' ? `충전 +${usd(j.usd)} 저장` : `잔액 ${usd(j.usd)} 저장`) + '했습니다. 2~3분 뒤 사이트가 새로 만들어지면 카드에 보입니다.';
    } catch (err) { msg.textContent = err.message; }
    e.target.disabled = false;
  };
}
const pickSet = () => new Set((store.get('aa_pick_ids') || '').split(',').filter(Boolean));
function pickBar() {
  let bar = document.getElementById('pickbar');
  const n = pickSet().size;
  if (!STATIC || !n || location.hash === '#run') { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'pickbar'; document.body.appendChild(bar); }
  bar.innerHTML = `<span><b class="num">${n}</b>경기 담음</span><a class="btn" href="#run">분석 요청하러 가기 →</a><button type="button" class="btn ghost" id="pickClear">비우기</button>`;
  document.getElementById('pickClear').onclick = () => { store.set('aa_pick_ids', ''); renderList(); };
}
/* ---------- 배당 표시 · 변화 ----------
   목록: 경기명 아래 지금 배당. 화살표는 '분석했을 때 배당'(분석 전 경기는 처음 등록 때 배당) 대비.
   ▲ 배당이 올라감(시장이 덜 유력하게 봄) 빨강, ▼ 내려감(더 유력하게 봄) 파랑. */
let ODDS_H = null;
const histOf = id => ((ODDS_H && ODDS_H.hist) || {})[id] || [];
function oddsNow(m) {
  const h = histOf(m.id);
  return h.length ? h[h.length - 1] : (m.odds_now || m.odds || {});
}
const oddsBase = m => (m.status === 'analyzed' ? m.odds : m.odds_first) || {};
function arrow(now, base) {
  if (now == null || base == null || Math.abs(now - base) < 0.005) return '';
  return now > base ? `<i class="oa up" title="${esc(base)} → ${esc(now)}">▲</i>` : `<i class="oa dn" title="${esc(base)} → ${esc(now)}">▼</i>`;
}
function oddsLine(m) {
  const o = oddsNow(m), b = oddsBase(m);
  if (!o || !o.home) return '<span class="oddsline mute">배당 없음</span>';
  const c = (lab, k) => `${lab} <b class="num">${esc(o[k])}</b>${arrow(o[k], b[k])}`;
  return `<span class="oddsline">${c('승', 'home')} · ${c('무', 'draw')} · ${c('패', 'away')}</span>`;
}
function oddsTable(r) {
  const rows = [];
  const lab = {hour: '1시간 갱신', final: '마감 30분 전'};
  const t = iso => { const d = new Date(iso); return isNaN(d) ? esc(iso || '') : esc(kst(iso)); };
  if (r.odds_first && r.odds_first.home) rows.push({w: '처음 등록', at: r.odds_first.at || '', o: r.odds_first});
  if (r.match.odds && r.match.odds.home) rows.push({w: '분석할 때', at: r.analyzed_at ? t(r.analyzed_at) : '', o: r.match.odds, base: 1});
  const h = histOf(r.match.id);
  h.forEach(x => rows.push({w: lab[x.k] || '갱신', at: t(x.t), o: x}));
  if (!h.length && r.odds_now && r.odds_now.home) rows.push({w: '최근 수집', at: r.odds_now_at || '', o: r.odds_now});
  if (!rows.length) return '';
  const cell = (row, i, k) => `<td class="r num">${row.o[k] != null ? esc(row.o[k]) : '-'}${i ? arrow(row.o[k], rows[i - 1].o[k]) : ''}</td>`;
  return `<div class="sec"><h2>배당 변화 <span class="small mute">여러 북메이커 평균 · 화살표는 바로 위 줄 대비</span></h2><div class="scroll"><table class="stack oddsh">
    <thead><tr><th>시점</th><th>시각</th><th class="r">승</th><th class="r">무</th><th class="r">패</th><th class="r">언더</th><th class="r">오버</th><th class="r">기준점</th></tr></thead><tbody>
    ${rows.map((row, i) => `<tr${row.base ? ' class="obase"' : ''}><td data-l="시점"><b>${esc(row.w)}</b></td><td data-l="시각" class="small">${row.at}</td>${cell(row, i, 'home')}${cell(row, i, 'draw')}${cell(row, i, 'away')}${cell(row, i, 'under')}${cell(row, i, 'over')}<td data-l="기준점" class="r num">${esc(row.o.line ?? '-')}</td></tr>`).join('')}
    </tbody></table></div><p class="small mute">분석한 경기는 1시간마다, 그리고 시작 30분 전쯤 마지막으로 배당을 다시 받습니다. ▲ 배당이 올라감(시장이 덜 유력하게 봄) · ▼ 내려감(더 유력하게 봄).</p></div>`;
}
/* 배당 API 사용량 카드 (정확한 값: 배당 API 가 알려 주는 이번 달 사용량) */
function apiCard(lg) {
  const u = ODDS_H && ODDS_H.usage;
  const used = u ? u.used : lg && lg.usage ? lg.usage.odds_month : null;
  const total = u ? u.used + u.remaining : lg && lg.usage ? lg.usage.odds_limit : null;
  const ratio = used != null && total ? used / total : 0;
  const lv = ratio >= 0.95 ? ' danger' : ratio >= 0.8 ? ' warn' : '';
  return `<div class="kpi k7${lv}"><span class="kl">배당 API 이번 달</span>
    <span class="kn"><span class="ap-used">${used != null ? Number(used).toLocaleString('ko-KR') : '-'}</span><small> / ${total ? Number(total).toLocaleString('ko-KR') : '-'}</small></span>
    <span class="ks ap-sub">${total ? `남은 ${Number(total - used).toLocaleString('ko-KR')} · ${Math.round(ratio * 100)}% · 매월 1일 초기화` : '아직 사용량을 읽지 않았습니다'}</span>
    ${STATIC ? '<button type="button" class="cr-open ap-go">갱신</button>' : ''}</div>`;
}
function wireApiCard() {
  const b = view.querySelector('.ap-go');
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true; b.textContent = '읽는 중…';
    try {
      const r = await fetch('/api/odds/usage', {method: 'POST'});
      const j = await r.json().catch(() => ({}));
      if (!j.usage) throw new Error(j.error === 'no_key' || j.error === 'no_kv' ? '설정 전' : '실패');
      const tot = j.usage.used + j.usage.remaining;
      view.querySelector('.ap-used').textContent = j.usage.used.toLocaleString('ko-KR');
      view.querySelector('.k7 .kn small').textContent = ' / ' + tot.toLocaleString('ko-KR');
      view.querySelector('.ap-sub').textContent = `남은 ${j.usage.remaining.toLocaleString('ko-KR')} · ${Math.round(j.usage.used / tot * 100)}% · 방금 갱신`;
      b.textContent = '갱신';
    } catch (e) { b.textContent = e.message; }
    b.disabled = false;
  };
}
/* ---------- 예측 변경 ----------
   다시 분석해서 예측이 바뀌었으면 '예측 변경 홈승→원정승' 처럼 보여 준다. 같은 예측이 이어지면 한 번만 적는다. */
const SHORT = {home: '홈승', draw: '무', away: '원정승', over: '오버', under: '언더'};
function pickChain(hist, cur, key) {
  const seq = [...hist.map(h => h[key]), cur].map(k => k || null);
  const out = seq.filter((k, i) => i === 0 || k !== seq[i - 1]);
  return out.length > 1 ? out.map(k => k ? SHORT[k] : '보류').join('→') : '';
}
function pickChange(m) {
  const h = m.pick_history || [];
  if (!h.length) return '';
  const a = pickChain(h, m.pick_1x2, 'pick_1x2');
  const b = pickChain(h.filter(x => +x.line === +m.line), m.pick_ou, 'pick_ou');
  return [a && `예측 변경 ${a}`, b && `골 수 변경 ${b}`].filter(Boolean).map(esc).join(' · ');
}
function pickHist(s) {
  const h = s.pick_history || [];
  const chg = pickChange(s);
  if (!chg) return '';
  const rows = [...h, {at: '지금', pick_1x2: s.pick_1x2, pick_ou: s.pick_ou, line: s.line}];
  return `<p class="pickhist"><b>${chg}</b><br><span class="small">${rows.map(x => `${esc(x.at || '-')} ${x.pick_1x2 ? SHORT[x.pick_1x2] : '보류'} · ${x.pick_ou ? SHORT[x.pick_ou] + ' ' + esc(x.line) : '보류'}`).join('  →  ')}</span></p>`;
}
function rowHtml(m) {
  const N = names(m.home, m.away, m.line);
  const head = `<span class="time">${esc(timeOf(m.kickoff))}</span><span class="teams">${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)}${newsBadge(m)}${oddsLine(m)}<span class="lg">${esc(m.league)}</span></span>`;
  if (m.status !== 'analyzed') {
    return `<div class="row">${head}<span class="mid">${liveSlot(m)}</span><span class="tags">${m.picked ? '<span class="tag value">분석 요청함</span>' : STATIC ? `<button type="button" class="pk-toggle" data-pick="${esc(m.id)}" aria-pressed="${pickSet().has(m.id)}">${pickSet().has(m.id) ? '✓ 분석에 담음' : '＋ 분석하기'}</button>` : '<span class="tag wait">분석 대기</span>'}</span></div>`;
  }
  const tags = [];
  const od = m.odds || {};
  const now = oddsNow(m);
  /* 그 선택의 평균 배당(분석할 때). 지금 배당이 달라졌으면 '2.11→1.86▼' 처럼 붙인다 (골 수는 기준점이 같을 때만) */
  const at = k => {
    if (!od[k]) return '';
    const ou = k === 'over' || k === 'under';
    const nv = now && (!ou || +now.line === +m.line) ? now[k] : null;
    const ch = nv != null && Math.abs(nv - od[k]) >= 0.005;
    return ` <b class="num">${esc(od[k])}</b>` + (ch ? `<span class="oc">→<b class="num">${esc(nv)}</b>${arrow(nv, od[k])}</span>` : '');
  };
  const lab = k => esc(k === 'over' || k === 'under' ? N[k + 'S'] + ' ' + m.line : N[k]);
  const va = m.value_alerts || [];
  const both = k => k && va.includes(k);   // 가장 유력하면서 배당도 후한 선택 → 한 번만, 눈에 띄게
  const star = '<span class="star">★ 예측+이득</span> ';
  tags.push(`<span class="tag ${both(m.pick_1x2) ? 'pick both' : 'pick'}">${m.pick_1x2 ? (both(m.pick_1x2) ? star : '예측 ') + esc(N[m.pick_1x2]) + at(m.pick_1x2) : '승패 판단 보류'}</span>`);
  tags.push(`<span class="tag ${both(m.pick_ou) ? 'both' : ''}">${m.pick_ou ? (both(m.pick_ou) ? star : '') + lab(m.pick_ou) + at(m.pick_ou) : '골 수 판단 보류'}</span>`);
  const rest = va.filter(k => k !== m.pick_1x2 && k !== m.pick_ou);
  if (rest.length) tags.push(`<span class="tag value">이득 ${rest.map(k => lab(k) + at(k)).join(' · ')}</span>`);
  const chg = pickChange(m);
  if (chg) tags.push(`<span class="tag chg" title="다시 분석하면서 예측이 바뀜">${chg}</span>`);
  if (m.result) {
    tags.push(`<span class="tag ${m.result.hit_1x2 ? 'hit' : m.result.hit_1x2 === false ? 'miss' : ''}">${esc(m.result.score)} 승무패 ${m.result.hit_1x2 ? '적중' : m.result.hit_1x2 === false ? '빗나감' : '보류'}</span>`);
    if (m.result.hit_ou != null) tags.push(`<span class="tag ${m.result.hit_ou ? 'hit' : 'miss'}">언오버 ${m.result.hit_ou ? '적중' : '빗나감'}</span>`);
  }
  if (m.mock) tags.push('<span class="tag wait">모의</span>');
  const hot = both(m.pick_1x2) || both(m.pick_ou);   /* 예측+이득(★) 경기는 줄 전체를 진한 회색으로 */
  const val = !hot && (m.value_alerts || []).length > 0;   /* 이득만 있는 경기는 연분홍 */
  return `<a class="row${hot ? ' hot' : val ? ' val' : ''}" href="#m-${encodeURIComponent(m.id)}">${head}<span class="mid">${liveSlot(m)}${tri(m.probs, m.pick_1x2)}</span><span class="tags">${tags.join('')}</span></a>`;
}

/* ---------- 실시간 스코어 ----------
   진행 중일 수 있는 경기(시작 15분 전 ~ 시작 4시간 뒤: 킥오프가 늦어지는 경기 대비)가 화면에 있을 때만 1분마다 /api/live 를 묻는다.
   서버는 1분에 한 번만 API-Football 에 묻고 모두에게 같은 값을 준다. */
const kickMs = m => { const d = dayOf(m.kickoff), t = timeOf(m.kickoff); return d && t ? Date.parse(`${d}T${t}:00+09:00`) : NaN; };
const mayBeLive = m => { const k = kickMs(m), n = Date.now(); return !m.result && k - 15 * 60e3 <= n && n <= k + 4 * 3600e3; };
/* 시작 후 2시간이 지났는데 결과(매시 17분 수집)가 아직 없으면 '경기 종료 · 결과 반영 대기'. 실시간 목록에 아직 진행 중으로 있으면 점수를 먼저 보여 준다 */
const WAIT_MS = 2 * 3600e3;
const WAIT_HTML = '<span class="lv-w">경기 종료 · 결과 반영 대기</span>';
const awaitingResult = m => { const k = kickMs(m), n = Date.now(); return !m.result && k + WAIT_MS <= n && n <= k + 24 * 3600e3; };
const liveSlot = m => {
  const w = awaitingResult(m);
  if (mayBeLive(m)) return `<span class="lv" data-live="${esc(m.id)}" data-kick="${kickMs(m)}"${w ? '' : ' hidden'}>${w ? WAIT_HTML : ''}</span>`;
  return w ? `<span class="lv">${WAIT_HTML}</span>` : '';
};
const liveSeen = {};   /* 진행 중으로 본 적 있는 경기의 마지막 값: 목록에서 빠지면 '종료'로 보여 준다 */
let liveTimer = null;
const LIVE_ON = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'];
function liveText(x, ended) {
  /* 시간(노란 알약) · 홈 점수(빨간 테두리) · 원정 점수(파란 테두리) */
  const sc = `<b class="lv-h num" title="홈">${esc(x.h)}</b><b class="lv-a num" title="원정">${esc(x.a)}</b>`;
  const t = (txt, dot, cls = '') => `<span class="lv-t${cls}">${dot ? '<i class="dot"></i>' : ''}${txt}</span>`;
  if (ended || ['FT', 'AET', 'PEN'].includes(x.s)) return t('종료', false) + sc;
  if (x.s === 'HT') return t('HT', false) + sc;
  if (x.s === 'P') return t('승부차기', true) + sc;
  return t(x.m != null ? esc(x.m) + "'" : 'LIVE', true, ' num') + sc;
}
async function liveTick() {
  clearTimeout(liveTimer);
  const els = [...document.querySelectorAll('[data-live]')];
  if (!STATIC || !els.length) return;
  let d;
  try { const r = await fetch('/api/live', {cache: 'no-cache'}); d = await r.json(); } catch (e) { d = null; }
  if (d && d.error === 'no_key') return;   /* 키가 아직 없으면 조용히 멈춘다 */
  if (!d || d.error) { liveTimer = setTimeout(liveTick, 60e3); return; }   /* 오류면 화면의 점수를 그대로 두고 1분 뒤 다시 */
  const live = (d && d.live) || {};
  document.querySelectorAll('[data-live]').forEach(el => {
    const id = el.dataset.live, x = live[id];
    if (x) liveSeen[id] = x;
    const show = x || (d && liveSeen[id] ? {...liveSeen[id]} : null);
    if (!show) {
      const past = Date.now() >= Number(el.dataset.kick) + WAIT_MS;
      el.className = 'lv'; el.innerHTML = past ? WAIT_HTML : ''; el.hidden = !past;
      return;
    }
    el.className = 'lv' + (x && LIVE_ON.includes(x.s) && x.s !== 'HT' ? ' on' : '');
    el.innerHTML = liveText(show, !x) + (!x ? WAIT_HTML : '');
    el.hidden = false;
  });
  liveTimer = setTimeout(liveTick, 60e3);
}

/* ---------- 경기 상세 ---------- */
async function renderMatch(id) {
  const r = await api('/api/matches/' + encodeURIComponent(id));
  await loadNews();
  ODDS_H = await api('/api/odds').catch(() => null);
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
    <td data-l="배당" class="r num">${esc(c.o ?? '-')}</td><td data-l="5,000원당 평균 손익" class="r"><span class="ev ${c.e != null && c.e >= TH ? 'plus' : ''}">${won(c.e)}</span></td></tr>`;
  const pickName = one.pick ? N[one.pick] : null;
  let lead;
  if (pickName && good.length && !good.some(c => c.k === one.pick)) lead = `가장 일어날 것 같은 결과는 ${pickName}이지만, 배당이 후하게 나온 쪽은 ${good.map(c => c.label).join(', ')}입니다.`;
  else if (pickName && good.some(c => c.k === one.pick)) lead = `${pickName}은 가장 일어날 것 같고, 배당도 후하게 나와 있습니다.`;
  else if (!pickName) lead = '분석가 의견이 갈려 승패는 판단을 보류합니다.' + (good.length ? ` 배당이 후한 쪽: ${good.map(c => c.label).join(', ')}.` : '');
  else lead = '이번 경기는 배당이 후하게 나온 선택이 없습니다.';
  const why = good.map(c => `<li><b>${esc(c.label)}</b>: 우리는 ${pct(c.p)}로 보는데, 이 배당은 ${pct(c.be)}만 돼도 본전입니다. 5,000원을 걸면 평균 <b>${won(c.e)}</b>.</li>`).join('');

  const res = s.result ? `<span class="result">${esc(s.result.score)}</span>` : '<span class="vs">VS</span>';
  const lu = md.lineup || {};
  const list = a => (a && a.length) ? `<ul>${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="mute small">자료 없음</p>';
  /* 결장자 칸: 비어 있을 때 '자료가 없는 리그'인지 '보고된 결장자가 없음'인지 구분해서 보여 준다 */
  const LU_EMPTY = {unsupported: '이 리그는 결장자 자료가 제공되지 않아요 (결장자가 없다는 뜻은 아님)', none: '보고된 결장자 없음', skipped: '목록 수집 단계라 아직 받지 않음'};
  const luList = a => (a && a.length) ? list(a) : `<p class="mute small">${LU_EMPTY[lu.status] || '자료 없음'}</p>`;
  const KEYS = {home_days_rest: `${m.home} 휴식일`, away_days_rest: `${m.away} 휴식일`, home_prev: `${m.home} 직전 경기`, away_prev: `${m.away} 직전 경기`, home_next: `${m.home} 다음 경기`, away_next: `${m.away} 다음 경기`};
  const kv = o => (o && typeof o === 'object' && !Array.isArray(o)) ? `<ul>${Object.entries(o).filter(([k]) => k !== '설명').sort(([a], [b]) => (a.startsWith('home') ? 0 : 1) - (b.startsWith('home') ? 0 : 1)).map(([k, v]) => `<li>${esc(KEYS[k] || k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}${/days_rest/.test(k) ? '일' : ''}</li>`).join('')}</ul>` : Array.isArray(o) ? list(o) : `<p>${esc(o ?? '자료 없음')}</p>`;

  view.innerHTML = `
  <section class="board band"><div class="wrap">
    <p class="meta">${esc(m.league)} · ${esc(m.kickoff)}</p>
    <div class="fixture"><span class="team home">${esc(m.home)}</span>${res}<span class="team">${esc(m.away)}</span></div>
    <div class="verdicts">
      <div class="verdict"><div class="vh"><span>누가 이기나</span><span class="small">${esc(voteText(one.tally))}</span></div><b class="vb">${pickName ? esc(pickName) : '판단 보류'}</b></div>
      <div class="verdict"><div class="vh"><span>골 수</span><span class="small">${esc(voteText(ou.tally))}</span></div><b class="vb">${ou.pick ? esc(N[ou.pick]) : '판단 보류'}</b></div>
    </div>
    ${pickHist(s)}
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
          <div class="scroll"><table class="stack vt"><thead><tr><th>선택</th><th class="r">우리 예상</th><th class="r">본전</th><th class="r">배당</th><th class="r">5,000원당</th></tr></thead><tbody>
          ${choices.map(vRow).join('')}
          </tbody></table></div>
          ${why ? `<ul class="small why">${why}</ul>` : ''}
          <details><summary>이 표 읽는 법</summary><div class="small">
            <p><b>우리 예상</b>은 우리가 본 가능성, <b>본전</b>은 본전 가능성, <b>5,000원당</b>은 5,000원당 평균 손익입니다.</p>
            <p><b>본전 가능성</b> = 1 ÷ 배당. 배당 2.00이면 50%입니다. 그 결과가 이보다 자주 일어나야 길게 봤을 때 손해가 아닙니다.</p>
            <p><b>우리가 본 가능성</b>이 본전 가능성보다 높으면 배당이 후하게 나온 것이고, 낮으면 비싸게 나온 것입니다.</p>
            <p><b>5,000원당 평균 손익</b>은 같은 판단을 아주 여러 번 했을 때 5,000원마다 평균으로 남거나 잃는 돈입니다. <span class="ev plus">+250원</span> 이상일 때만 노란 <b>이득 신호</b>를 켭니다. 우리 계산에도 오차가 있어서, 작은 차이는 믿지 않습니다.</p>
            <p><b>이득 신호가 이번 경기에서 맞는다는 뜻은 아닙니다.</b> 가능성 31%라면 10번 중 7번은 빗나갑니다. 또 배당이 바뀌면 이득도 바뀝니다.</p>
          </div></details></div>
        <div class="panel small"><b>분석 방식</b><br><span class="mute">${esc(r.engine)}</span><br><b>분석 시각</b> <span class="mute">${esc(r.analyzed_at || '-')}</span><br><b>투표 비중</b> <span class="mute">${r.final.map(o => esc(o.member_name) + ' ' + (d.weights[o.member_id] != null ? d.weights[o.member_id].toFixed(2) : '투표 안 함')).join(', ')}</span></div>
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

    ${oddsTable(r)}
    <div class="sec"><h2>토론 전후 변화${s.result ? ` <span class="small mute">결과 ${esc(s.result.score)} · ○ 적중 ✕ 미적중</span>` : ''}</h2><div class="scroll"><table class="stack">
      <thead><tr><th>분석가</th><th>처음 고른 결과</th><th>최종</th><th>골 수 (처음→최종)</th><th class="r">처음 가능성 (승/무/패)</th><th class="r">최종 가능성 (승/무/패)</th><th class="r">오버 가능성</th></tr></thead><tbody>
      ${r.final.map(o => { const f = first[o.member_id] || o; return `<tr><td data-l="분석가"><b>${esc(o.member_name)}</b></td><td data-l="처음 고른 결과">${esc(N[f.pick_1x2])} ${OX(f.hit_1x2)}</td><td data-l="최종"><b>${esc(N[o.pick_1x2])}</b> ${OX(o.hit_1x2)}</td><td data-l="골 수">${esc(N[f.pick_ou + 'S'])} ${OX(f.hit_ou)} → ${esc(N[o.pick_ou + 'S'])} ${OX(o.hit_ou)}</td><td data-l="처음 가능성" class="r num">${pct(f.probs.home)}/${pct(f.probs.draw)}/${pct(f.probs.away)}</td><td data-l="최종 가능성" class="r num">${pct(o.probs.home)}/${pct(o.probs.draw)}/${pct(o.probs.away)}</td><td data-l="오버 가능성" class="r num">${pct(f.over_prob)}→${pct(o.over_prob)}</td></tr>`; }).join('')}
      </tbody></table></div></div>

    ${(NEWS_BY[m.id] || []).length ? `<div class="sec"><h2>관련 뉴스 <span class="small mute">분석가에게도 전달됨 · 3시간마다 갱신</span></h2>${NEWS_BY[m.id].map(x => newsItem(x)).join('')}</div>` : ''}
    <div class="sec"><h2>분석에 쓴 자료</h2><div class="facts">
      <div><h3>${esc(m.home)} 결장·불투명</h3>${luList([...(lu.home_absent || []), ...(lu.home_doubtful || []).map(x => '불투명: ' + x)])}</div>
      <div><h3>${esc(m.away)} 결장·불투명</h3>${luList([...(lu.away_absent || []), ...(lu.away_doubtful || []).map(x => '불투명: ' + x)])}</div>
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

/* 경기 상세 위쪽 예측 칸: 한 줄에 안 들어가면 글자를 조금씩 줄여 한 줄로 맞춘다 */
function fitVerdicts() {
  document.querySelectorAll('.verdict .vb').forEach(b => {
    b.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(b).fontSize);
    while (b.scrollWidth > b.clientWidth + 1 && fs > 14) { fs -= 1; b.style.fontSize = fs + 'px'; }
  });
}
window.addEventListener('resize', () => fitVerdicts());

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
      <div class="stat"><span class="num">+${Math.round(c.policy.value_threshold * UNIT).toLocaleString('ko-KR')}원</span><span>5,000원당 평균 손익이 이 이상이면 이득 신호</span></div>
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
/* 토론 전(1차) 적중률 순위: 누가 처음부터 잘 맞히는지 */
function firstRank(d, ini) {
  const rows = d.members.map(x => ({x, i: ini[x.member_id]})).filter(o => o.i && o.i.n);
  if (!rows.length) return '';
  rows.sort((a, b) => (b.i.acc_1x2 - a.i.acc_1x2) || (b.i.acc_ou - a.i.acc_ou));
  const hit = (a, n) => Math.round(a * n);
  const pp = v => { const t = Math.round(v * 100); return (t > 0 ? '+' : t < 0 ? '−' : '±') + Math.abs(t) + '%p'; };
  const few = Math.min(...rows.map(o => o.i.n)) < 50;
  const key = o => Math.round(o.i.acc_1x2 * 1000) + ':' + Math.round(o.i.acc_ou * 1000);
  const rank = rows.map((o, k) => rows.findIndex(p => key(p) === key(o)) + 1);   /* 같은 성적은 공동 순위 */
  const tie = r => rank.filter(v => v === r).length > 1;
  return `<h3 style="margin-top:18px">처음부터 누가 잘 맞히나 <span class="small mute">토론 전 1차 예측 기준</span></h3>
    <div class="fr-grid">${rows.map((o, k) => `<div class="fr-card" style="--mc:${esc(o.x.color || '#333')}">
      <div class="fr-head"><span class="fr-rank num">${tie(rank[k]) ? '공동 ' : ''}${rank[k]}위</span><span class="who-badge sm">${esc(o.x.name)}</span>${o.x.votes === false ? '<span class="small mute">비교용</span>' : ''}</div>
      <div class="fr-nums">
        <div><span class="small mute">승무패</span><b class="num">${pct(o.i.acc_1x2, 0)}</b><span class="small mute num">${hit(o.i.acc_1x2, o.i.n)} / ${esc(o.i.n)}</span></div>
        <div><span class="small mute">언더/오버</span><b class="num">${pct(o.i.acc_ou, 0)}</b><span class="small mute num">${hit(o.i.acc_ou, o.i.n)} / ${esc(o.i.n)}</span></div>
      </div>
      <div class="small mute">토론 후 변화 · 승무패 <b class="num">${pp(o.x.acc_1x2 - o.i.acc_1x2)}</b> · 언오버 <b class="num">${pp(o.x.acc_ou - o.i.acc_ou)}</b></div>
    </div>`).join('')}</div>
    ${few ? '<p class="small mute" style="margin:6px 0 0">표본 적음: 아직 경기 수가 적어 1~2경기로 순위가 바뀝니다. 50경기 이상 쌓이면 실력 차이로 볼 수 있습니다.</p>' : ''}`;
}
async function renderRecord() {
  const r = await api('/api/record');
  const cstat = (c, label) => `<div class="rules" style="margin-top:12px">
        <div class="stat"><span class="num">${esc(c.settled)}</span><span>${label} 채점한 경기</span></div>
        <div class="stat"><span class="num">${pct(c.acc_1x2, 1)}</span><span>팀 결론 승무패 적중률 (예측 ${esc(c.picks_1x2)}, 판단 보류 ${esc(c.passes_1x2)})</span></div>
        <div class="stat"><span class="num">${pct(c.acc_ou, 1)}</span><span>팀 결론 언더/오버 적중률</span></div>
        <div class="stat"><span class="num">${won(c.roi_1x2)}</span><span>승무패 예측에 5,000원씩 걸었다면 경기당 평균 손익</span></div>
      </div>`;
  view.innerHTML = `<section class="band"><div class="wrap"><h1>인사평가</h1>
    <p class="lead mute">경기가 끝나면 모든 예측을 자동으로 채점합니다. <b>1차</b>는 혼자 처음 낸 분석, <b>최종</b>은 토론 뒤 고친 분석입니다. ${esc(r.min_samples)}경기 이상 채점된 분석가는 성적에 따라 투표 비중이 바뀝니다 (호구형은 투표 안 하는 비교용). 모의 실행은 빠집니다.</p>
    ${r.departments.map(d => {
      const ini = Object.fromEntries((d.members_initial || []).map(x => [x.member_id, x]));
      const cell = (x, k) => x ? pct(x[k], 0) : '-';
      return `<div class="sec"><h2>${esc(d.department)}</h2>
      <h3 style="margin-top:14px">전체 경기</h3>${cstat(d.company, '전체')}
      ${firstRank(d, ini)}
      <h3 style="margin-top:18px">분석가별 적중률</h3>
      ${d.members.length ? `<div class="scroll"><table class="stack rec"><thead><tr><th>분석가</th><th class="r">채점 경기</th><th class="r">승무패<br>1차 → 최종</th><th class="r">언더/오버<br>1차 → 최종</th><th class="r">가능성 오차</th><th class="r">5,000원당 손익</th><th class="r">투표 비중</th></tr></thead><tbody>
        ${d.members.map(x => { const i = ini[x.member_id]; return `<tr style="--mc:${esc(x.color || '#333')}"><td data-l="분석가"><span class="who-badge sm">${esc(x.name)}</span></td><td data-l="채점 경기" class="r num">${esc(x.n)}</td>
          <td data-l="승무패 1차→최종" class="r num">${cell(i, 'acc_1x2')} → <b>${pct(x.acc_1x2, 0)}</b></td>
          <td data-l="언오버 1차→최종" class="r num">${cell(i, 'acc_ou')} → <b>${pct(x.acc_ou, 0)}</b></td>
          <td data-l="가능성 오차" class="r num">${x.brier_1x2.toFixed(3)}</td><td data-l="5,000원당 손익" class="r num">${won(x.roi_1x2)}</td>
          <td data-l="투표 비중" class="r num">${x.votes === false ? '<span class="mute">투표 안 함</span>' : x.weight.toFixed(2)}</td></tr>`; }).join('')}
      </tbody></table></div><p class="small mute">1차 → 최종: 혼자 판단했을 때와 토론 뒤의 적중률입니다. 토론으로 나아졌는지 볼 수 있습니다. 가능성 오차(브라이어 점수)는 낮을수록 잘 맞힌 것입니다.</p>`
        : '<p class="empty">아직 결과가 들어온 경기가 없습니다. 첫 경기가 끝나면 여기에 성적이 쌓입니다.</p>'}</div>`; }).join('')}
  </div></section>`;
}

/* ---------- 배팅 게임: 분석가들이 가상 100만원으로 3·5·7폴더 ---------- */
async function renderBets() {
  const b = await api('/api/bets');
  /* 각 선택이 팀 결론의 '예측'인지, 배당이 후한 '이득'인지, 둘 다인지 표시하려고 경기 목록도 읽는다 */
  const MM = {};
  try { ((await api('/api/matches')).matches || []).forEach(m => { MM[m.id] = m; }); } catch (e) { /* 없으면 표시만 생략 */ }
  const kindOf = l => {
    const m = MM[l.match_id];
    if (!m || m.status !== 'analyzed') return '';
    const pk = l.market === '1x2' ? m.pick_1x2 : m.pick_ou;
    const isPick = pk === l.pick, isVal = (m.value_alerts || []).includes(l.pick) && (l.market === '1x2' || +l.line === +m.line);
    if (isPick && isVal) return '<span class="tag both tk-kind"><span class="star">★ 예측+이득</span></span>';
    if (isPick) return '<span class="tag pick tk-kind">예측</span>';
    if (isVal) return '<span class="tag value tk-kind">이득</span>';
    return '<span class="tag wait tk-kind" title="팀 결론과 다른, 이 분석가 개인의 선택">개인 선택</span>';
  };
  const W = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('ko-KR') + '원';
  const pctx = p => (p * 100).toFixed(1) + '%';
  const st = s => s.status === 'won' ? '<span class="tag hit">적중</span>' : s.status === 'lost' ? '<span class="tag miss">미적중</span>' : '<span class="tag wait">진행 중</span>';
  const mark = l => l.hit === true ? '<span class="tag hit">적중</span>' : l.hit === false ? '<span class="tag miss">미적중</span>' : '';
  const won100 = v => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * UNIT / 100)).toLocaleString('ko-KR') + '원';
  const howText = s => {
    const h = s.how || {};
    const q = h.kelly_quarter || 0;
    return `<b>금액 정한 방법</b> · 모두 맞을 가능성 ${pctx(s.prob)} × 배당 ${esc(s.combined_odds)} → 5,000원당 평균 ${won100(h.ev_per_100 ?? 0)}. `
      + (q > 0 ? `켈리 기준(자신감 비율)의 1/4 = 남은 돈의 ${(q * 100).toFixed(1)}% → ${W(s.stake)} (한 장 5천~10만원 안으로 맞춤).`
               : `계산상 이득이 크지 않아 최소 금액 ${W(s.stake)}만 걸었습니다.`);
  };
  const who = {};
  b.accounts.forEach(a => { who[a.member_id] = a; });
  const col = id => (who[id] && who[id].color) || '#0d5c35';
  const DOW = '일월화수목금토';
  const when = k => { const [d, t] = [k.slice(0, 10), k.slice(11, 16)]; const [y, mo, da] = d.split('-').map(Number);
    return `${mo}.${da} (${DOW[new Date(y, mo - 1, da).getDay()]}) <br>${t}`; };
  const OPT = {home: '승', draw: '무', away: '패', under: '언더', over: '오버'};
  const legRows = sz => (l, i) => {
    const opts = l.opts || (l.market === '1x2' ? {home: null, draw: null, away: null} : {under: null, over: null});
    if (opts[l.pick] == null) opts[l.pick] = l.odds;
    const order = l.market === '1x2' ? ['home', 'draw', 'away'] : ['under', 'over'];
    const btns = order.map(k => `<span class="tk-opt${k === l.pick ? ' on' : ''}">${OPT[k]}<b class="num">${opts[k] != null ? esc(opts[k]) : '-'}</b></span>`).join('');
    const game = l.market === '1x2' ? '축구 승무패' : `축구 언더오버 <span class="tk-line">U/O ${esc(l.line)}</span>`;
    return `<tr class="tk-match"><td class="tk-when">${when(l.kickoff)}</td><td class="tk-lg">⚽ ${esc(l.league || '')}</td>
        <td colspan="2"><a href="#m-${encodeURIComponent(l.match_id)}"><b>${esc(l.home || l.title)}</b> <span class="mute small">vs</span> <b>${esc(l.away || '')}</b></a></td></tr>
      <tr class="tk-game"><td class="tk-when">${when(l.kickoff)} 마감</td>
        <td><span class="leg-no">${i + 1}</span> <span class="small mute">${esc(sz)}폴더 조합</span><br><b>${game}</b> ${kindOf(l)}</td>
        <td><div class="tk-opts n${order.length}">${btns}</div></td><td class="tk-res">${mark(l)}</td></tr>`;
  };
  const slip = (s, brief) => `<div class="panel slip ticket" style="--mc:${esc(col(s.member_id))}">
    <div class="slip-head">
      <span class="who-badge">${esc(s.member_name)}</span>
      <span class="slip-size">${esc(s.size)}폴더</span>
      <span class="small mute">${esc(s.placed_at)} 배팅</span>
      <span style="margin-left:auto">${st(s)}</span></div>
    <div class="tk-scroll"><table class="tk">
      <thead><tr><th>개최일시</th><th>종목 · 대회</th><th>대상경기(홈 vs 원정) · 게임주제</th><th>결과</th></tr></thead>
      <tbody>${s.legs.map(legRows(s.size)).join('')}</tbody></table></div>
    <table class="tk-sum"><thead><tr><th>선택경기수</th><th>예상배당률</th><th>개별투표금액</th><th>예상적중금액</th></tr></thead>
      <tbody><tr><td>${esc(s.legs.length)}경기</td><td class="num">${esc(s.combined_odds)}배</td><td class="num">${W(s.stake)}</td><td class="num">${W(Math.floor(s.stake * s.combined_odds))}</td></tr>
      <tr class="tk-total"><td colspan="4">총투표금액 <b class="num">${W(s.stake)}</b>${s.status === 'won' ? ` · 받은 돈 <b class="num">${W(s.payout)}</b>` : ''}</td></tr></tbody></table>
    ${brief ? '' : `<div class="tk-explain"><h3>설명</h3>
      <p class="small">${howText(s)}</p>
      <ol class="small">${s.legs.map(l => `<li><b>${esc(l.title)} → ${esc(l.label)} @${esc(l.odds)}</b><br>
        AI 가능성 <b>${pctx(l.prob)}</b> · 본전 가능성(1÷배당) ${pctx(l.breakeven ?? 1 / l.odds)} · 5,000원당 <b class="${(l.ev ?? 0) >= 0 ? 'plus' : ''}">${won100((l.ev ?? (l.prob * l.odds - 1)) * 100)}</b>
        ${l.reason ? `<br><span class="mute">“${esc(l.reason)}”</span>` : ''}</li>`).join('')}</ol></div>`}</div>`;
  const pick = store.get('aa_bet_who') || 'all';
  const shown = pick === 'all' ? b.accounts : b.accounts.filter(a => a.member_id === pick);
  /* 모두 보기 = 결과가 아직 안 나온 배팅표, 배팅 결과 = 끝난 배팅표 (적중·미적중으로 걸르기) */
  const betView = store.get('aa_bet_view') === 'done' ? 'done' : 'open';
  const resF = ['won', 'lost'].includes(store.get('aa_bet_res')) ? store.get('aa_bet_res') : 'all';
  const mineAll = id => b.slips.filter(s => s.member_id === id && (pick === 'all' || id === pick));
  const inView = s => betView === 'open' ? s.status === 'open' : s.status !== 'open' && (resF === 'all' || s.status === resF);
  const newest = (x, y) => String(y.placed_at).localeCompare(String(x.placed_at));
  const pool = b.slips.filter(s => pick === 'all' || s.member_id === pick);
  const nOpen = pool.filter(s => s.status === 'open').length, nDone = pool.length - nOpen;
  const nWon = pool.filter(s => s.status === 'won').length, nLost = pool.filter(s => s.status === 'lost').length;
  view.innerHTML = `<section class="band"><div class="wrap"><h1>배팅 게임</h1>
    <p class="lead mute">분석가들이 각자 가상 자금 <b>${W(b.start_bankroll)}</b>으로 자기 예측만 믿고 3폴더·5폴더·7폴더 조합 배팅을 합니다. 한 장에 ${W(b.min_stake)}~${W(b.max_stake)}, 경기는 이틀 안에서만 고릅니다. 실제 돈이 아닌 실력 비교용입니다.</p>
    <div class="grid4">${b.accounts.map(a => { const bs = a.by_size || {}; return `<div class="panel acc-card" aria-pressed="${pick === a.member_id}" style="--mc:${esc(col(a.member_id))}">
      <span class="who-badge">${esc(a.name)}</span> <span class="small mute">${esc(a.title)}</span>
      <span class="num acc-value">${W(a.value)}</span>
      <span class="small" style="display:block;margin:2px 0 8px">손익 <b class="num">${a.profit >= 0 ? '+' : ''}${W(a.profit)}</b> (${((a.profit / (b.start_bankroll + (a.deposited || 0))) * 100).toFixed(1)}%)${a.deposited ? ` · <span class="mute">추가로 넣은 돈 ${W(a.deposited)}</span>` : ''}</span>
      <div class="acc-rates">
        <div><span>배팅 적중</span><b class="num">${rate(a.won, a.settled)}</b></div>
        <div><span>경기별 적중</span><b class="num">${rate(a.legs_hit || 0, a.legs_settled || 0)}</b></div>
        <div class="small mute">${['3', '5', '7'].map(k => `${k}폴더 ${bs[k] ? `${bs[k].won}/${bs[k].settled}` : '0/0'}`).join(' · ')}</div>
      </div>
      <span class="small mute" style="display:block">남은 돈 ${W(a.bankroll)} · 걸어 둔 돈 ${W(a.at_risk)}</span>
      <div class="acc-actions"><button type="button" class="btn ghost sm" data-who="${esc(a.member_id)}">${pick === a.member_id ? '모두 보기' : '이 사람 배팅만'}</button>
        ${STATIC ? `<button type="button" class="btn ghost sm" data-topup="${esc(a.member_id)}">＋ 금액 넣기</button>` : ''}</div>
      <div class="topup" id="tu-${esc(a.member_id)}" hidden>
        <div class="chips">${[100000, 500000, 1000000].map(v => `<button type="button" class="chip" data-amt="${v}">${W(v)}</button>`).join('')}</div>
        <input type="number" min="10000" max="10000000" step="10000" placeholder="직접 입력 (원)" class="tu-amt">
        <input type="password" placeholder="분석 요청 비밀번호" class="tu-pw" value="${esc(store.get('aa_run_pw'))}" autocomplete="current-password">
        <button type="button" class="btn sm tu-go">넣기</button><p class="small tu-msg" role="status"></p>
      </div></div>`; }).join('')}</div>
    <div class="bettabs">
      <div class="segbar" role="group" aria-label="배팅 보기">
        <button class="seg" data-bview="open" aria-pressed="${betView === 'open'}">모두 보기 <span class="num">${nOpen}</span></button>
        <button class="seg res" data-bview="done" aria-pressed="${betView === 'done'}">배팅 결과 <span class="num">${nDone}</span></button></div>
      ${pick !== 'all' ? `<button class="chip" data-who="all">${esc((who[pick] || {}).name || '')}만 보는 중 · 모두 보기 ✕</button>` : ''}</div>
    ${betView === 'done' ? `<div class="chips" role="group" aria-label="결과 걸르기" style="margin-top:10px">
        <button class="chip" data-bres="all" aria-pressed="${resF === 'all'}">전체 <span class="num">${nDone}</span></button>
        <button class="chip" data-bres="won" aria-pressed="${resF === 'won'}">적중 <span class="num">${nWon}</span></button>
        <button class="chip" data-bres="lost" aria-pressed="${resF === 'lost'}">미적중 <span class="num">${nLost}</span></button></div>` : ''}
    ${shown.map(a => {
      const mine = mineAll(a.member_id).filter(inView).sort(newest);
      const empty = betView === 'open' ? '진행 중인 배팅이 없습니다. 분석이 끝난 경기가 생기면 자동으로 겁니다.' : '해당하는 배팅 결과가 없습니다.';
      return `<h2 class="who-title" style="--mc:${esc(col(a.member_id))}"><span class="dot"></span>${esc(a.name)}의 ${betView === 'open' ? '배팅' : '배팅 결과'} <span class="small mute">${mine.length}장 · 배팅 적중 ${rate(a.won, a.settled)}</span></h2>${mine.length ? mine.map(s => slip(s, betView === 'done')).join('') : `<p class="empty">${empty}</p>`}`;
    }).join('')}
    <p class="small mute" style="margin-top:24px">고르는 법: 각 분석가가 경기마다 자기 최종 가능성으로 승무패·언더오버 중 가장 이득인 선택 하나를 고릅니다(가능성 45% 미만은 제외). 그중 5,000원당 평균 손익이 큰 경기부터 3·5·7개를 담습니다. 금액은 켈리 기준의 1/4(자신 있을수록 많이)을 한도 안에서 1,000원 단위로. 배당은 북메이커 평균. 배당 자료가 없는 리그·대회(K리그2·J2리그·AFC챔피언스리그)는 빠집니다. 추가로 넣은 돈은 손익에서 빼고 계산합니다.</p>
  </div></section>`;
  view.querySelectorAll('[data-bview]').forEach(el => el.onclick = () => {
    store.set('aa_bet_view', el.dataset.bview);
    if (el.dataset.bview === 'open') store.set('aa_bet_who', 'all');   /* 모두 보기 = 모든 분석가의 진행 중 배팅 */
    renderBets();
  });
  view.querySelectorAll('[data-bres]').forEach(el => el.onclick = () => { store.set('aa_bet_res', el.dataset.bres); renderBets(); });
  view.querySelectorAll('[data-who]').forEach(el => el.onclick = () => {
    const w = el.dataset.who;
    store.set('aa_bet_who', w === pick && w !== 'all' ? 'all' : w);
    renderBets();
  });
  view.querySelectorAll('[data-topup]').forEach(el => el.onclick = () => {
    const box = document.getElementById('tu-' + el.dataset.topup); box.hidden = !box.hidden;
  });
  view.querySelectorAll('.topup').forEach(box => {
    const who = box.id.slice(3), amt = box.querySelector('.tu-amt'), msg = box.querySelector('.tu-msg');
    box.querySelectorAll('[data-amt]').forEach(c => c.onclick = () => { amt.value = c.dataset.amt; });
    box.querySelector('.tu-go').onclick = async e => {
      const v = Math.floor(+amt.value / 1000) * 1000, pw = box.querySelector('.tu-pw').value;
      if (!(v >= 10000 && v <= 10000000)) { msg.textContent = '1만원 ~ 1,000만원 사이로 넣으세요.'; return; }
      if (!pw) { msg.textContent = '비밀번호를 넣으세요.'; return; }
      e.target.disabled = true; msg.textContent = '넣는 중…';
      try {
        const r = await fetch('/api/topup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pw, member_id: who, amount: v})});
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('실패 ' + r.status));
        msg.textContent = `${W(v)} 넣었습니다. 1~2분 뒤 사이트가 새로 만들어지면 잔액에 보입니다.`;
      } catch (err) { msg.textContent = err.message; }
      e.target.disabled = false;
    };
  });
}

/* ---------- 분석 요청 (정적 사이트: Cloudflare 함수 /api/run → GitHub Actions) ---------- */
let runPoll = null;
async function renderRun() {
  const [L, M] = await Promise.all([api('/api/leagues'), api('/api/matches')]);
  const now = Date.now();
  const kickMs = k => { const t = Date.parse((k || '').slice(0, 16).replace(' ', 'T') + ':00+09:00'); return isNaN(t) ? 0 : t; };
  const open = M.matches.filter(m => m.status === 'pending' && kickMs(m.kickoff) > now);
  let chosen = new Set((store.get('aa_pick_ids') || '').split(',').filter(id => open.some(m => m.id === id)));
  let lgF = store.get('aa_pick_lg') || 'all';
  const lgCount = {};
  open.forEach(m => { lgCount[lgName(m)] = (lgCount[lgName(m)] || 0) + 1; });
  if (lgF !== 'all' && !lgCount[lgF]) lgF = 'all';
  const saved = store.get('aa_run_leagues');
  let picked = new Set(saved ? saved.split(',').map(Number) : L.defaults);
  const groups = [...new Set(L.leagues.map(l => l.group))];
  const u = L.usage || {};
  const last = L.last_run;
  view.innerHTML = `<section class="band"><div class="wrap"><h1>분석 요청</h1>
    <p class="lead mute">6시·14시에는 1주일치 경기 <b>목록만</b> 모읍니다 (Claude 비용 없음). 분석할 경기를 아래에서 직접 골라 <b>고른 경기 분석</b>을 누르세요. 보통 5~20분 뒤 경기 목록에 올라옵니다.</p>
    <div class="sheet sec"><div>
      <div class="inline" style="justify-content:space-between"><h2>경기 고르기 <span class="small mute">분석 대기 ${open.length}경기</span></h2>
        <span class="inline"><button class="btn ghost" id="pkNone" type="button">선택 해제</button></span></div>
      <div class="chips lgchips" role="group" aria-label="리그 거르기">
        <button class="chip" data-plg="all" aria-pressed="${lgF === 'all'}">모든 리그 <span class="num">${open.length}</span></button>
        ${Object.entries(lgCount).sort((x, y) => y[1] - x[1]).map(([n, c]) => `<button class="chip" data-plg="${esc(n)}" aria-pressed="${lgF === n}">${esc(n)} <span class="num">${c}</span></button>`).join('')}</div>
      <div id="pkList"></div>
    </div><div>
      <div class="panel pk-panel"><h2>고른 경기 <span class="num" id="pkCount">0</span>개</h2>
        <ul class="small pk-chosen" id="pkChosen"></ul>
        <div class="form" style="margin-top:12px">
          <label for="rpw">분석 요청 비밀번호</label>
          <input id="rpw" type="password" autocomplete="current-password" value="${esc(store.get('aa_run_pw'))}">
          <label><input type="checkbox" id="rkeep" style="width:auto" ${store.get('aa_run_pw') ? 'checked' : ''}> 이 기기에서 비밀번호 기억</label>
          <button class="btn" id="rgo" type="button">고른 경기 분석</button>
        </div>
        <div id="rmsg" class="log" style="margin-top:12px" role="status"></div>
      </div>
      <div class="panel"><h2>진행 상황</h2><div id="rstat" class="small">불러오는 중…</div></div>
      <details class="panel"><summary><b>경기 목록 새로 가져오기</b> <span class="small mute">(분석 없음, Claude 비용 없음)</span></summary>
        <p class="small mute">6시·14시를 기다리지 않고 지금 목록을 새로 모읍니다. 고른 리그가 6시·14시 기본 리그로도 저장할 수 있습니다.</p>
        ${groups.map(g => `<fieldset class="lgroup"><legend>${esc(g)}</legend><div class="chips">
          ${L.leagues.filter(l => l.group === g).map(l => `<button type="button" class="chip pickchip" data-id="${l.id}" aria-pressed="${picked.has(l.id)}">${esc(l.name)}</button>`).join('')}
        </div></fieldset>`).join('')}
        <p class="inline"><button class="btn ghost" id="lgDefault" type="button">기본 리그</button><button class="btn ghost" id="lgNone" type="button">모두 해제</button></p>
        <label class="small"><input type="checkbox" id="rdef" style="width:auto"> 이 리그를 6시·14시 기본 리그로 저장</label>
        <p><button class="btn ghost" id="rcollect" type="button">목록 가져오기</button></p>
      </details>
      <div class="panel"><h2>비용과 한도</h2><ul class="small mute why" style="margin-top:6px">
        <li>경기 1개를 분석할 때 Claude 를 8번 부릅니다 (분석가 4명 × 1차 분석·토론). 3명은 Sonnet(경기당 약 0.09달러), 호구형은 Haiku(약 0.005달러)라 경기당 약 0.1달러. 고른 경기 수만큼만 비용이 듭니다.</li>
        <li>경기 목록·자료 API-Football: 오늘 <b class="num">${esc(u.api_football_today ?? '-')}</b> / ${esc(u.api_football_limit ?? 100)}회 (유료 요금제 안, 추가 비용 없음).</li>
        <li>배당 The Odds API: 이번 달 <b class="num">${esc(u.odds_month ?? '-')}</b> / ${esc(u.odds_limit ?? 500)} 크레딧.</li>
        <li class="small">사용량은 마지막 실행 때 기준입니다${last ? ` (${esc(last.at)})` : ''}.</li></ul></div>
    </div></div></div></section>`;
  const byId = Object.fromEntries(open.map(m => [m.id, m]));
  const drawList = () => {
    const ms = open.filter(m => lgF === 'all' || lgName(m) === lgF);
    const days = [...new Set(ms.map(m => dayOf(m.kickoff)))];
    document.getElementById('pkList').innerHTML = ms.length ? days.map(d => `<h3 class="day">${esc(dayLabel(d))}</h3>${ms.filter(m => dayOf(m.kickoff) === d).map(m => {
      const o = m.odds || {};
      return `<label class="pk-row${chosen.has(m.id) ? ' on' : ''}"><input type="checkbox" data-pk="${esc(m.id)}" ${chosen.has(m.id) ? 'checked' : ''}>
        <span class="time">${esc(timeOf(m.kickoff))}</span>
        <span class="teams">${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)}<br><span class="lg">${esc(lgName(m))}</span></span>
        <span class="small mute num">${o.home ? `${esc(o.home)} / ${esc(o.draw)} / ${esc(o.away)}` : '배당 없음'}</span></label>`;
    }).join('')}`).join('') : '<p class="empty">분석을 기다리는 경기가 없습니다. 오른쪽 아래 "경기 목록 새로 가져오기"를 써 보세요.</p>';
    view.querySelectorAll('[data-pk]').forEach(c => c.onchange = () => { c.checked ? chosen.add(c.dataset.pk) : chosen.delete(c.dataset.pk); c.closest('.pk-row').classList.toggle('on', c.checked); drawChosen(); });
  };
  const drawChosen = () => {
    store.set('aa_pick_ids', [...chosen].join(','));
    document.getElementById('pkCount').textContent = chosen.size;
    const list = [...chosen].map(id => byId[id]).filter(Boolean).sort((x, y) => (x.kickoff > y.kickoff ? 1 : -1));
    document.getElementById('pkChosen').innerHTML = list.length ? list.map(m => `<li>${esc(m.kickoff.slice(5, 16))} ${esc(m.home)} vs ${esc(m.away)}</li>`).join('') : '<li class="mute">왼쪽에서 경기를 체크하세요.</li>';
  };
  view.querySelectorAll('[data-plg]').forEach(b => b.onclick = () => {
    lgF = b.dataset.plg; store.set('aa_pick_lg', lgF);
    view.querySelectorAll('[data-plg]').forEach(x => x.setAttribute('aria-pressed', x.dataset.plg === lgF));
    drawList();
  });
  document.getElementById('pkNone').onclick = () => { chosen = new Set(); drawList(); drawChosen(); };
  drawList(); drawChosen();
  const syncLg = () => {
    view.querySelectorAll('.pickchip').forEach(b => b.setAttribute('aria-pressed', picked.has(+b.dataset.id)));
    store.set('aa_run_leagues', [...picked].join(','));
  };
  view.querySelectorAll('.pickchip').forEach(b => b.onclick = () => { const id = +b.dataset.id; picked.has(id) ? picked.delete(id) : picked.add(id); syncLg(); });
  document.getElementById('lgDefault').onclick = () => { picked = new Set(L.defaults); syncLg(); };
  document.getElementById('lgNone').onclick = () => { picked = new Set(); syncLg(); };
  const msg = t => { document.getElementById('rmsg').textContent = t; };
  const send = async (btn, payload, okText) => {
    const pw = document.getElementById('rpw').value;
    if (!pw) { msg('비밀번호를 넣으세요.'); return; }
    store.set('aa_run_pw', document.getElementById('rkeep').checked ? pw : '');
    btn.disabled = true; msg('요청 보내는 중…');
    try {
      const r = await fetch('/api/run', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pw, ...payload})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('요청 실패 ' + r.status));
      msg(okText(j));
      setTimeout(status, 4000);
    } catch (err) { msg(err.message); }
    btn.disabled = false;
  };
  document.getElementById('rgo').onclick = e => {
    if (!chosen.size) { msg('분석할 경기를 하나 이상 체크하세요.'); return; }
    if (chosen.size > 40) { msg('한 번에 40경기까지 고를 수 있습니다.'); return; }
    const n = chosen.size;
    send(e.target, {ids: [...chosen]}, () => { const t = `${n}경기 분석을 시작했습니다. 끝나면 경기 목록에 올라옵니다.`; chosen = new Set(); drawList(); drawChosen(); return t; });
  };
  document.getElementById('rcollect').onclick = e => {
    if (!picked.size) { msg('리그를 하나 이상 고르세요.'); return; }
    send(e.target, {leagues: [...picked], save_default: document.getElementById('rdef').checked},
      j => `리그 ${picked.size}개 경기 목록을 모으는 중입니다 (분석 없음)${j.saved_default ? ' · 기본 리그로 저장함' : ''}.`);
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
      el.innerHTML = `<table><tbody>${j.runs.map(x => `<tr><td class="num">#${esc(x.number)}</td><td>${x.event === 'schedule' ? '자동 (6시·14시)' : '요청'}</td><td>${esc(when(x.created_at))}</td><td class="r">${label(x)}</td></tr>`).join('')}</tbody></table>
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
    log('분석 중… 분석가들이 따로 분석한 뒤 토론합니다 (1~2분).');
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
    else if (h === 'news') await renderNews();
    else if (h === 'admin') await renderAdmin();
    else if (h === 'run' && STATIC) await renderRun();
    else await renderList();
    fitVerdicts();
  } catch (e) {
    view.innerHTML = `<section class="band"><div class="wrap"><h1>불러오지 못했습니다</h1><p class="lead">${esc(e.message)}</p><p><a href="#">경기 목록으로</a></p></div></section>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
}
window.addEventListener('hashchange', () => { if (typeof pickBar === 'function') pickBar(); });
/* ---------- 운세 배너 (오른쪽에 따라다님, 모든 탭) ----------
   운세 사이트 주소가 정해지면 FORTUNE_URL 에 넣는다. 비어 있으면 눌렀을 때 '준비 중'만 보여 준다. */
const FORTUNE_URL = 'https://raise-lucky.com/';
(function fortuneAd() {
  if (document.querySelector('.fad')) return;
  const a = document.createElement('a');
  a.className = 'fad';
  a.setAttribute('aria-label', '연도별 띠 운세 보러 가기');
  a.innerHTML = '<span class="fh" aria-hidden="true">福</span><span class="ft">연도별 띠 운세</span><span class="fc">열어 보기</span>';
  if (FORTUNE_URL) { a.href = FORTUNE_URL; a.target = '_blank'; a.rel = 'noopener'; }
  else {
    a.href = '#';
    a.onclick = e => { e.preventDefault(); const c = a.querySelector('.fc'); c.textContent = '준비 중'; setTimeout(() => { c.textContent = '열어 보기'; }, 1500); };
  }
  document.body.appendChild(a);
})();
/* ---------- 로또 배너 (운세 배너 바로 아래, 모든 탭) ----------
   로또 페이지 주소. raise-lotto.com 연결이 끝나면 그 주소로 바꾼다. 비어 있으면 눌렀을 때 '준비 중'만 보여 준다. */
const LOTTO_URL = 'https://raise-lotto.com/';
(function lottoAd() {
  if (document.querySelector('.fad.lad')) return;
  const BC = n => n <= 10 ? '#f2b705' : n <= 20 ? '#4fb3e8' : n <= 30 ? '#f25c5c' : n <= 40 ? '#9a9a9a' : '#8cc43c';
  const a = document.createElement('a');
  a.className = 'fad lad';
  a.setAttribute('aria-label', '띠별 행운 번호 보러 가기');
  a.innerHTML = '<span class="fh" aria-hidden="true">福</span><span class="lb" aria-hidden="true">'
    + [6, 14, 28].map(n => `<span style="background:${BC(n)}">${n}</span>`).join('')
    + '</span><span class="ft">띠별 행운 번호</span><span class="fs">재미용 · 하루 동안 고정</span><span class="fc">열어 보기</span>';
  if (LOTTO_URL) { a.href = LOTTO_URL; a.target = '_blank'; a.rel = 'noopener'; }
  else {
    a.href = '#';
    a.onclick = e => { e.preventDefault(); const c = a.querySelector('.fc'); c.textContent = '준비 중'; setTimeout(() => { c.textContent = '열어 보기'; }, 1500); };
  }
  document.body.appendChild(a);
})();
/* ---------- 모바일 배너 (1100px 미만 화면: 머리말 아래 한 줄씩 두 개) ----------
   큰 화면의 옆 배너(.fad)와 같은 주소·같은 색. 보이는 조건은 style.css 의 .mad 에서 정한다. */
(function mobileAds() {
  if (document.querySelector('.mad')) return;
  const view = document.getElementById('view');
  if (!view) return;
  const BC = n => n <= 10 ? '#f2b705' : n <= 20 ? '#4fb3e8' : n <= 30 ? '#f25c5c' : n <= 40 ? '#9a9a9a' : '#8cc43c';
  const box = document.createElement('div');
  box.className = 'mad';
  const item = (cls, url, label, lead, title, sub) => {
    const a = document.createElement('a');
    a.className = 'mad-i ' + cls;
    a.setAttribute('aria-label', label);
    a.innerHTML = lead + `<span class="mad-t"><b>${title}</b><small>${sub}</small></span><span class="mad-go" aria-hidden="true">›</span>`;
    if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener'; } else { a.href = '#'; a.onclick = e => e.preventDefault(); }
    return a;
  };
  box.appendChild(item('mad-f', FORTUNE_URL, '연도별 띠 운세 보러 가기',
    '<span class="mad-h" aria-hidden="true">福</span>', '연도별 띠 운세', '태어난 해로 오늘 운세 확인'));
  box.appendChild(item('mad-l', LOTTO_URL, '띠별 행운 번호 보러 가기',
    '<span class="mad-b" aria-hidden="true">' + [6, 14, 28].map(n => `<span style="background:${BC(n)}">${n}</span>`).join('') + '</span>',
    '띠별 행운 번호', '재미용 · 하루 동안 고정'));
  view.parentNode.insertBefore(box, view);
})();
