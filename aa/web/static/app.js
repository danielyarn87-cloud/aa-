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
/* 이득(숨은 기회) 조건: 기대값 5%~40% 이고 배당 3.5 이하 (company.yaml policy 와 같게, 11/27 성적 분석) */
const MAX_EDGE = 0.40, MAX_ODDS = 3.5;
const isGood = (e, o) => e != null && e >= TH && e <= MAX_EDGE && o != null && +o <= MAX_ODDS;

/* 회원 주소에서는 분석 글의 배당 표현을 '시장 예상'으로 바꿔 보여 준다 (저장된 글은 그대로, 화면에서만) */
const SOFTEN = /(^|\.)raise-fulltime\.com$/.test(location.hostname);
const soften = t => t.replace(/배당이 후한지 비싼지/g, '시장 예상이 높은지 낮은지').replace(/시장 배당/g, '시장 예상').replace(/배당 흐름/g, '시장 예상 흐름')
  .replace(/배당/g, '시장 예상').replace(/정배/g, '인기 팀').replace(/[배베]팅/g, '선택').replace(/시장 예상 시장/g, '시장');
const escRaw = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));   // 공지·문의처럼 사람이 쓴 글은 그대로
const textHtml = v => escRaw(v).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
const esc = v => (SOFTEN ? soften(String(v ?? '')) : String(v ?? '')).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = (x, d = 0) => x == null ? '-' : (x * 100).toFixed(d) + '%';
/* 기대값을 5,000원당 평균 손익으로: 0.097 → +485원 */
const OX = h => h === true ? '<span class="ox o">○</span>' : h === false ? '<span class="ox x">✕</span>' : '';
const rate = (h, n) => n ? `${h}/${n} <b>${(h / n * 100).toFixed(1)}%</b>` : '-';
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
      : path === '/api/picks' ? 'api/picks.json' : path === '/api/credit' ? 'api/credit.json' : path === '/api/news' ? 'api/news.json' : null;
    if (!file) throw new Error('이 사이트에서는 쓸 수 없는 기능입니다.');
    const r = await fetch('/' + file, {cache: 'no-cache'});   // 절대 주소: /match/… 에서도 같은 파일
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
    return ms.length ? '관련 경기: ' + ms.slice(0, 2).map(m => `<a href="${matchHref(m.id, m.slug)}">${esc(m.kickoff.slice(5, 16).replace('-', '/'))} ${esc(m.home)} vs ${esc(m.away)} →</a>`).join(' · ') : '';
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

/* 관리자 화면: 이 기기에 분석 요청 비밀번호를 기억시켰거나 한 번이라도 요청에 성공했으면 관리자로 본다.
   회원(그 밖의 방문자)에게는 누적 적중률·크레딧·API 사용량 칸을 숨기고 리그 고르기부터 보여 준다 (화면만 숨김). */
/* 운영자: 운영자 주소(raise-bet.com·pages.dev — Cloudflare Access 로 잠김)면 항상, 그 밖엔 이 브라우저에 관리자 표시가 있을 때 */
const isBoss = () => !MEMBER || !!store.get('aa_run_pw') || store.get('aa_boss') === '1';
/* 회원 모드: 회원용 주소(raise-fulltime.com)로 들어오면 돈·배당 숫자·배팅 표현을 빼고 관리 메뉴를 숨긴다.
   운영자 주소(raise-bet.com, aa-2kp.pages.dev)는 지금 그대로. */
const MEMBER = /(^|\.)raise-fulltime\.com$/.test(location.hostname);
const GAIN = MEMBER ? '숨은 기회' : '이득';
/* 회원 상태: /api/me 로 받는다. 관심 경기(☆)는 회원 계정에 저장 */
const OPERATOR = !MEMBER && /(^|\.)raise-bet\.com$|(^|\.)aa-2kp\.pages\.dev$/.test(location.hostname);
let ME = {user: null, admin: false, ready: {}};
let FAVS = new Set();
let favOnly = false;
const STAR_T = MEMBER ? '★ 예측+기회' : '★ 예측+이득';
/* 시장 예상: 배당을 가능성으로 바꾸고(1÷배당) 북메이커 몫을 빼서 합이 100%가 되게 맞춘다 */
const mkt = (o, keys) => { const s = keys.reduce((a, k) => a + (o[k] ? 1 / o[k] : 0), 0); return Object.fromEntries(keys.map(k => [k, o[k] && s ? 1 / o[k] / s : null])); };
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
  /* 분석 안 한 경기는 시작하면 보류: 목록에서 뺀다 (실시간 점수도 붙이지 않음) */
  const ms = inLg.filter(m => !m.result && (m.status === 'analyzed' || !(kickMs(m) <= Date.now())));
  const done = ms.filter(m => m.status === 'analyzed');
  const vals = done.filter(m => m.value_alerts && m.value_alerts.length).length;
  const isRes = listFilter === 'results';
  /* 끝난 경기는 최종 점수와 함께 끝나고 약 1시간 동안만 목록에 남긴다 (킥오프 기준 3시간 = 경기 약 2시간 + 1시간) */
  const recent = MEMBER ? [] : inLg.filter(m => m.result && m.status === 'analyzed' && Date.now() - kickMs(m) < 3 * 3600e3);
  const shown = isRes ? [] : [...ms, ...recent].sort((a, b) => kickMs(a) - kickMs(b)).filter(m => !favOnly || FAVS.has(m.id)).filter(m => listFilter === 'all' || (listFilter === 'analyzed' ? m.status === 'analyzed' : listFilter === 'pending' ? m.status === 'pending' : (m.value_alerts || []).length));
  const days = [...new Set(shown.map(m => dayOf(m.kickoff)))];
  const chip = (k, t, cls = '') => `<button class="seg ${cls}" data-f="${k}" aria-pressed="${listFilter === k}">${t}</button>`;
  parkAd();
  view.innerHTML = `<section class="band"><div class="wrap">
    ${isBoss() ? `<div class="listhead"><div><h1>누적 적중률 · 전체</h1></div>
      <div class="segbar" role="group" aria-label="경기 거르기">${chip('all', '전체')}${chip('analyzed', '분석 완료')}${chip('value', '이득 신호')}${chip('pending', '분석 대기')}${chip('results', `경기 결과 <span class="num">${finished.length}</span>`, 'res')}</div></div>
    ${kpiCards(all, ms.length - done.length, done.length, vals, credit, lgInfo)}` : ''}
    ${Object.keys(lgCount).length > 1 ? `<button type="button" class="lgtoggle" id="lgtoggle" aria-expanded="${lgOpen}"><span><b>리그</b> · ${leagueFilter === 'all' ? `모든 리그 (${all.length})` : `${esc(leagueFilter)} (${lgCount[leagueFilter]})`}</span><span>${lgOpen ? '접기 ▴' : '펼치기 ▾'}</span></button>
    <div class="chips lgchips" role="group" aria-label="리그 거르기" ${lgOpen ? '' : 'hidden'}>
      <button class="chip" data-lg="all" aria-pressed="${leagueFilter === 'all'}">모든 리그 <span class="num">${all.length}</span></button>
      ${Object.entries(lgCount).sort((a, b) => b[1] - a[1]).map(([n, c]) => `<button class="chip" data-lg="${esc(n)}" aria-pressed="${leagueFilter === n}">${esc(n)} <span class="num">${c}</span></button>`).join('')}</div>` : ''}
    ${MEMBER ? favBarHtml() : ''}
    ${riskLine()}${legendHtml()}
    ${isRes ? '' : '<div id="ytStrip" class="ytstrip" hidden></div>'}
    ${isRes ? `<div class="ressearch">
        <input type="search" id="rq" placeholder="팀 이름·리그로 검색 (예: 대전, 챔피언스리그)" value="${esc(resQuery)}">
        <input type="date" id="rd" value="${esc(resDate)}" title="날짜">
        <select id="rh"><option value="all">적중 여부 전체</option><option value="hit">승무패 맞힌 경기</option><option value="miss">승무패 틀린 경기</option></select>
        <button type="button" class="btn ghost sm" id="rclear">초기화</button></div><div id="reslist"></div>`
      : shown.length ? days.map(d => `<h2 class="day">${esc(dayLabel(d))}</h2>${shown.filter(m => dayOf(m.kickoff) === d).map(rowHtml).join('')}`).join('')
      : favOnly ? `<p class="empty">아직 관심 경기가 없어요. 경기 시간 앞 <b style="color:#dc2626">☆</b>을 누르면 여기에 모여요.</p>`
      : `<p class="empty">조건에 맞는 경기가 없습니다.${STATIC ? ' <a href="#run">분석 요청</a>에서 리그를 골라 경기를 가져오세요.' : ''}</p>`}
  </div></section>`;
  { const rs = view.querySelectorAll('.row'); placeAd(rs[5] || rs[rs.length - 1]); }
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
  noticeBar();   // 목록을 다시 그려도 공지 띠 유지
  if (STATIC && !isRes) mountShortsList(shown);
  view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { listFilter = b.dataset.f; renderList(); });
  view.querySelectorAll('[data-lg]').forEach(b => b.onclick = () => { leagueFilter = b.dataset.lg; store.set('aa_league', leagueFilter); renderList(); });
  const lt = document.getElementById('lgtoggle');
  if (lt) lt.onclick = () => { lgOpen = !lgOpen; store.set('aa_lg_open', lgOpen ? '1' : ''); renderList(); };
  const fo = document.getElementById('favonly');
  if (fo) fo.onclick = () => { if (!ME.user) return openLogin('관심 경기는 회원 전용 기능이에요'); favOnly = !favOnly; renderList(); };
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
  wireKpi();
}

/* ---------- 누적 적중률 카드 → 자세히 보기 (운영자 화면) ---------- */
let KPI_DONE = [], kpiOpen = null, kpiAll = false;
const PK = {home: '홈 승', draw: '무', away: '원정 승', over: '오버', under: '언더'};
const goalsOf = m => { const g = String((m.result || {}).score || '').match(/(\d+)\s*[-:]\s*(\d+)/); return g ? [+g[1], +g[2]] : null; };
const wonTxt = v => (v >= 0 ? '+' : '−') + Math.abs(Math.round(v)).toLocaleString('ko-KR') + '원';
/* 이득 장(5,000원씩) 목록: 경기 결과로 맞았는지·손익 */
function valueTickets(arr) {
  const V = [];
  arr.forEach(m => { const g = goalsOf(m); if (!g) return; const line = parseFloat(m.line) || 2.5;
    (m.value_alerts || []).forEach(k => { const w = {home: g[0] > g[1], draw: g[0] === g[1], away: g[0] < g[1], over: g[0] + g[1] > line, under: g[0] + g[1] < line}[k];
      if (w === undefined) return; const o = parseFloat((m.odds || {})[k]) || 0; V.push({m, k, o, w, pl: w ? (o - 1) * UNIT : -UNIT}); }); });
  return V;
}
/* 매일 아침 9시 기준 추이: 9시까지 끝난 경기(킥오프 2시간 뒤)만 센다. 선 = 누적, 막대 = 그날(전날 9시~그날 9시) */
const NINE = 9 * 3600e3, DAYMS = 864e5, KST = 9 * 3600e3;
function nineSeries(kind) {
  const end = m => kickMs(m) + 2 * 3600e3;
  const ms = KPI_DONE.filter(m => isFinite(end(m)));
  if (!ms.length) return [];
  const at9 = t => Math.floor((t + KST - NINE) / DAYMS) * DAYMS - KST + NINE;   // t 직전(같거나 이전) 아침 9시
  const last = at9(Date.now());
  let c = at9(Math.min(...ms.map(end))) + DAYMS;
  const out = [];
  for (; c <= last; c += DAYMS) {
    const upto = ms.filter(m => end(m) <= c), day = upto.filter(m => end(m) > c - DAYMS);
    const lab = new Date(c + KST).toISOString().slice(5, 10).replace('-', '/');
    if (kind === 'value') {
      const a = valueTickets(upto), b = valueTickets(day), sum = v => Math.round(v.reduce((x, y) => x + y.pl, 0));
      out.push({lab, cum: sum(a), day: sum(b), ch: [a.filter(v => v.w).length, a.length], dh: [b.filter(v => v.w).length, b.length]});
    } else {
      const key = kind === 'ou' ? 'hit_ou' : 'hit_1x2', f = arr => { const x = arr.filter(m => m.result[key] != null); return [x.filter(m => m.result[key]).length, x.length]; };
      out.push({lab, ch: f(upto), dh: f(day)});
    }
  }
  return out.slice(-14);   // 최근 2주
}
function nineChart(kind) {
  const S = nineSeries(kind);
  if (!S.length) return '<p class="kd-note">아침 9시 기록이 아직 없어요. 내일 아침 9시에 첫 점이 생겨요.</p>';
  const narrow = innerWidth < 600;   // 폰: 글자가 작아지지 않게 좁은 그림판
  const W = narrow ? 330 : 600, H = narrow ? 200 : 190, L = narrow ? 44 : 56, R = 8, T = 18, B = 26, cw = (W - L - R) / S.length;
  const isV = kind === 'value', pc = a => a[1] ? a[0] / a[1] * 100 : null;
  const cum = S.map(r => isV ? r.cum : pc(r.ch)), day = S.map(r => isV ? r.day : pc(r.dh));
  let lo, hi, ticks;
  if (isV) {   // 보기 좋은 돈 단위 눈금 3줄
    const m = Math.max(1, ...cum.map(Math.abs), ...day.map(Math.abs)), step = [10000, 20000, 50000, 100000, 200000, 500000, 1000000].find(x => x * 1.05 >= m) || 1000000;
    const neg = Math.min(0, ...cum, ...day) < 0, pos = Math.max(0, ...cum, ...day) > 0;
    lo = neg ? -step : 0; hi = pos ? step : 0; if (!neg && !pos) hi = step;
    ticks = [...new Set([lo, 0, hi])];
    if (ticks.length < 3) ticks = lo < 0 ? [lo, lo / 2, 0] : [0, hi / 2, hi];
    lo = ticks[0]; hi = ticks[ticks.length - 1];
  } else {     // 적중률: 30~80% (벗어나면 넓힘)
    const v = [...cum, ...day].filter(x => x != null);
    lo = Math.min(30, Math.floor(Math.min(...v) / 10) * 10); hi = Math.max(80, Math.ceil(Math.max(...v) / 10) * 10);
    ticks = [lo, Math.round((lo + hi) / 2), hi];
  }
  const y = v => T + (H - T - B) * (1 - (v - lo) / ((hi - lo) || 1));
  const lab = v => isV ? (v === 0 ? '0' : (v > 0 ? '+' : '−') + (Math.abs(v) / 10000) + '만') : v + '%';
  const color = {'1x2': '#0F6E56', ou: '#534AB7', value: '#A32D2D'}[kind];
  const base = isV ? 0 : lo;
  let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 && isV ? 'z0' : 'gl'}"/><text x="${L - 8}" y="${y(t) + 4}" class="ax" text-anchor="end">${lab(t)}</text>`).join('');
  S.forEach((r, i) => {
    const x = L + cw * i + cw * .3, w = Math.max(4, cw * .4), v = day[i];
    if (v != null) { const top = Math.min(y(v), y(base)), h = Math.abs(y(v) - y(base)); g += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${isV ? (v >= 0 ? '#1D9E75' : '#E24B4A') : color}" opacity=".28"/>`; }
    if (S.length <= 8 || i % 2 === S.length % 2 || i === S.length - 1) g += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" class="ax" text-anchor="middle">${r.lab}</text>`;
  });
  const pts = cum.map((v, i) => v == null ? null : [L + cw * i + cw * .5, y(v)]).filter(Boolean);
  g += `<polyline points="${pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
  pts.forEach((p, i) => { g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${color}"/>`; if (i === pts.length - 1 || S.length <= 7) g += `<text x="${p[0].toFixed(1)}" y="${(p[1] - 9).toFixed(1)}" class="pv" text-anchor="middle">${isV ? lab(Math.round(cum[i] / 1000) * 1000).replace(/(\.\d)\d+/, '$1') : Math.round(cum[i]) + '%'}</text>`; });
  /* 칸이 좁으면 "12/55" 와 "−126,700원"(또는 "61%")이 두 줄로 나뉘되, 각각은 한 줄 */
  const fmt = (a, extra) => `<span>${a[0]}/${a[1]}</span> ${extra != null ? `<b class="${extra >= 0 ? 'kd-ok' : 'kd-no'}">${wonTxt(extra)}</b>` : `<b>${a[1] ? Math.round(a[0] / a[1] * 100) + '%' : '-'}</b>`}`;
  const table = `<table class="kd-tt"><thead><tr><th>날짜 (아침 9시)</th><th>누적 <small>처음부터</small></th><th>하루 <small>전날 9시부터</small></th></tr></thead><tbody>${[...S].reverse().slice(0, 7).map(r => `<tr><td>${r.lab}</td><td class="num">${fmt(r.ch, isV ? r.cum : null)}</td><td class="num">${fmt(r.dh, isV ? r.day : null)}</td></tr>`).join('')}</tbody></table>`;
  return `<div class="kd-trend"><p class="kd-note">매일 아침 9시 갱신 · 선은 처음부터 누적${isV ? ' 손익' : ' 적중률'}, 막대는 하루(전날 9시~그날 9시)${isV ? ' 손익 (5,000원씩)' : ' 적중률'}</p>
    <svg class="kd-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="아침 9시 기준 추이">${g}</svg>${table}</div>`;
}
function kpiDetail() {
  if (!kpiOpen) return '';
  const byNew = [...KPI_DONE].sort((a, b) => kickMs(b) - kickMs(a));
  const pct = (h, n) => n ? (h / n * 100).toFixed(1) + '%' : '-';
  const group = (arr, key, hit) => { const g = {}; arr.forEach(x => { const k = key(x); (g[k] = g[k] || [0, 0])[1]++; if (hit(x)) g[k][0]++; }); return Object.entries(g).sort((a, b) => b[1][1] - a[1][1]); };
  const bars = (rows, lab = k => k) => `<div class="kd-bars">${rows.map(([k, [h, n]]) => `<div class="kd-bar"><span class="kd-k">${esc(lab(k))}</span><span class="kd-t"><i style="width:${n ? h / n * 100 : 0}%"></i></span><span class="kd-v num">${h}/${n} · ${pct(h, n)}</span></div>`).join('')}</div>`;
  const N = 8;
  const rows = (items, f) => `<div class="kd-rows">${(kpiAll ? items : items.slice(0, N)).map(f).join('')}</div>${items.length > N ? `<button type="button" class="btn ghost sm kd-more">${kpiAll ? '접기' : `전부 보기 (${items.length})`}</button>` : ''}`;
  const head = m => `<a class="kd-m" href="${matchHref(m.id, m.slug)}"><b>${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)}</b><small>${esc(m.kickoff.slice(5, 16).replace('-', '/'))} · ${esc(lgName(m))}`;
  const ok = b => `<span class="${b ? 'kd-ok' : 'kd-no'}">${b ? '✓' : '✗'}</span>`;
  let body = '';
  if (kpiOpen === '1x2') {
    const p = byNew.filter(m => m.result.hit_1x2 != null);
    body = `${nineChart('1x2')}<h3>리그별</h3>${bars(group(p, lgName, m => m.result.hit_1x2))}
      <h3>예측별</h3>${bars(group(p, m => m.pick_1x2 || '-', m => m.result.hit_1x2), k => PK[k] || k)}
      <h3>경기 (최근 순)</h3>${rows(p, m => `<div class="kd-row">${head(m)} · 예측 ${esc(PK[m.pick_1x2] || '-')}</small></a><span class="kd-r num">${esc(m.result.score)} ${ok(m.result.hit_1x2)}</span></div>`)}`;
  } else if (kpiOpen === 'ou') {
    const p = byNew.filter(m => m.result.hit_ou != null);
    body = `${nineChart('ou')}<h3>예측별</h3>${bars(group(p, m => m.pick_ou || '-', m => m.result.hit_ou), k => PK[k] || k)}
      <h3>경기 (최근 순)</h3>${rows(p, m => { const g = goalsOf(m); return `<div class="kd-row">${head(m)} · ${esc(PK[m.pick_ou] || '-')} ${esc(m.line ?? 2.5)} · 실제 ${g ? g[0] + g[1] : '-'}골</small></a><span class="kd-r">${ok(m.result.hit_ou)}</span></div>`; })}`;
  } else if (kpiOpen === 'value') {
    const V = valueTickets(byNew), chart = nineChart('value');
    const byK = group(V, v => v.k, v => v.w).map(([k, hn]) => [k, hn, V.filter(v => v.k === k).reduce((a, v) => a + v.pl, 0)]);
    body = `${chart}<h3>종류별</h3><div class="kd-bars">${byK.map(([k, [h, n], pl]) => `<div class="kd-bar"><span class="kd-k">${esc(PK[k] || k)}</span><span class="kd-t"><i style="width:${n ? h / n * 100 : 0}%"></i></span><span class="kd-v num">${h}/${n} · <b class="${pl >= 0 ? 'kd-ok' : 'kd-no'}">${wonTxt(pl)}</b></span></div>`).join('')}</div>
      <h3>한 장씩 (최근 순)</h3>${rows(V, v => `<div class="kd-row">${head(v.m)} · ${esc(PK[v.k])} @ ${esc(v.o)} · 결과 ${esc(v.m.result.score)}</small></a><span class="kd-r num ${v.w ? 'kd-ok' : 'kd-no'}">${wonTxt(v.pl)}</span></div>`)}`;
  } else {
    body = `<h3>리그별 경기 수 · 승무패 적중</h3>${bars(group(byNew, lgName, m => m.result.hit_1x2))}
      <h3>경기 (최근 순 · 누르면 분석 페이지)</h3>${rows(byNew, m => `<div class="kd-row">${head(m)} · ${esc(m.result.score)}</small></a><span class="kd-r">승무패 ${ok(m.result.hit_1x2)} · U/O ${ok(m.result.hit_ou)}</span></div>`)}`;
  }
  return `<section class="kd" aria-label="자세한 기록">${body}</section>`;
}
function wireKpi() {
  const box = document.getElementById('kpiDetail'); if (!box) return;
  view.querySelectorAll('.kpi-btn').forEach(b => b.onclick = () => {
    kpiOpen = kpiOpen === b.dataset.kd ? null : b.dataset.kd; kpiAll = false;
    view.querySelectorAll('.kpi-btn').forEach(x => { const on = x.dataset.kd === kpiOpen; x.setAttribute('aria-expanded', on); x.querySelector('.kl i').textContent = on ? '▴' : '▾'; });
    box.innerHTML = kpiDetail();
  });
  box.onclick = e => { if (e.target.closest('.kd-more')) { kpiAll = !kpiAll; box.innerHTML = kpiDetail(); } };
}

function kpiCards(all, waiting, analyzed, vals, credit, lgInfo) {
  const done = all.filter(m => m.result);
  const p1 = done.filter(m => m.result.hit_1x2 != null), po = done.filter(m => m.result.hit_ou != null);
  const h1 = p1.filter(m => m.result.hit_1x2).length, ho = po.filter(m => m.result.hit_ou).length;
  const pc = (h, n) => n ? `${(h / n * 100).toFixed(1)}%` : '-';   /* 적중률은 소수점 첫째 자리까지 */
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
  KPI_DONE = done;   // 카드를 눌렀을 때 자세히 보기용
  const card = (cls, label, num, sub) => {
    const k = {k1: '1x2', k5: 'value', k2: 'ou', k3: 'all'}[cls];   // 누르면 아래에 자세한 기록
    return k ? `<button type="button" class="kpi ${cls} kpi-btn" data-kd="${k}" aria-expanded="${kpiOpen === k}"><span class="kl">${label}<i aria-hidden="true">${kpiOpen === k ? '▴' : '▾'}</i></span><span class="kn">${num}</span><span class="ks">${sub}</span></button>`
      : `<div class="kpi ${cls}"><span class="kl">${label}</span><span class="kn">${num}</span><span class="ks">${sub}</span></div>`;
  };
  return `<div class="kpis">
    ${card('k1', '승무패 적중', pc(h1, p1.length), p1.length ? `${h1} / ${p1.length}경기` : '결과 대기')}
    ${card('k5', '이득 적중', pc(vh, vn), vn ? `${vh} / ${vn}개 · 5,000원씩 <b class="${vpl >= 0 ? 'plus' : ''}">${(vpl >= 0 ? '+' : '−') + Math.abs(Math.round(vpl)).toLocaleString('ko-KR')}원</b>` : '결과 대기')}
    ${card('k2', '언더/오버 적중', pc(ho, po.length), po.length ? `${ho} / ${po.length}경기` : '결과 대기')}
    ${card('k3', '채점한 경기', done.length, '누적')}
    ${card('k4', '분석 대기', waiting, `분석 완료 ${analyzed} · 이득 ${vals}`)}
    ${creditCard(credit)}
    ${apiCard(lgInfo)}
    <div id="kpiDetail">${kpiDetail()}</div>
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
  if (MEMBER || !STATIC || !n || location.hash === '#run') { if (bar) bar.remove(); return; }
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
  if (!o || !o.home) return `<span class="oddsline mute">${MEMBER ? '시장 예상 없음' : '배당 없음'}</span>`;
  if (MEMBER) { const q = mkt(o, ['home', 'draw', 'away']); return `<span class="oddsline">시장 예상 · 승 <b class="num">${pct(q.home)}</b> · 무 <b class="num">${pct(q.draw)}</b> · 패 <b class="num">${pct(q.away)}</b></span>`; }
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
  /* 폰에서도 칸이 무너지지 않는 작은 표: 시점(시각은 아랫줄) | 승 | 무 | 패 | 언더 | 오버.
     회원 화면은 배당 숫자 대신 '시장 예상' %(승·무·패, 오버)로 */
  const line = rows[0].o.line ?? 2.5;
  const shortT = v => { const x = String(v || '').replace(/<[^>]+>/g, ''), a = x.match(/\d{4}-(\d{2})-(\d{2})\D+(\d{1,2}:\d{2})/), b = x.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{1,2}:\d{2})/);
    const m = a || b; return m ? `${+m[1]}/${+m[2]} ${m[3]}` : x; };   // 시각은 모두 '11/26 23:18' 모양으로
  const when = row => `<td class="oc-w"><b>${esc(row.w)}</b><small>${esc(shortT(row.at))}</small></td>`;
  let head, body, note, title;
  if (MEMBER) {
    const P = o => ({...mkt(o, ['home', 'draw', 'away']), ...mkt(o, ['over', 'under'])});
    const ps = rows.map(row => P(row.o));
    const c = (i, k) => { const v = ps[i][k]; if (v == null) return '<td>-</td>';
      const pv = i ? ps[i - 1][k] : null, d = pv != null ? Math.round((v - pv) * 100) : 0;
      return `<td><span class="oc-v">${Math.round(v * 100)}%</span>${i && d ? `<span class="oc-d ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : ''}</td>`; };
    title = '시장 예상 변화';
    head = `<th>시점</th><th>홈 승</th><th>무</th><th>원정 승</th><th>오버 ${esc(line)}</th>`;
    body = rows.map((row, i) => `<tr${row.base ? ' class="obase"' : ''}>${when(row)}${c(i, 'home')}${c(i, 'draw')}${c(i, 'away')}${c(i, 'over')}</tr>`).join('');
    note = '시장이 각 결과를 얼마나 유력하게 보는지예요. ▲ 더 유력하게 봄 · ▼ 덜 유력하게 봄. 1시간마다, 시작 30분 전쯤 마지막으로 다시 받아요.';
  } else {
    const c = (row, i, k) => { const v = row.o[k], pv = i ? rows[i - 1].o[k] : null;
      const d = v != null && pv != null ? +(v - pv).toFixed(2) : 0;
      return `<td><span class="oc-v">${v != null ? esc(v) : '-'}</span>${i && d ? `<span class="oc-d ${d > 0 ? 'dn' : 'up'}">${d > 0 ? '▲' : '▼'}${Math.abs(d).toFixed(2).replace(/^0/, '')}</span>` : ''}</td>`; };
    title = '배당 변화';
    head = `<th>시점</th><th>승</th><th>무</th><th>패</th><th>언더</th><th>오버</th>`;
    body = rows.map((row, i) => `<tr${row.base ? ' class="obase"' : ''}>${when(row)}${c(row, i, 'home')}${c(row, i, 'draw')}${c(row, i, 'away')}${c(row, i, 'under')}${c(row, i, 'over')}</tr>`).join('');
    note = `기준점 ${esc(line)}골 · 여러 북메이커 평균 · ▲ 배당 오름(시장이 덜 유력하게 봄) · ▼ 내림(더 유력하게 봄). 1시간마다, 시작 30분 전쯤 마지막으로 다시 받아요.`;
  }
  return `<div class="sec"><h2>${title} <span class="small mute">바로 위 줄 대비</span></h2><div class="oc-wrap"><table class="oddsc"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><p class="small mute">${note}</p></div>`;
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
/* 한국 선수 팀: 시작 시각 아래 태극기 + 선수 이름 (회원·운영자 목록, 분석 요청 목록) */
const KR_STARS = {'아틀레티코 마드리드': '이강인', '바이에른 뮌헨': '김민재', 'LAFC': '손흥민'};
const KR_TEAM_TAG = {'아틀레티코 마드리드': '아틀레티코', '바이에른 뮌헨': '바이에른뮌헨', 'LAFC': 'LAFC'};
const krOf = m => [m.home, m.away].filter(t => KR_STARS[t]).map(t => ({team: t, name: KR_STARS[t]}));
const TAEGUK = '<svg class="tg" viewBox="0 0 36 24" aria-hidden="true"><rect x=".5" y=".5" width="35" height="23" rx="2" fill="#fff" stroke="#c9c9c9"/><g transform="translate(18 12) rotate(-33.7)"><path d="M-6 0a6 6 0 0 1 12 0a3 3 0 0 1-6 0a3 3 0 0 0-6 0z" fill="#cd2e3a"/><path d="M-6 0a6 6 0 0 0 12 0a3 3 0 0 0-6 0a3 3 0 0 1-6 0z" fill="#0047a0"/></g><g fill="#000"><g transform="translate(6.2 5.2) rotate(56.3)"><rect x="-3" y="-2.4" width="6" height="1.1"/><rect x="-3" y="-.55" width="6" height="1.1"/><rect x="-3" y="1.3" width="6" height="1.1"/></g><g transform="translate(29.8 18.8) rotate(56.3)"><rect x="-3" y="-2.4" width="2.6" height="1.1"/><rect x=".4" y="-2.4" width="2.6" height="1.1"/><rect x="-3" y="-.55" width="2.6" height="1.1"/><rect x=".4" y="-.55" width="2.6" height="1.1"/><rect x="-3" y="1.3" width="2.6" height="1.1"/><rect x=".4" y="1.3" width="2.6" height="1.1"/></g><g transform="translate(29.8 5.2) rotate(-56.3)"><rect x="-3" y="-2.4" width="6" height="1.1"/><rect x="-3" y="-.55" width="2.6" height="1.1"/><rect x=".4" y="-.55" width="2.6" height="1.1"/><rect x="-3" y="1.3" width="6" height="1.1"/></g><g transform="translate(6.2 18.8) rotate(-56.3)"><rect x="-3" y="-2.4" width="2.6" height="1.1"/><rect x=".4" y="-2.4" width="2.6" height="1.1"/><rect x="-3" y="-.55" width="6" height="1.1"/><rect x="-3" y="1.3" width="2.6" height="1.1"/><rect x=".4" y="1.3" width="2.6" height="1.1"/></g></g></svg>';
const krBadge = m => krOf(m).map(k => `<span class="krb" title="${esc(k.team)} · 한국 선수 ${esc(k.name)}">${TAEGUK}<b>${esc(k.name)}</b></span>`).join('');
function rowHtml(m) {
  const N = names(m.home, m.away, m.line);
  const head = `<span class="time">${favStar(m.id)}${esc(timeOf(m.kickoff))}${krBadge(m)}</span><span class="teams">${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)}${newsBadge(m)}${oddsLine(m)}<span class="lg">${esc(m.league)}</span></span>`;
  if (m.status !== 'analyzed') {
    return `<div class="row">${head}<span class="mid"></span><span class="tags">${m.picked && !MEMBER ? '<span class="tag value">분석 요청함</span>' : STATIC && !MEMBER ? `<button type="button" class="pk-toggle" data-pick="${esc(m.id)}" aria-pressed="${pickSet().has(m.id)}">${pickSet().has(m.id) ? '✓ 분석에 담음' : '＋ 분석하기'}</button>` : '<span class="tag wait">분석 대기</span>'}</span></div>`;
  }
  const tags = [];
  const od = m.odds || {};
  const now = oddsNow(m);
  /* 그 선택의 평균 배당(분석할 때). 지금 배당이 달라졌으면 '2.11→1.86▼' 처럼 붙인다 (골 수는 기준점이 같을 때만) */
  const at = k => {
    if (MEMBER || !od[k]) return '';
    const ou = k === 'over' || k === 'under';
    const nv = now && (!ou || +now.line === +m.line) ? now[k] : null;
    const ch = nv != null && Math.abs(nv - od[k]) >= 0.005;
    return ` <b class="num">${esc(od[k])}</b>` + (ch ? `<span class="oc">→<b class="num">${esc(nv)}</b>${arrow(nv, od[k])}</span>` : '');
  };
  const lab = k => esc(k === 'over' || k === 'under' ? N[k + 'S'] + ' ' + m.line : N[k]);
  const va = m.value_alerts || [];
  const both = k => k && va.includes(k);   // 가장 유력하면서 배당도 후한 선택 → 한 번만, 눈에 띄게
  const star = `<span class="star">${STAR_T}</span> `;
  tags.push(`<span class="tag ${both(m.pick_1x2) ? 'pick both' : 'pick'}">${m.pick_1x2 ? (both(m.pick_1x2) ? star : '예측 ') + esc(N[m.pick_1x2]) + at(m.pick_1x2) : '승패 판단 보류'}</span>`);
  tags.push(`<span class="tag ${both(m.pick_ou) ? 'both' : ''}">${m.pick_ou ? (both(m.pick_ou) ? star : '') + lab(m.pick_ou) + at(m.pick_ou) : '골 수 판단 보류'}</span>`);
  const rest = va.filter(k => k !== m.pick_1x2 && k !== m.pick_ou);
  if (rest.length) tags.push(`<span class="tag value">${GAIN} ${rest.map(k => lab(k) + at(k)).join(' · ')}</span>`);
  const chg = pickChange(m);
  if (chg) tags.push(`<span class="tag chg" title="다시 분석하면서 예측이 바뀜">${chg}</span>`);
  if (m.result) {
    tags.push(`<span class="tag ${m.result.hit_1x2 ? 'hit' : m.result.hit_1x2 === false ? 'miss' : ''}">${esc(m.result.score)} 승무패 ${m.result.hit_1x2 ? '적중' : m.result.hit_1x2 === false ? '빗나감' : '보류'}</span>`);
    if (m.result.hit_ou != null) tags.push(`<span class="tag ${m.result.hit_ou ? 'hit' : 'miss'}">언오버 ${m.result.hit_ou ? '적중' : '빗나감'}</span>`);
  }
  if (m.mock) tags.push('<span class="tag wait">모의</span>');
  const hot = both(m.pick_1x2) || both(m.pick_ou);   /* 예측+이득(★) 경기는 줄 전체를 진한 회색으로 */
  const val = !hot && (m.value_alerts || []).length > 0;   /* 이득만 있는 경기는 연분홍 */
  return `<a class="row${hot ? ' hot' : val ? ' val' : ''}" data-mid="${esc(m.id)}" href="${matchHref(m.id, m.slug)}">${head}<span class="mid">${m.result ? finalSlot(m) : liveSlot(m)}${tri(m.probs, m.pick_1x2)}</span><span class="tags">${tags.join('')}</span></a>`;
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
/* 끝난 경기 최종 점수: 서버가 경기 번호로 따로 받아 준다 (/api/live?ended=…). 이 브라우저에도 이틀 기억 */
let FINALS = {};
try { FINALS = JSON.parse(localStorage.getItem('aa_final') || '{}') || {}; } catch (e) { FINALS = {}; }
const waitHtml = id => FINALS[id] ? liveText(FINALS[id], true, true) : WAIT_HTML;
const liveSlot = m => {
  const w = awaitingResult(m), id = esc(m.id);
  if (mayBeLive(m)) return `<span class="lv" data-live="${id}" data-mid="${id}" data-kick="${kickMs(m)}"${w ? '' : ' hidden'}>${w ? waitHtml(m.id) : ''}</span>`;
  return w ? `<span class="lv" data-mid="${id}">${waitHtml(m.id)}</span>` : '';
};
/* 결과가 반영된 경기: 최종 점수 (카드 수는 서버에서 받아 둔 게 있으면 함께) */
const finalSlot = m => {
  const sc = String((m.result || {}).score || '').match(/(\d+)\D+(\d+)/);
  if (!sc) return '';
  return `<span class="lv">${liveText({...(FINALS[m.id] || {}), h: +sc[1], a: +sc[2]}, true)}</span>`;
};
let finalAt = 0, finalTimer = null;
async function finalTick() {
  if (!STATIC) return;
  const need = [...new Set([...document.querySelectorAll('.lv[data-mid]')]
    .filter(e => !e.hidden && e.querySelector('.lv-w, .lv-t.wait') && !FINALS[e.dataset.mid]).map(e => e.dataset.mid))]
    .filter(id => /^AF-\d+$/.test(id)).slice(0, 20);
  if (!need.length || Date.now() - finalAt < 50e3) return;   /* 못 받은 경기가 남아 있으면 1분마다 다시 (받은 점수는 기억) */
  finalAt = Date.now();
  let d = null;
  try { d = await (await fetch('/api/live?ended=' + need.join(','), {cache: 'no-cache'})).json(); } catch (e) { d = null; }
  const got = Object.entries((d && d.final) || {});
  if (got.length) {
    const old = Date.now() - 2 * 86400e3;
    for (const [id, x] of got) FINALS[id] = {...x, t: Date.now()};
    for (const id of Object.keys(FINALS)) if (!(FINALS[id].t > old)) delete FINALS[id];
    try { localStorage.setItem('aa_final', JSON.stringify(FINALS)); } catch (e) {}
    document.querySelectorAll('.lv[data-mid]').forEach(e => {
      if (FINALS[e.dataset.mid] && e.querySelector('.lv-w, .lv-t.wait')) { e.className = 'lv'; e.innerHTML = waitHtml(e.dataset.mid); e.hidden = false; }
    });
  }
  clearTimeout(finalTimer);
  finalTimer = setTimeout(finalTick, 61e3);
}
const liveSeen = {};   /* 진행 중으로 본 적 있는 경기의 마지막 값: 목록에서 빠지면 '종료'로 보여 준다 */
let liveTimer = null;
let liveAt = 0;   /* 화면에 보여 준 실시간 점수의 받은 시각 */
const LIVE_ON = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'];
function liveText(x, ended, wait) {
  /* 시간 알약은 막대 왼쪽 옆, 점수는 막대 위 가운데: 홈 카드 · 홈 점수(빨강) · 원정 점수(파랑) · 원정 카드 */
  const cd = (y, r, side) => `<span class="lv-cd ${side}">${y ? `<span title="옐로카드"><i class="y"></i>${esc(y)}</span>` : ''}${r ? `<span title="레드카드"><i class="r"></i>${esc(r)}</span>` : ''}</span>`;
  const sc = `<span class="lv-sc">${cd(x.yh, x.rh, 'l')}<span class="lv-ss"><b class="lv-h num" title="홈">${esc(x.h)}</b><b class="lv-a num" title="원정">${esc(x.a)}</b></span>${cd(x.ya, x.ra, 'r')}</span>`;
  const t = (txt, dot, cls = '') => `<span class="lv-t${cls}">${dot ? '<i class="dot"></i>' : ''}${txt}</span>`;
  if (ended || ['FT', 'AET', 'PEN'].includes(x.s)) return (wait ? t('종료<small>결과 대기</small>', false, ' end wait') : t('종료', false)) + sc;
  if (x.s === 'HT') return t('HT', false) + sc;
  if (x.s === 'P') return t('승부차기', true) + sc;
  return t(x.m != null ? esc(x.m) + "'" : 'LIVE', true, ' num') + sc;
}
/* ---------- 경기 목록 위 표시 설명 (한 항목씩 끊어서, 좁은 폰·폴드 커버에선 한 줄에 하나) ---------- */
/* 위험성 안내 (회원 주소) */
const RISK_MATCH = `<aside class="risk" role="note"><b>⚠ 예측일 뿐이에요</b> 이 분석은 AI가 데이터로 낸 <b>예측</b>이며 결과를 보장하지 않아요. 축구는 변수가 많아 가능성이 높아도 틀릴 수 있어요. 분석을 근거로 돈을 거는 일은 권하지 않아요.</aside>`;
function riskLine() {   // 경기 목록 맨 위 한 줄 (닫으면 다시 안 보임)
  if (!MEMBER || store.get('aa_risk') === '1') return '';
  return `<div class="risk-line" id="riskLine"><span>RAISE의 예측은 참고용이에요. 맹신하지 말고 경기 자체를 즐겨 주세요.</span><button type="button" aria-label="안내 닫기" onclick="this.parentNode.remove();try{localStorage.setItem('aa_risk','1')}catch(e){}">×</button></div>`;
}
function legendHtml() {
  const G = MEMBER ? '숨은 기회' : '이득', S = MEMBER ? '★ 예측+기회' : '★ 예측+이득';
  const it = (k, t) => `<span class="lgd-i">${k}<span>${t}</span></span>`;
  return `<div class="lgd small mute" role="note">
    ${it('<span class="tag pick">예측</span>', '가장 유력한 결과')}
    ${it(`<span class="tag value">${G}</span>`, MEMBER ? '시장보다 우리가 높게 본 선택' : '우리 가능성에 비해 배당이 후한 선택')}
    ${it(`<span class="tag both"><span class="star">${S}</span></span>`, '둘 다 해당')}
    ${it(`<span class="lgd-k">줄 색</span>`, `<span class="lgnd hot">초록</span> ${S.slice(2)} · <span class="lgnd val">분홍</span> ${G}`)}
    ${it(`<span class="lgd-k">막대</span>`, '<span class="trilegend"><span><i class="h"></i>홈 승</span><span><i class="d"></i>무</span><span><i class="a"></i>원정 승</span></span>')}
  </div>`;
}
/* ---------- 쿠팡 파트너스 배너 (회원 주소만) ----------
   배너 상자(#cp-ad)는 index.html 에 한 번만 있다. 화면을 새로 그리기 전에 몸통으로 빼 두고(parkAd),
   그린 뒤 알맞은 자리(경기 목록 6번째 줄 뒤, 분석가 픽 카드 아래)로 옮긴다(placeAd). */
function parkAd() {
  const ad = document.getElementById('cp-ad');
  if (ad && view.contains(ad)) { ad.hidden = true; document.body.appendChild(ad); }
}
function placeAd(after) {
  const ad = document.getElementById('cp-ad');
  if (!ad || !MEMBER || !after) return;
  after.after(ad); ad.hidden = false;
}
/* 회원 화면: 끝난 경기는 줄째 숨기고, 그날 경기가 다 숨겨지면 날짜 제목도 숨긴다 */
function hideEnded(el) {
  const row = el.closest('.row');
  if (!row || row.hidden) return;
  row.hidden = true;
  let h = row.previousElementSibling;
  while (h && !h.matches('h2.day')) h = h.previousElementSibling;
  if (!h) return;
  let n = h.nextElementSibling, any = false;
  while (n && !n.matches('h2.day')) { if (n.matches('.row') && !n.hidden) any = true; n = n.nextElementSibling; }
  h.hidden = !any;
}
async function liveTick() {
  clearTimeout(liveTimer);
  const els = [...document.querySelectorAll('[data-live]')];
  finalTick();
  if (!STATIC || !els.length) return;
  let d;
  try { const r = await fetch('/api/live', {cache: 'no-cache'}); d = await r.json(); } catch (e) { d = null; }
  if (d && d.error === 'no_key') return;   /* 키가 아직 없으면 조용히 멈춘다 */
  /* 서버가 오류면(공용 IP 때문에 API-Football 이 가끔 분당 한도 오류를 줌) 이 브라우저가 기억한 마지막 점수(15분 안)를 보여 준다 */
  if (d && !d.error && d.at) { try { localStorage.setItem('aa_live', JSON.stringify({at: d.at, live: d.live || {}})); } catch (e) {} }
  else {
    let c = null;
    try { c = JSON.parse(localStorage.getItem('aa_live') || 'null'); } catch (e) {}
    if (c && Date.now() - Date.parse(c.at) < 15 * 60e3) d = c;
    else { liveTimer = setTimeout(liveTick, 60e3); return; }   /* 기억도 없으면 화면의 점수를 그대로 두고 1분 뒤 다시 */
  }
  /* 받은 점수가 이미 보여 준 것보다 옛날 것이면(서버 대체값·다른 서버 캐시) 화면을 되돌리지 않는다: 2:0 → 1:0 → 2:0 깜빡임 방지 */
  const at = Date.parse(d && d.at) || 0;
  if (at && at < liveAt) { liveTimer = setTimeout(liveTick, 60e3); return; }
  if (at) liveAt = at;
  const live = (d && d.live) || {};
  document.querySelectorAll('[data-live]').forEach(el => {
    const id = el.dataset.live, x = live[id];
    if (x) liveSeen[id] = x;
    const show = x || (d && liveSeen[id] ? {...liveSeen[id]} : null);
    if (!show) {
      const past = Date.now() >= Number(el.dataset.kick) + WAIT_MS;
      el.className = 'lv'; el.innerHTML = past ? waitHtml(id) : ''; el.hidden = !past;
      if (MEMBER && past) hideEnded(el);
      return;
    }
    el.className = 'lv' + (x && LIVE_ON.includes(x.s) && x.s !== 'HT' ? ' on' : '');
    el.innerHTML = x ? liveText(show, false) : FINALS[id] ? waitHtml(id) : liveText(show, true, true);
    el.hidden = false;
    if (MEMBER && !x) hideEnded(el);
  });
  finalTick();   /* 방금 '결과 반영 대기'로 바뀐 경기의 최종 점수도 바로 묻는다 */
  liveTimer = setTimeout(liveTick, 60e3);
}

/* ---------- 경기 상세 ---------- */
/* 이 경기 쇼츠: RAISE Fulltime 채널 영상 중 제목에 '홈 vs 원정'이 들어간 것 (functions/api/yt.js)
   처음엔 썸네일만, 누르면 그 자리에서 재생 (유튜브 쿠키는 누르기 전에는 안 생기게 youtube-nocookie) */
const ytNorm = t => String(t || '').replace(/[\s·.\-_|]/g, '').toLowerCase();
let YT_P = null, YT_T = 0;
const ytItems = () => {   /* 채널 최근 영상 목록 (5분 동안 다시 받지 않음) */
  if (!YT_P || Date.now() - YT_T > 300e3) { YT_T = Date.now(); YT_P = fetch('/api/yt').then(r => r.ok ? r.json() : {items: []}).then(j => j.items || []).catch(() => []); }
  return YT_P;
};
const ytFor = (items, m) => { const k = ytNorm(m.home + 'vs' + m.away); return items.find(x => ytNorm(x.title).includes(k)); };
const ytThumb = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
const ytAuto = id => { try { sessionStorage.setItem('aa_autoplay', id); } catch (e) {} };
/* 경기 목록: 맨 위 '오늘의 쇼츠' 줄 + 쇼츠 있는 경기 줄에 '▶ 쇼츠' 꼬리표 (누르면 경기 화면에서 바로 재생) */
async function mountShortsList(matches) {
  const items = await ytItems(); if (!items.length) return;
  const found = [];
  matches.forEach(m => { const v = ytFor(items, m); if (v) found.push({m, v}); });
  if (!found.length) return;
  found.forEach(({m}) => {
    const row = view.querySelector(`a.row[data-mid="${CSS.escape(m.id)}"] .tags`);
    if (row && !row.querySelector('.tag.yt')) row.insertAdjacentHTML('afterbegin', `<span class="tag yt" data-auto="${esc(m.id)}">▶ 쇼츠</span>`);
  });
  const strip = document.getElementById('ytStrip');
  if (strip) {
    const list = found.sort((a, b) => (a.v.published < b.v.published ? 1 : -1)).slice(0, 8);
    strip.innerHTML = `<div class="ytshead"><h2>📺 오늘의 쇼츠</h2><a class="small" href="https://www.youtube.com/@raise-fulltime/shorts" target="_blank" rel="noopener">유튜브 채널 ↗</a></div>
      <div class="ytsrow">${list.map(({m, v}) => `<a class="ytsc" href="${matchHref(m.id, m.slug)}" data-auto="${esc(m.id)}">
        <span class="ytthumb"><img src="${ytThumb(v.id)}" alt="" loading="lazy" onerror="this.remove()"><b class="ytplay" aria-hidden="true">▶</b></span>
        <span class="ytst"><span>${esc(m.home)}</span> <span class="mute">vs</span> <span>${esc(m.away)}</span></span>
        <small class="mute">${esc(lgName(m))} · ${esc(timeOf(m.kickoff))}</small></a>`).join('')}</div>`;
    strip.hidden = false;
  }
  view.querySelectorAll('[data-auto]').forEach(el => el.addEventListener('click', () => ytAuto(el.dataset.auto)));
}
async function mountShort(m) {
  const box = document.getElementById('ytShort'); if (!box) return;
  const v = ytFor(await ytItems(), m);
  if (!v || !document.body.contains(box)) return;
  box.innerHTML = `<button type="button" class="ytcard" aria-label="이 경기 쇼츠 재생">
      <span class="ytthumb"><img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" alt="" loading="lazy" onerror="this.remove()"><b class="ytplay" aria-hidden="true">▶</b></span>
      <span class="yttext"><b>이 경기 쇼츠로 보기</b><small>약 20초 · 분석 요약</small><small class="ytch">▶ RAISE Fulltime 유튜브</small></span>
    </button>`;
  const card = box.querySelector('.ytcard');
  card.onclick = () => {
    box.innerHTML = `<div class="ytplayer"><iframe src="https://www.youtube-nocookie.com/embed/${esc(v.id)}?autoplay=1&playsinline=1&rel=0" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
      <a class="ytlink" href="https://www.youtube.com/shorts/${esc(v.id)}" target="_blank" rel="noopener">유튜브에서 보기 · 구독하기 ↗</a>`;
  };
  let auto = ''; try { auto = sessionStorage.getItem('aa_autoplay') || ''; sessionStorage.removeItem('aa_autoplay'); } catch (e) {}
  if (auto === m.id) { box.scrollIntoView({block: 'center'}); card.click(); }
}
async function renderMatch(id) {
  const r = await api('/api/matches/' + encodeURIComponent(id));
  await loadNews();
  ODDS_H = await api('/api/odds').catch(() => null);
  const m = r.match, d = r.decision, one = d.one_x_two, ou = d.over_under, s = r.summary;
  if (MEMBER && s.slug) {   // 회원 주소: #m- 로 들어와도 주소창은 진짜 경기 주소로
    const want = '/match/' + encodeURIComponent(s.slug);
    if (!SRC_PATH.test(location.pathname) && location.pathname !== want && decodeURIComponent(location.pathname) !== '/match/' + s.slug) history.replaceState(null, '', want);
    document.title = `${m.home} vs ${m.away} 분석 · RAISE`;
    const c = document.querySelector('link[rel=canonical]'); if (c) c.href = location.origin + want;
  }
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
  if (hasMarket) rows.push({who: '시장', sub: MEMBER ? '시장 예상' : '배당에 담긴 가능성', p: one.market_probs, over: ou.market_probs && ou.market_probs.over, c: 'var(--mute)', cls: 'mk'});

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
  const good = choices.filter(c => isGood(c.e, c.o));
  const vRow = c => `<tr class="${c.pick ? 'pk' : ''}"><td data-l="선택">${esc(c.label)}${c.pick ? ' <span class="small mute" style="white-space:nowrap">예측</span>' : ''}</td>
    <td data-l="우리가 본 가능성" class="r num">${pct(c.p)}</td><td data-l="본전 가능성" class="r num">${pct(c.be)}</td>
    <td data-l="배당" class="r num">${esc(c.o ?? '-')}</td><td data-l="5,000원당 평균 손익" class="r"><span class="ev ${isGood(c.e, c.o) ? 'plus' : ''}">${won(c.e)}</span></td></tr>`;
  const pickName = one.pick ? N[one.pick] : null;
  let lead;
  if (pickName && good.length && !good.some(c => c.k === one.pick)) lead = `가장 일어날 것 같은 결과는 ${pickName}이지만, 배당이 후하게 나온 쪽은 ${good.map(c => c.label).join(', ')}입니다.`;
  else if (pickName && good.some(c => c.k === one.pick)) lead = `${pickName}은 가장 일어날 것 같고, 배당도 후하게 나와 있습니다.`;
  else if (!pickName) lead = '분석가 의견이 갈려 승패는 판단을 보류합니다.' + (good.length ? ` 배당이 후한 쪽: ${good.map(c => c.label).join(', ')}.` : '');
  else lead = '이번 경기는 배당이 후하게 나온 선택이 없습니다.';
  const why = good.map(c => `<li><b>${esc(c.label)}</b>: 우리는 ${pct(c.p)}로 보는데, 이 배당은 ${pct(c.be)}만 돼도 본전입니다. 5,000원을 걸면 평균 <b>${won(c.e)}</b>.</li>`).join('');
  /* 회원 화면용: 돈·배당 숫자 없이 우리 예상 vs 시장 예상 */
  const mq = {...mkt(odds, ['home', 'draw', 'away']), ...mkt(odds, ['over', 'under'])};
  const mRow = c => { const q = mq[c.k], g = isGood(c.e, c.o), df = q != null && c.p != null ? Math.round((c.p - q) * 100) : null;
    return `<tr class="${c.pick ? 'pk' : ''}"><td data-l="선택">${esc(c.label)}${c.pick ? ' <span class="small mute" style="white-space:nowrap">예측</span>' : ''}${g ? ' <span class="tag value">숨은 기회</span>' : ''}</td>
    <td data-l="우리 예상" class="r num">${pct(c.p)}</td><td data-l="시장 예상" class="r num">${pct(q)}</td><td data-l="차이" class="r num">${df == null ? '-' : (df > 0 ? '+' : df < 0 ? '−' : '±') + Math.abs(df) + '%p'}</td></tr>`; };
  const gl = good.map(c => c.label).join(', ');
  const mLead = pickName && good.length && !good.some(c => c.k === one.pick) ? `가장 일어날 것 같은 결과는 ${pickName}이지만, 시장이 낮게 본 쪽은 ${gl}입니다.`
    : pickName && good.some(c => c.k === one.pick) ? `${pickName}은 가장 일어날 것 같고, 시장보다 우리가 더 높게 봤습니다.`
    : !pickName ? '분석가 의견이 갈려 승패는 판단을 보류합니다.' + (good.length ? ` 시장이 낮게 본 쪽: ${gl}.` : '')
    : '이번 경기는 시장과 우리 예상이 크게 다르지 않습니다.';

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
    <div id="ytShort"></div>
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
        ${!MEMBER && STATIC ? lineBox(m, d, s) : ''}
      </div>
      <div>
${MEMBER ? `        <div class="panel"><h2>숨은 기회</h2><p class="lead">${esc(mLead)}</p>
          <div class="scroll"><table class="stack vt"><thead><tr><th>선택</th><th class="r">우리 예상</th><th class="r">시장 예상</th><th class="r">차이</th></tr></thead><tbody>
          ${choices.map(mRow).join('')}
          </tbody></table></div>
          <details><summary>이 표 읽는 법</summary><div class="small">
            <p><b>시장 예상</b>은 여러 해외 업체가 매긴 숫자를 가능성으로 바꾼 값입니다. 세 결과(또는 언더·오버)의 합이 100%가 되게 맞췄습니다.</p>
            <p><b>우리 예상</b>이 시장 예상보다 충분히 높으면 <b>숨은 기회</b>로 표시합니다. 시장이 놓친 부분을 우리가 봤을 수 있다는 뜻입니다.</p>
            <p><b>숨은 기회가 이번 경기에서 맞는다는 뜻은 아닙니다.</b> 가능성 31%라면 10번 중 7번은 빗나갑니다.</p>
          </div></details></div>` : `        <div class="panel"><h2>배당 이득 계산</h2><p class="lead">${esc(lead)}</p>
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
          </div></details></div>`}
        ${MEMBER ? RISK_MATCH : ''}
        <div class="panel small">${MEMBER ? '' : `<b>분석 방식</b><br><span class="mute">${esc(r.engine)}</span><br>`}<b>분석 시각</b> <span class="mute">${esc(r.analyzed_at || '-')}</span><br><b>투표 비중</b> <span class="mute">${r.final.map(o => esc(o.member_name) + ' ' + (d.weights[o.member_id] != null ? d.weights[o.member_id].toFixed(2) : '투표 안 함')).join(', ')}</span></div>
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
  if (STATIC) mountShort(m);
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
      ${MEMBER ? '<div class="stat"><span class="num">숨은 기회</span><span>우리가 본 가능성이 시장 예상보다 충분히 높으면 표시</span></div>'
        : `<div class="stat"><span class="num">+${Math.round(c.policy.value_threshold * UNIT).toLocaleString('ko-KR')}원</span><span>5,000원당 평균 손익이 이 이상(단 +2,000원 이하, 배당 3.5 이하)이면 이득 신호</span></div>`}
      <div class="stat"><span class="num">${esc(c.policy.min_samples_for_weight)}경기</span><span>채점이 쌓이면 잘 맞힌 사람의 투표 비중을 올림</span></div>
    </div>
    ${c.departments.map(d => `<div class="dept sec"><h2>${esc(d.name)} <span class="tag ${d.active ? 'pick' : 'wait'}">${d.active ? '운영 중' : '준비 중'}</span></h2>
      ${d.members.length ? `<div class="crew" style="margin-top:12px">${d.members.map((p, i) => `<article class="analyst member" style="--c:${esc(p.color || PAL[i % PAL.length])}">
        <div class="ahead"><span class="avatar">${esc(p.name.slice(0, 1))}</span><div><h3>${esc(p.name)}</h3><small>${esc(p.title)} · ${p.votes ? '투표 참여' : '투표 안 함'}</small></div></div>
        <ul class="persona">${personaPoints(p.persona).filter(x => !(MEMBER && /배당|정배|배팅|베팅|본전/.test(x))).map(x => `<li>${esc(x)}</li>`).join('')}</ul></article>`).join('')}</div>`
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

/* ---------- 분석가 픽 (회원용): 한 경기씩 채점한 적중률 + 다가오는 경기의 분석가별 선택. 돈·배당·묶음 없음 ---------- */
const PERSONA = {
  kim_data: ['강팀 신뢰형', '시장과 통계가 가리키는 강팀을 믿는 편'],
  park_field: ['라인업 중시형', '선발·결장·전술 상성을 가장 무겁게 보는 편'],
  lee_contra: ['변수 추구형', '날씨·일정·동기 같은 변수를 먼저 찾아보는 편'],
  hogu: ['상식형', '일반 팬의 눈으로 보는 비교용 분석가 (투표 안 함)'],
};
async function renderPicks() {
  const [d, co] = await Promise.all([api('/api/picks'), api('/api/company').catch(() => null)]);
  const ppl = Object.fromEntries(((co && co.departments) || []).flatMap(x => x.members).map(p => [p.id || p.member_id, p]));
  const order = Object.keys(PERSONA);
  const mem = [...d.members].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  const col = (m, i) => (ppl[m.id] && ppl[m.id].color) || PAL[i % PAL.length];
  const pc = (a, b) => b ? (a * 100 / b).toFixed(1) + '%' : '-';
  const LAB = {home: '홈 승', draw: '무', away: '원정 승'};
  const oc = (m, k) => m.pick[k] ? `<div class="ap-oc"><span>${LAB[k]} 픽</span><b class="num">${pc(m.pick_hit[k], m.pick[k])}</b><small class="num">${m.pick_hit[k]}/${m.pick[k]}</small></div>`
    : `<div class="ap-oc mute"><span>${LAB[k]} 픽</span><b>-</b><small>고른 적 없음</small></div>`;
  const cards = mem.map((m, i) => { const [ty, ds] = PERSONA[m.id] || ['', '']; return `<article class="ap-card" style="--c:${esc(col(m, i))}">
    <div class="ap-h"><span class="avatar">${esc(m.name.slice(0, 1))}</span><div><h3>${esc(m.name)}</h3><span class="ap-ty">${esc(ty)}</span></div></div>
    <p class="ap-ds">${esc(ds)}</p>
    <div class="ap-big"><div><span>승무패 적중률</span><b class="num">${pc(m.hit, m.n)}</b><small class="num">${m.hit} / ${m.n}경기</small></div>
      <div><span>언더·오버 적중률</span><b class="num">${pc(m.ou, m.n)}</b><small class="num">${m.ou} / ${m.n}경기</small></div></div>
    <div class="ap-ocs">${oc(m, 'home')}${oc(m, 'draw')}${oc(m, 'away')}</div>
    <div class="ap-fav"><span>강팀(시장 1순위) 고른 비율</span><div class="ap-fb"><i style="width:${pc(m.fav, m.fav_n)}"></i></div><b class="num">${pc(m.fav, m.fav_n)}</b></div></article>`; }).join('');
  const now = Date.now();
  const up = d.upcoming.filter(u => !(Date.parse(u.kickoff_iso) <= now)).slice(0, 12);
  /* 처음 선택 → 최종 선택 (토론 전 → 토론 뒤). 바뀐 쪽은 '바뀜' 표시 */
  const ouL = v => v === 'over' ? '오버' : v === 'under' ? '언더' : '-';
  const cell = (u, m) => { const x = u.picks[m.id]; if (!x) return '<span class="mute">-</span>';
    const fp = x.fp || x.p, fou = x.fou || x.ou, c1 = fp !== x.p, c2 = fou !== x.ou;
    return `<span class="ap-flow${c1 ? ' chg' : ''}"><span class="ap-pk first ${esc(fp)}">${LAB[fp] || '-'}</span><i aria-label="에서">→</i><span class="ap-pk ${esc(x.p)}">${LAB[x.p] || '-'}</span></span>`
      + `<span class="ap-flow ou${c2 ? ' chg' : ''}"><span class="ap-ou first">${ouL(fou)}</span><i aria-label="에서">→</i><span class="ap-ou">${ouL(x.ou)} ${esc(u.line)}</span></span>`
; };
  const rows = up.map(u => `<tr><td data-l="경기" class="ap-mt"><a href="${matchHref(u.id, u.slug)}"><b>${esc(u.home)} vs ${esc(u.away)}</b></a><small>${esc(u.league)} · ${esc(String(u.kickoff).slice(5, 16))}</small></td>
    ${mem.map(m => `<td data-l="${esc(m.name)}">${cell(u, m)}</td>`).join('')}</tr>`).join('');
  parkAd();
  view.innerHTML = `<section class="band"><div class="wrap"><h1>분석가 픽</h1>${MEMBER ? '<p class="risk-line static"><span>적중 기록은 지난 결과일 뿐, 앞으로도 맞는다는 뜻이 아니에요.</span></p>' : ''}
    <p class="lead mute">분석가 넷이 경기마다 각자 고른 결과와, 지금까지 얼마나 맞혔는지입니다. 묶음이 아니라 한 경기씩 채점합니다.</p>
    <div class="ap-grid">${cards}</div>
    <h2 class="sec">다가오는 경기 · 분석가별 선택</h2><p class="small mute" style="margin:0 0 8px">처음 선택 → 토론을 마친 최종 선택입니다. 토론에서 바뀐 선택은 <mark class="ap-hl">노란 형광펜</mark>으로 칠해져 있어요.</p>
    ${up.length ? `<div class="scroll"><table class="stack ap-tb"><thead><tr><th>경기</th>${mem.map((m, i) => `<th><span class="dot" style="background:${esc(col(m, i))}"></span>${esc(m.name)}<small>${esc((PERSONA[m.id] || [''])[0])}</small></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p class="empty">분석이 끝난 다가오는 경기가 아직 없습니다.</p>'}
    <div id="ap-adslot"></div>
    <p class="small mute" style="margin-top:14px">적중률은 결과가 나온 경기만 셉니다. 강팀(시장 1순위)은 여러 해외 업체가 가장 유력하게 본 결과입니다. 분석 참고용이며 결과를 보장하지 않습니다.</p>
  </div></section>`;
  placeAd(document.getElementById('ap-adslot'));
}

/* ---------- 배팅 게임: 분석가들이 가상 100만원으로 배팅표 3장(장마다 2~5경기) ---------- */
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
  /* 배팅표: 경기 한 줄씩 간단히 (예전 표는 7폴더면 폰에서 2,000px 넘게 길어졌음). 설명은 접어 둔다 */
  const legLine = (l, i) => {
    const mk = l.hit === true ? '<span class="tkc-ox o" title="적중">○</span>' : l.hit === false ? '<span class="tkc-ox x" title="미적중">✕</span>' : '<span class="tkc-ox w" title="결과 대기">·</span>';
    const k = String(l.kickoff || '');
    return `<li class="tkc-row${l.hit === true ? ' hit' : l.hit === false ? ' miss' : ''}">
      <span class="tkc-no">${i + 1}</span>
      <span class="tkc-main"><span class="tkc-meta"><span class="num">${esc(k.slice(5, 10).replace('-', '.'))} ${esc(k.slice(11, 16))}</span>${l.league ? ` · ${esc(l.league)}` : ''}</span>
        <a class="tkc-teams" href="#m-${encodeURIComponent(l.match_id)}"><span>${esc(l.home || l.title)}</span> <span class="mute">vs</span> <span>${esc(l.away || '')}</span></a></span>
      <span class="tkc-pick"><b>${esc(l.label)}</b><span class="num">@${esc(l.odds)}</span></span>
      ${mk}</li>`;
  };
  const slip = (s, brief) => `<div class="panel slip ticket tkc" style="--mc:${esc(col(s.member_id))}">
    <div class="slip-head">
      <span class="who-badge">${esc(s.member_name)}</span>
      ${s.game ? `<span class="slip-game">게임 ${esc(s.game)}</span>` : ''}<span class="slip-size">${esc(s.size)}폴더</span>
      <span class="small mute">${esc(s.placed_at)}</span>
      <span style="margin-left:auto">${st(s)}</span></div>
    <div class="tkc-sum">
      <span><small>배당</small><b class="num">${esc(s.combined_odds)}배</b></span>
      <span><small>건 돈</small><b class="num">${W(s.stake)}</b></span>
      <span><small>${s.status === 'won' ? '받은 돈' : '맞으면'}</small><b class="num">${W(s.status === 'won' ? s.payout : Math.floor(s.stake * s.combined_odds))}</b></span>
      <span><small>맞을 가능성</small><b class="num">${pctx(s.prob ?? s.legs.reduce((a, l) => a * l.prob, 1))}</b></span>
    </div>
    <ol class="tkc-list">${s.legs.map(legLine).join('')}</ol>
    ${brief ? '' : `<details class="tk-explain"><summary>왜 이렇게 골랐나 · 경기별 설명 보기</summary>
      <p class="small">${howText(s)}</p>
      <ol class="small">${s.legs.map(l => `<li><b>${esc(l.title)} → ${esc(l.label)} @${esc(l.odds)}</b><br>
        AI 가능성 <b>${pctx(l.prob)}</b> · 본전 가능성(1÷배당) ${pctx(l.breakeven ?? 1 / l.odds)} · 5,000원당 <b class="${(l.ev ?? 0) >= 0 ? 'plus' : ''}">${won100((l.ev ?? (l.prob * l.odds - 1)) * 100)}</b>
        ${l.reason ? `<br><span class="mute">“${esc(l.reason)}”</span>` : ''}</li>`).join('')}</ol></details>`}</div>`;
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
    <p class="lead mute">분석가들이 각자 가상 자금 <b>${W(b.start_bankroll)}</b>으로 자기 예측만 믿고 배팅표 <b>3장</b>을 들고 갑니다. 한 장에 <b>2~5경기</b>: 자신 있는 경기부터 담고, 모두 맞을 가능성이 10% 아래로 떨어지기 직전에 멈춥니다. 세 장은 서로 다른 경기로 채웁니다. 한 장에 ${W(b.min_stake)}~${W(b.max_stake)}, 경기는 이틀 안에서만 고릅니다. 실제 돈이 아닌 실력 비교용입니다.</p>
    <div class="grid4">${b.accounts.map(a => { const bs = a.by_size || {}; return `<div class="panel acc-card" aria-pressed="${pick === a.member_id}" style="--mc:${esc(col(a.member_id))}">
      <span class="who-badge">${esc(a.name)}</span> <span class="small mute">${esc(a.title)}</span>
      <span class="num acc-value">${W(a.value)}</span>
      <span class="small" style="display:block;margin:2px 0 8px">손익 <b class="num">${a.profit >= 0 ? '+' : ''}${W(a.profit)}</b> (${((a.profit / (b.start_bankroll + (a.deposited || 0))) * 100).toFixed(1)}%)${a.deposited ? ` · <span class="mute">추가로 넣은 돈 ${W(a.deposited)}</span>` : ''}</span>
      <div class="acc-rates">
        <div><span>배팅 적중</span><b class="num">${rate(a.won, a.settled)}</b></div>
        <div><span>경기별 적중</span><b class="num">${rate(a.legs_hit || 0, a.legs_settled || 0)}</b></div>
        <div class="small mute">${Object.keys(bs).filter(k => bs[k].settled).map(k => `${k}폴더 ${bs[k].won}/${bs[k].settled}`).join(' · ') || '아직 끝난 배팅 없음'}</div>
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
    <p class="small mute" style="margin-top:24px">고르는 법: 각 분석가가 경기마다 자기 최종 가능성으로 승무패·언더오버 중 가장 이득인 선택 하나를 고릅니다(가능성 45% 미만은 제외). 그중 5,000원당 평균 손익이 큰 경기부터 2~5개를 담고(모두 맞을 가능성이 10% 아래로 떨어지기 직전에 멈춤), 배팅표 3장은 서로 다른 경기로 채웁니다. 금액은 켈리 기준의 1/4(자신 있을수록 많이)을 한도 안에서 1,000원 단위로. 배당은 북메이커 평균. 배당 자료가 없는 리그·대회(K리그2·J2리그·AFC챔피언스리그)는 빠집니다. 추가로 넣은 돈은 손익에서 빼고 계산합니다.</p>
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
const runOpen = new Set();   // 진행 상황에서 펼쳐 둔 실행
let runPoll = null;
const LINES = [2.5, 3.5, 4.5];   /* 언더/오버 기준점 (aa/lines.py) */
async function renderRun() {
  const [L, M] = await Promise.all([api('/api/leagues'), api('/api/matches')]);
  const now = Date.now();
  const kickMs = k => { const t = Date.parse((k || '').slice(0, 16).replace(' ', 'T') + ':00+09:00'); return isNaN(t) ? 0 : t; };
  const open = M.matches.filter(m => m.status === 'pending' && kickMs(m.kickoff) > now);
  let chosen = new Set((store.get('aa_pick_ids') || '').split(',').filter(id => open.some(m => m.id === id)));
  /* 언더/오버 기준점: 경기마다 2.5·3.5·4.5 중 고름 (기본은 서버 추천: 시장 반반 → 기초 모델) */
  let pkLines = {}; try { pkLines = JSON.parse(store.get('aa_pick_lines') || '{}') || {}; } catch (e) {}
  const lineOf = m => LINES.includes(+pkLines[m.id]) ? +pkLines[m.id] : (LINES.includes(+m.line) ? +m.line : 2.5);
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
        <span class="time">${esc(timeOf(m.kickoff))}${krBadge(m)}</span>
        <span class="teams">${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)}<br><span class="lg">${esc(lgName(m))}</span></span>
        <span class="small mute num">${o.home ? `${esc(o.home)} / ${esc(o.draw)} / ${esc(o.away)}` : '배당 없음'}</span></label>`;
    }).join('')}`).join('') : '<p class="empty">분석을 기다리는 경기가 없습니다. 오른쪽 아래 "경기 목록 새로 가져오기"를 써 보세요.</p>';
    view.querySelectorAll('[data-pk]').forEach(c => c.onchange = () => { c.checked ? chosen.add(c.dataset.pk) : chosen.delete(c.dataset.pk); c.closest('.pk-row').classList.toggle('on', c.checked); drawChosen(); });
  };
  const drawChosen = () => {
    store.set('aa_pick_ids', [...chosen].join(','));
    document.getElementById('pkCount').textContent = chosen.size;
    const list = [...chosen].map(id => byId[id]).filter(Boolean).sort((x, y) => (x.kickoff > y.kickoff ? 1 : -1));
    document.getElementById('pkChosen').innerHTML = list.length ? list.map(m => `<li><span>${esc(m.kickoff.slice(5, 16))} ${esc(m.home)} vs ${esc(m.away)}${krBadge(m)}</span>
      <span class="ln-pick" role="group" aria-label="언더/오버 기준점"><small class="mute">기준</small>${LINES.map(v => `<button type="button" class="ln-btn" data-pl="${esc(m.id)}" data-v="${v}" aria-pressed="${lineOf(m) === v}">${v}</button>`).join('')}</span></li>`).join('') : '<li class="mute">왼쪽에서 경기를 체크하세요.</li>';
    document.querySelectorAll('[data-pl]').forEach(b => b.onclick = () => {
      pkLines[b.dataset.pl] = +b.dataset.v; store.set('aa_pick_lines', JSON.stringify(pkLines)); drawChosen();
    });
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
      store.set('aa_boss', '1');
      msg(okText(j));
      setTimeout(status, 4000);
    } catch (err) { msg(err.message); }
    btn.disabled = false;
  };
  document.getElementById('rgo').onclick = e => {
    if (!chosen.size) { msg('분석할 경기를 하나 이상 체크하세요.'); return; }
    if (chosen.size > 40) { msg('한 번에 40경기까지 고를 수 있습니다.'); return; }
    const n = chosen.size;
    const lines = {}; [...chosen].forEach(id => { if (byId[id]) lines[id] = lineOf(byId[id]); });
    send(e.target, {ids: [...chosen], lines}, () => { const t = `${n}경기 분석을 시작했습니다. 끝나면 경기 목록에 올라옵니다.`; chosen = new Set(); drawList(); drawChosen(); return t; });
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
      const all = Object.fromEntries((M.matches || []).map(m => [m.id, m]));
      const kind = x => x.ids.length ? `분석 ${x.ids.length}경기` : x.named ? '목록 수집' : x.event === 'schedule' ? '자동 (6시·14시)' : '요청';
      const detail = x => !x.ids.length
        ? `<p class="small mute">${x.named ? '경기 목록만 모으는 실행이에요 (분석 없음).' : '이 기능을 넣기 전에 신청한 요청이라 경기 목록을 알 수 없어요.'}</p>`
        : `<ul class="run-ms">${x.ids.map(id => { const m = all[id]; return `<li>${m ? `<span class="num">${esc(m.kickoff.slice(5, 16).replace('-', '/'))}</span> ${esc(m.home)} <span class="mute">vs</span> ${esc(m.away)} <span class="lg">${esc(lgName(m))}</span>${m.status === 'analyzed' ? ' <span class="tag hit">분석 끝</span>' : ''}` : `<span class="mute">${esc(id)}</span>`}</li>`; }).join('')}</ul>`;
      el.innerHTML = `<div class="runs">${j.runs.map(x => `<details class="run" data-run="${esc(x.number)}" ${runOpen.has(String(x.number)) ? 'open' : ''}><summary><span class="num">#${esc(x.number)}</span><span>${kind(x)}</span><span class="num">${esc(when(x.created_at))}</span><span class="r">${label(x)}</span></summary>${detail(x)}</details>`).join('')}</div>
        <p class="small mute" style="margin:8px 0 0">${busy ? '분석이 끝나면 사이트가 1~2분 안에 새로 고쳐집니다. 이 화면은 15초마다 다시 확인합니다.' : '끝난 분석은 경기 목록에서 볼 수 있습니다.'}</p>`;
      el.querySelectorAll('details.run').forEach(d => d.ontoggle = () => { d.open ? runOpen.add(d.dataset.run) : runOpen.delete(d.dataset.run); });   // 15초마다 다시 그려도 펼친 칸 유지
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

/* ---------- 쇼츠 (운영자 주소만) ----------
   고른 리그의 분석 끝난 경기 쇼츠(세로 영상)를 GitHub Actions 가 만들어 둔다 (tools/make_shorts_batch.py).
   여기서는 리그를 고르고, 영상을 미리 보고 내려받고, 유튜브 제목·설명을 복사한다. */
const krNames = it => krOf(it).map(k => k.name);
/* 제목: '홈 vs 원정'은 그대로 둔다 (회원 사이트가 이 부분으로 경기를 찾음). 한국 선수 팀이면 앞에 이름 */
const shortTitle = it => { const k = krNames(it); return `${k.length ? '🇰🇷 ' + k.join('·') + ' 소속팀 | ' : ''}${it.home} vs ${it.away} 승부 예측 | RAISE #shorts`; };
/* 경기 분석 페이지 주소 (tools/export_static.py match_slug 와 같은 규칙, 한글은 %인코딩 → 설명란에서 끊기지 않게) */
const shortUrl = it => 'https://raise-fulltime.com/yt/' + encodeURIComponent(`${it.home}-vs-${it.away}-${(it.kickoff || '').slice(0, 10)}`.replace(/[^0-9A-Za-z가-힣]+/g, '-').replace(/^-+|-+$/g, ''));
const DOMESTIC = /K리그|J1|J2|A리그|AFC/;
const hTag = t => '#' + String(t || '').replace(/[^0-9A-Za-z가-힣]/g, '');
const shortTags = it => {
  const k = krOf(it);
  const lg = String(it.league || '');
  const base = [...k.map(x => hTag(x.name)), ...k.map(x => hTag(KR_TEAM_TAG[x.team])), hTag(lg), DOMESTIC.test(lg) ? '#국내축구' : '#해외축구', '#축구', '#승부예측', '#축구분석'];
  if (k.length) base.push('#코리안리거');
  return [...new Set(base)].join(' ');
};
/* 유튜브 '태그' 칸용 (쉼표로 구분, # 없이) */
const ytTagList = it => {
  const k = krOf(it);
  const lg = String(it.league || '');
  return [...new Set([...k.map(x => x.name), ...k.map(x => x.name + ' 경기'), ...k.map(x => x.team), it.home, it.away, `${it.home} ${it.away}`, lg, DOMESTIC.test(lg) ? '국내축구' : '해외축구', '축구 예측', '승부 예측', 'RAISE'].filter(Boolean))].join(', ');
};
const shortDesc = it => `${krNames(it).length ? '🇰🇷 ' + krOf(it).map(k => `${k.name}(${k.team})`).join(' · ') + '\n' : ''}${it.league} · ${(it.kickoff || '').slice(5, 16).replace('-', '/')} KST\n${shortUrl(it)}\n\n※ 예측은 참고용이에요. 도박 문제 상담 1336\n\n${shortTags(it)} #shorts`;
const instaCap = it => `${krNames(it).length ? '🇰🇷 ' + krNames(it).join('·') + ' 소속팀 경기\n' : ''}${it.home} vs ${it.away} 승부 예측\n${it.league} · ${(it.kickoff || '').slice(5, 16).replace('-', '/')} KST\n🔗 분석 전체는 프로필 링크에서\n\n※ 예측은 참고용이에요. 도박 문제 상담 1336\n\n${shortTags(it)} #릴스`;
async function renderShorts() {
  const [L, S, MM] = await Promise.all([api('/api/leagues'), fetch('/api/shorts', {cache: 'no-store'}).then(r => r.ok ? r.json() : Promise.reject(new Error('쇼츠 목록을 불러오지 못했어요 (' + r.status + ')'))),
    api('/api/matches').catch(() => ({matches: []}))]);
  const items = (S.index && S.index.items) || [];
  /* 쇼츠 상태: 사이트 기준점과 영상 기준점이 다르면 '새로 만드는 중', 최근 다시 만들었으면 '다시 만듦' */
  const nowLine = Object.fromEntries((MM.matches || []).map(m => [m.id, m.line]));
  let lw = {}; try { lw = JSON.parse(store.get('aa_line_wait') || '{}') || {}; } catch (e) {}
  const want = it => { const w = lw[it.id]; return w && Date.now() - w.t < 60 * 60e3 ? +w.line : (nowLine[it.id] != null ? +nowLine[it.id] : null); };
  const shState = it => {
    const w = want(it);
    if (w != null && it.line != null && +it.line !== w) return `<span class="sh-st wait">🔄 기준점 ${esc(w)} 쇼츠 만드는 중 · 몇 분 뒤 새로고침</span>`;
    if (it.remade_at && Date.now() - Date.parse(it.remade_at.replace(' KST', '+09:00').replace(' ', 'T')) < 48 * 3600e3)
      return `<span class="sh-st new">✅ 새로 만듦 ${esc(it.remade_at.slice(5, 16))} · ${esc(it.remade_why || '')} · 이미 올렸다면 다시 받아서 올리세요</span>`;
    return `<span class="sh-st ok">✓ 최신${it.line != null ? ` · 기준 ${esc(it.line)}` : ''}</span>`;
  };
  let picked = new Set((S.leagues || []).map(Number));
  const groups = [...new Set(L.leagues.map(l => l.group))];
  const byDay = {};
  items.forEach(it => { const d = (it.kickoff || '').slice(0, 10); (byDay[d] = byDay[d] || []).push(it); });
  const wd = d => '일월화수목금토'[new Date(d + 'T00:00:00+09:00').getDay()];
  const row = (it, i) => `<li class="sh-row">
      <div class="sh-info"><span class="sh-meta"><span class="num">${esc((it.kickoff || '').slice(11, 16))}</span><span>${esc(it.league)}</span>${krBadge(it)}</span>
        <b class="sh-teams"><span>${esc(it.home)}</span> <span class="mute">vs</span> <span>${esc(it.away)}</span></b>${shState(it)}</div>
      <div class="sh-act">
        <button type="button" class="btn ghost" data-play="${i}">미리보기</button>
        <a class="btn" href="/api/shorts/file/${encodeURIComponent(it.file)}" download>🎬 영상 받기 <span class="num small">${(it.bytes / 1048576).toFixed(1)}MB</span></a>
        ${it.thumb ? `<a class="btn ghost" href="/api/shorts/file/${encodeURIComponent(it.thumb)}" download>🖼 썸네일 받기</a>` : ''}
        <button type="button" class="btn ghost" data-copy="${i}">유튜브 글 복사</button>
        <button type="button" class="btn ghost" data-insta="${i}">인스타 글 복사</button>
        <button type="button" class="btn ghost" data-tags="${i}">태그 복사</button>
      </div>
      <div class="sh-video" id="shv${i}" hidden></div></li>`;
  let idx = 0;
  view.innerHTML = `<section class="band"><div class="wrap"><h1>쇼츠</h1>
    <p class="lead mute">고른 리그의 분석 끝난 경기(킥오프 3일 안)를 세로 영상으로 자동으로 만들어요. 분석이 실행될 때마다 새로 만들어지고, 킥오프가 지나면 목록에서 빠져요.</p>
    <div class="panel"><h2>영상 <span class="small mute">${items.length}개 · 만든 시각 ${esc((S.index && S.index.made_at) || '-')}</span></h2>
      ${items.length ? Object.keys(byDay).sort().map(d => `<h3 class="sh-day">${esc(d.slice(5).replace('-', '/'))} (${wd(d)})</h3><ul class="sh-list">${byDay[d].map(it => row(it, idx++)).join('')}</ul>`).join('')
        : '<p class="mute">아직 만든 영상이 없어요. 다음 분석이 끝나면 여기에 올라와요.</p>'}
    </div>
    <details class="panel"><summary><b>쇼츠 만들 리그</b> <span class="small mute">${picked.size}개 선택</span></summary>
      <p class="small mute">저장하면 다음 분석 실행부터 적용돼요.</p>
      ${groups.map(g => `<fieldset class="lgroup"><legend>${esc(g)}</legend><div class="chips">
        ${L.leagues.filter(l => l.group === g).map(l => `<button type="button" class="chip pickchip" data-sl="${l.id}" aria-pressed="${picked.has(l.id)}">${esc(l.name)}</button>`).join('')}
      </div></fieldset>`).join('')}
      <p class="inline"><button class="btn" id="shSave" type="button">리그 저장</button><span id="shMsg" class="small mute" role="status"></span></p>
    </details>
    <div class="panel small mute"><b>올리는 방법</b><br>1. 영상 받기 (+ 썸네일 받기) → 2. 유튜브 앱에서 쇼츠 올리기 (썸네일은 '썸네일 수정 → 갤러리'에서 받은 그림 고르기) → 3. 음악은 유튜브 안의 무료 음악으로 → 4. '유튜브 글 복사'한 글 붙여넣기 (인스타 릴스는 '인스타 글 복사')<br>같은 모양 영상을 하루에 너무 많이 올리면 유튜브가 자동 생성 영상으로 보고 수익 창출을 막을 수 있어요. 큰 경기 위주로 골라 올리세요.</div>
  </div></section>`;
  view.querySelectorAll('[data-sl]').forEach(b => b.onclick = () => {
    const id = +b.dataset.sl; picked.has(id) ? picked.delete(id) : picked.add(id); b.setAttribute('aria-pressed', picked.has(id));
  });
  document.getElementById('shSave').onclick = async e => {
    const msg = document.getElementById('shMsg'); e.target.disabled = true; msg.textContent = '저장 중…';
    try {
      const r = await fetch('/api/shorts/leagues', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({leagues: [...picked]})});
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || '저장 실패 ' + r.status);
      msg.textContent = `${j.leagues.length}개 리그를 저장했어요. 다음 분석부터 적용돼요.`;
    } catch (err) { msg.textContent = err.message; }
    e.target.disabled = false;
  };
  view.querySelectorAll('[data-play]').forEach(b => b.onclick = () => {
    const i = +b.dataset.play, box = document.getElementById('shv' + i), it = items[i];
    if (box.hidden) { box.innerHTML = `<video controls playsinline preload="metadata" src="/api/shorts/file/${encodeURIComponent(it.file)}"></video>`; box.hidden = false; b.textContent = '닫기'; }
    else { box.innerHTML = ''; box.hidden = true; b.textContent = '미리보기'; }
  });
  view.querySelectorAll('[data-tags]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(ytTagList(items[+b.dataset.tags])); toast('유튜브 태그를 복사했어요. 업로드 화면 "태그" 칸에 붙여넣으세요.'); }
    catch { toast('복사하지 못했어요. 브라우저가 막았을 수 있어요.'); }
  });
  view.querySelectorAll('[data-insta]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(instaCap(items[+b.dataset.insta])); toast('인스타 릴스 글을 복사했어요.'); }
    catch { toast('복사하지 못했어요. 브라우저가 막았을 수 있어요.'); }
  });
  view.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const it = items[+b.dataset.copy];
    try { await navigator.clipboard.writeText(shortTitle(it) + '\n\n' + shortDesc(it)); toast('유튜브 제목과 설명을 복사했어요. 첫 줄이 제목이에요.'); }
    catch { toast('복사하지 못했어요. 브라우저가 막았을 수 있어요.'); }
  });
}

/* ---------- 길찾기 ---------- */
const PAGES = ['about', 'terms', 'privacy'];
const SUBS = /^(about|terms|privacy|help|notice(\/\d+)?)$/;   // 진짜 주소로 열리는 화면 (help 고객센터, notice 공지)
// 유입 표시 주소: /yt·/ig·/tt (쇼츠·릴스·틱톡에서 온 방문을 Web Analytics 경로로 구분). /yt/<경기주소> = 그 경기 화면
const SRC_PATH = /^\/(yt|ig|tt)(\/|$)/;
const subPath = () => {
  const p = location.pathname.replace(/^\/+|\/+$/g, '');
  const m = p.match(/^(yt|ig|tt)(?:\/(.+))?$/);
  return m ? (m[2] ? 'match/' + m[2] : '') : p;
};
const onSubPage = () => { const p = subPath(); return SUBS.test(p) || p.startsWith('match/'); };   // 첫 주소(/)가 아닌 화면
/* 회원 주소: 경기 링크는 검색엔진용 진짜 주소(/match/…), 운영자 주소는 지금처럼 #m- */
const matchHref = (id, slug) => MEMBER && slug ? '/match/' + encodeURIComponent(slug) : '#m-' + encodeURIComponent(id);   // 진짜 주소(/about 등)로도 열리는 안내 페이지 (미들웨어가 index.html 을 돌려줌)
async function route() {
  const pk = subPath();
  const keepHash = pk === 'help';   // /help#my 는 고객센터 안의 위치
  if (onSubPage() && !keepHash && location.hash.length > 1) { location.replace('/' + location.hash); return; }   // 안내·경기 주소에서 다른 화면으로 → 첫 주소로
  const nb = document.getElementById('nbar'); if (nb) nb.remove();
  let h = keepHash ? '' : location.hash.replace(/^#\/?/, '');
  if (!h && SUBS.test(pk)) h = pk;
  if (!h && pk.startsWith('match/') && window.AA_MATCH) h = 'm-' + window.AA_MATCH;
  const navKey = !h || h.startsWith('m-') ? 'list' : h;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === navKey));
  if (READONLY) document.querySelectorAll('.admin-link').forEach(a => a.hidden = true);
  if (MEMBER) {   /* 회원 화면: 경기·분석팀·뉴스만. 배팅 게임·인사평가·관리·분석 요청은 운영자 주소에서만 */
    document.querySelectorAll('[data-nav="bets"],[data-nav="record"],[data-nav="admin"],[data-nav="run"],[data-nav="shorts"]').forEach(a => a.remove());
    if (['bets', 'record', 'admin', 'run', 'shorts'].includes(h)) { location.replace('#'); return; }
    if (!document.querySelector('[data-nav="picks"]')) {
      const a = document.createElement('a'); a.href = '#picks'; a.dataset.nav = 'picks'; a.textContent = '분석가 픽';
      const first = document.querySelector('[data-nav="list"]'); first.after(a);
      a.classList.toggle('on', navKey === 'picks');
    }
  }
  document.querySelectorAll('.run-link').forEach(a => a.hidden = !STATIC);
  document.querySelectorAll('.mem-link').forEach(a => a.hidden = !OPERATOR);   /* 회원 관리: 운영자 주소만 */
  if (h !== 'run') clearInterval(runPoll);
  parkAd();
  try {
    if (h.startsWith('m-')) await renderMatch(decodeURIComponent(h.slice(2)));
    else if (h === 'team') await renderTeam();
    else if (h === 'record') await renderRecord();
    else if (h === 'bets') await renderBets();
    else if (h === 'picks') await renderPicks();
    else if (h === 'join') await renderJoin();
    else if (PAGES.includes(h)) renderPolicy(h);
    else if (h === 'help') await renderHelp();
    else if (h === 'notice') await renderNotices();
    else if (/^notice\/\d+$/.test(h)) await renderNotice(+h.split('/')[1]);
    else if (h === 'login-fail') { toast('로그인하지 못했어요. 다시 시도해 주세요.'); location.replace('#'); return; }
    else if (h === 'members') await renderMembers();
    else if (h === 'shorts' && OPERATOR) await renderShorts();
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
/* =====================================================================
   회원 (카카오·구글 로그인) · 관심 경기 ☆ · 실시간 채팅방
   - 회원 주소(raise-fulltime.com): 로그인·가입, ☆, 채팅(회원만 말하기, 비회원은 읽기)
   - 운영자 주소(raise-bet.com·pages.dev, Access 잠금): 채팅에 '운영자'로 말하기, 가리기·차단
   서버: functions/api/{me,fav,auth,chat}, chat/ (raise-chat 워커), db/members.sql
   ===================================================================== */
/* 운영자 경기 화면: 언더/오버 기준점 바꾸기 (2.5·3.5·4.5). 저장하면 GitHub 에서 결과를 고쳐 1~3분 뒤 회원 사이트에 반영 */
function lineBox(m, d, s) {
  const started = !!s.result || (s.kickoff_iso ? Date.parse(s.kickoff_iso) <= Date.now() : false);
  let wait = {}; try { wait = JSON.parse(store.get('aa_line_wait') || '{}') || {}; } catch (e) {}
  const w = wait[m.id];
  const pending = w && Date.now() - w.t < 15 * 60e3 && +w.line !== +d.line ? +w.line : null;
  const btns = LINES.map(v => `<button type="button" class="ln-btn" data-ml="${esc(m.id)}" data-v="${v}" data-need="${s.reline ? '' : '1'}" aria-pressed="${+(pending ?? d.line) === v}"${started ? ' disabled' : ''}>${v}</button>`).join('');
  const note = started ? '경기가 시작돼 기준점을 바꿀 수 없어요.'
    : pending ? `${pending}(으)로 바꾸는 중이에요. 1~3분 뒤 회원 사이트에 반영돼요.`
    : !s.reline ? '예전 방식 분석이라 바꾸려면 분석가들에게 언더/오버만 짧게 보충 질문해요 (경기당 약 40~50원, 승무패 예측은 그대로). 회원 사이트에는 3~5분 뒤 반영돼요.'
    : '바꾸면 다시 분석하지 않고 분석가들이 미리 낸 숫자로 결론을 고쳐요. 회원 사이트에는 1~3분 뒤 반영되고 쇼츠도 다시 만들어요.';
  return `<div class="panel ln-box"><div class="ln-pick" role="group" aria-label="언더/오버 기준점"><b>언더/오버 기준점</b> ${btns}</div>
    ${!started && !store.get('aa_run_pw') ? '<input type="password" class="ln-pw" placeholder="분석 요청 비밀번호" autocomplete="current-password">' : ''}
    <p class="small mute ln-note" role="status">${esc(note)}</p></div>`;
}
document.addEventListener('click', async e => {
  const b = e.target.closest && e.target.closest('[data-ml]');
  if (!b || b.disabled || b.getAttribute('aria-pressed') === 'true') return;
  const box = b.closest('.ln-box'), note = box.querySelector('.ln-note'), pwEl = box.querySelector('.ln-pw');
  const pw = store.get('aa_run_pw') || (pwEl && pwEl.value);
  if (!pw) { note.textContent = '분석 요청 비밀번호를 넣고 다시 눌러 주세요.'; pwEl && pwEl.focus(); return; }
  /* 예전 분석: 보충 질문 비용이 들어서 한 번 더 눌러야 진행 */
  if (b.dataset.need && box.dataset.ok !== b.dataset.v) {
    box.dataset.ok = b.dataset.v;
    box.querySelectorAll('[data-ml]').forEach(x => x.classList.toggle('ask', x === b));
    note.textContent = `${b.dataset.v}(으)로 바꾸려면 보충 질문 비용(약 40~50원)이 들어요. 진행하려면 ${b.dataset.v} 를 한 번 더 누르세요.`;
    return;
  }
  box.querySelectorAll('[data-ml]').forEach(x => x.disabled = true);
  note.textContent = `${b.dataset.v}(으)로 바꾸는 중…`;
  let j = {};
  try { const r = await fetch('/api/lines', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pw, id: b.dataset.ml, line: +b.dataset.v})}); j = await r.json(); }
  catch (err) { j = {error: '연결이 끊겼어요. 다시 눌러 주세요.'}; }
  box.querySelectorAll('[data-ml]').forEach(x => x.disabled = false);
  if (!j.ok) { note.textContent = j.error || '저장하지 못했어요.'; return; }
  if (pwEl) store.set('aa_run_pw', pw);
  let wait = {}; try { wait = JSON.parse(store.get('aa_line_wait') || '{}') || {}; } catch (err) {}
  wait[j.id] = {line: j.line, t: Date.now()}; store.set('aa_line_wait', JSON.stringify(wait));
  box.querySelectorAll('[data-ml]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.v === +j.line));
  box.querySelectorAll('[data-ml]').forEach(x => x.classList.remove('ask')); delete box.dataset.ok;
  note.textContent = `${j.line}(으)로 저장했어요. ${b.dataset.need ? '3~5분' : '1~3분'} 뒤 회원 사이트에 반영되고, 쇼츠는 5~10분 뒤 '쇼츠' 메뉴에 ✅ 새로 만듦으로 표시돼요.`;
  if (pwEl) pwEl.remove();
});
function toast(msg, ms = 2600) {
  let t = document.getElementById('aa-toast');
  if (!t) { t = document.createElement('div'); t.id = 'aa-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms);
}
function favStar(id) {
  if (!MEMBER) return '';
  const on = FAVS.has(id);
  return `<button type="button" class="favb${on ? ' on' : ''}" data-fav="${esc(id)}" aria-pressed="${on}" aria-label="관심 경기${on ? ' 해제' : ''}" title="관심 경기">${on ? '★' : '☆'}</button>`;
}
function favBarHtml() {
  return `<div class="favbar"><button type="button" id="favonly" class="favonly" aria-pressed="${favOnly}"><span class="st">${favOnly ? '★' : '☆'}</span> 관심 경기 ${ME.user ? `<span class="num">${FAVS.size}</span>` : '<small>회원 전용</small>'}</button>${favOnly ? '<span class="small mute">관심 경기만 보는 중 · 다시 누르면 전체</span>' : ''}</div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('.favb');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (!ME.user) return openLogin('관심 경기는 회원 전용 기능이에요');
  const id = b.dataset.fav, on = !FAVS.has(id);
  on ? FAVS.add(id) : FAVS.delete(id);
  document.querySelectorAll(`.favb[data-fav="${CSS.escape(id)}"]`).forEach(x => { x.classList.toggle('on', on); x.textContent = on ? '★' : '☆'; x.setAttribute('aria-pressed', on); });
  const n = document.querySelector('#favonly .num'); if (n) n.textContent = FAVS.size;
  try {
    const r = await fetch('/api/fav', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({id, on})});
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '저장하지 못했어요');
    toast(on ? '관심 경기에 넣었어요' : '관심 경기에서 뺐어요', 1400);
  } catch (err) { on ? FAVS.delete(id) : FAVS.add(id); toast(err.message); renderList(); }
}, true);

/* ---------- 로그인 창 ---------- */
function openLogin(reason) {
  closeLogin();
  const ready = ME.ready || {};
  const d = document.createElement('div');
  d.id = 'aa-login'; d.className = 'modal-bg';
  d.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="lg-t">
    <button type="button" class="modal-x" aria-label="닫기">×</button>
    ${reason ? `<p class="modal-why">${esc(reason)}</p>` : ''}
    <h2 id="lg-t">RAISE 회원으로 시작하기</h2>
    <p class="small mute">채팅방에서 대화하고, 관심 경기를 모아 볼 수 있어요.</p>
    <a class="sso kakao${ready.kakao === false ? ' off' : ''}" href="/api/auth/kakao"><span class="ic" aria-hidden="true">💬</span>카카오로 시작하기</a>
    <a class="sso google${ready.google === false ? ' off' : ''}" href="/api/auth/google"><span class="ic g" aria-hidden="true">G</span>구글로 시작하기</a>
    <p class="tiny mute">만 19세 이상만 가입할 수 있어요. 처음이면 닉네임만 정하면 끝나요. 비밀번호는 저장하지 않아요.<br>
    <a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></p></div>`;
  d.addEventListener('click', ev => { if (ev.target === d || ev.target.closest('.modal-x') || ev.target.closest('a[href^="#"]')) closeLogin(); });
  d.querySelectorAll('.sso.off').forEach(a => a.onclick = ev => { ev.preventDefault(); toast('이 로그인은 준비 중이에요. 곧 열려요.'); });
  document.body.appendChild(d);
  d.querySelector('.sso').focus();
}
function closeLogin() { const d = document.getElementById('aa-login'); if (d) d.remove(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLogin(); });

/* ---------- 머리말 계정 버튼 (회원 주소) ---------- */
function drawAccount() {
  if (!MEMBER) return;
  const top = document.querySelector('.top');
  let b = document.getElementById('acctBtn');
  if (!b) { b = document.createElement('button'); b.id = 'acctBtn'; b.type = 'button'; b.className = 'acctbtn'; (document.getElementById('zoomBtn') || top.querySelector('.brand')).after(b); }
  if (ME.user) {
    b.innerHTML = `<span class="av">${esc(ME.user.nick.slice(0, 1))}</span><span class="nm">${esc(ME.user.nick)}</span>${ME.user.unread ? '<i class="dot" aria-label="새 답변"></i>' : ''}`;
    b.onclick = () => openAccount();
  } else {
    b.textContent = '로그인';
    b.onclick = () => openLogin('');
  }
}
function openAccount() {
  closeLogin();
  const d = document.createElement('div');
  d.id = 'aa-login'; d.className = 'modal-bg';
  d.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button type="button" class="modal-x" aria-label="닫기">×</button>
    <h2>${esc(ME.user.nick)} 님</h2><p class="small mute">관심 경기 ${FAVS.size}개</p>
    <a class="btn-line" href="/help#my">1:1 문의${ME.user.unread ? ` <b class="newb">새 답변 ${ME.user.unread}</b>` : ''}</a>
    <a class="btn-line" href="/notice">공지사항</a>
    <button type="button" class="btn-line" data-act="logout">로그아웃</button>
    <button type="button" class="btn-line danger" data-act="delete">회원 탈퇴</button>
    <p class="tiny mute"><a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></p></div>`;
  d.addEventListener('click', async ev => {
    if (ev.target === d || ev.target.closest('.modal-x') || ev.target.closest('a[href^="#"]')) return closeLogin();
    const act = ev.target.dataset && ev.target.dataset.act;
    if (!act) return;
    if (act === 'delete' && !confirm('회원 탈퇴하면 닉네임과 관심 경기가 모두 지워지고 되돌릴 수 없어요. 탈퇴할까요?')) return;
    await fetch('/api/auth/' + act, {method: 'POST'}).catch(() => null);
    location.replace('/');
  });
  document.body.appendChild(d);
}

/* ---------- 가입 마무리: 닉네임 · 19세 · 약관 ---------- */
async function renderJoin() {
  const p = await fetch('/api/auth/pending', {cache: 'no-store'}).then(r => r.json()).catch(() => ({pending: false}));
  if (!p.pending) { view.innerHTML = `<section class="band"><div class="wrap narrow"><h1>가입 시간이 지났어요</h1><p class="lead">다시 로그인해 주세요.</p><p><button type="button" class="btn" id="relogin">로그인</button></p></div></section>`; document.getElementById('relogin').onclick = () => openLogin(''); return; }
  view.innerHTML = `<section class="band"><div class="wrap narrow"><h1>거의 다 됐어요</h1>
    <p class="lead mute">채팅방에서 쓸 닉네임을 정하고 동의해 주세요.</p>
    <form id="joinf" class="joinf" novalidate>
      <label class="fld"><span>닉네임 <small class="mute">한글·영문·숫자 2~12자</small></span>
        <input id="jn" name="nick" maxlength="12" autocomplete="off" value="${esc(p.suggest || '')}" required><small id="jn-msg" class="hint" aria-live="polite"></small></label>
      <label class="chk"><input type="checkbox" id="ja"> <span><b>만 19세 이상</b>이에요 (필수)</span></label>
      <label class="chk"><input type="checkbox" id="jt"> <span><a href="/terms" target="_blank">이용약관</a>과 <a href="/privacy" target="_blank">개인정보 처리방침</a>에 동의해요 (필수)</span></label>
      <p id="j-err" class="err" role="alert"></p>
      <button class="btn big" type="submit">가입 완료</button>
    </form></div></section>`;
  const nick = document.getElementById('jn'), msg = document.getElementById('jn-msg');
  let t;
  const check = () => { clearTimeout(t); t = setTimeout(async () => {
    const v = nick.value.trim(); if (!v) { msg.textContent = ''; return; }
    const r = await fetch('/api/auth/nick?n=' + encodeURIComponent(v)).then(x => x.json()).catch(() => null);
    if (r) { msg.textContent = r.ok ? '쓸 수 있는 닉네임이에요' : r.why; msg.className = 'hint ' + (r.ok ? 'ok' : 'bad'); }
  }, 350); };
  nick.oninput = check; check();
  document.getElementById('joinf').onsubmit = async ev => {
    ev.preventDefault();
    const err = document.getElementById('j-err'); err.textContent = '';
    const r = await fetch('/api/auth/join', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({nick: nick.value.trim(), adult: document.getElementById('ja').checked, terms: document.getElementById('jt').checked})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = j.error || '가입하지 못했어요.'; return; }
    location.replace('/#'); location.reload();
  };
}

/* ---------- 이용약관 · 개인정보 처리방침 ---------- */
const CONTACT = 'danielyarn87@gmail.com';   // 문의 이메일 (사용자가 공개로 정함 2026-11-26)
const CONTACT_HTML = CONTACT ? `<a href="mailto:${CONTACT}">${CONTACT}</a>` : '채팅방 운영자에게 남겨 주세요';
const POLICY = {
  about: ['RAISE 소개', `
<p class="lead">RAISE는 AI 분석가 4명이 축구 경기를 각자 분석하고 토론해서, 경기의 흐름과 가능성을 정리해 보여 주는 스포츠 분석 사이트입니다.</p>
<h2>무엇을 보여 주나요</h2><ul>
<li><b>경기 분석</b>: 경기마다 승·무·패와 골 수(언더·오버) 가능성, 그렇게 본 이유</li>
<li><b>실시간 스코어</b>: 경기 중 점수와 진행 시간</li>
<li><b>부상·결장 소식</b>과 최근 경기 흐름</li>
<li><b>분석가 픽</b>: 분석가별 선택과 지난 적중 기록</li>
<li><b>축구 뉴스</b>와 회원 채팅방</li></ul>
<h2>분석가 4명</h2><p>성향이 다른 AI 분석가 4명이 같은 경기를 따로 봅니다. 서로 다른 눈으로 본 의견을 비교하면 한쪽으로 쏠린 판단을 줄일 수 있기 때문입니다.</p><ul>
<li><b>고광렬</b> · 강팀 신뢰형: 전력과 순위를 가장 크게 봅니다</li>
<li><b>고니</b> · 라인업 중시형: 선발 명단과 부상·결장을 먼저 봅니다</li>
<li><b>아귀</b> · 변수 추구형: 일정, 동기, 이변 가능성을 찾습니다</li>
<li><b>호구</b> · 상식형: 많은 사람이 예상하는 쪽을 기준으로 삼습니다</li></ul>
<h2>다루는 리그</h2><p>챔피언스리그, 유로파리그, 프리미어리그, 라리가, 분데스리가, 세리에A, 리그1, K리그, J리그 등 주요 리그의 경기를 매일 업데이트합니다.</p>
<h2>데이터와 분석 방식</h2><p>경기 일정·결과·선수 정보는 축구 데이터 서비스(API-Football)에서 받고, 분석은 AI(Anthropic Claude)가 씁니다. 분석은 하루 두 번, 스코어는 경기 중 수시로 새로 고칩니다.</p>
<h2>꼭 알아 두세요</h2><p>RAISE의 분석은 <b>참고용 정보</b>이며 결과를 보장하지 않습니다. RAISE는 어떤 형태의 도박이나 배팅도 권하지 않고, 도박 사이트를 광고하거나 소개하지 않습니다.</p>
<h2>문의</h2><p>${CONTACT_HTML}</p>
<p class="small mute"><a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></p>`],
  terms: ['이용약관', `
<h2>1. 서비스</h2><p>RAISE(raise-fulltime.com)는 AI 분석가가 축구 경기를 분석한 <b>참고용 정보</b>와 실시간 스코어, 채팅방을 제공합니다. 분석은 결과를 보장하지 않으며, 어떤 형태의 도박이나 배팅도 권하지 않습니다.</p>
<h2>2. 회원</h2><p>만 19세 이상만 가입할 수 있습니다. 카카오 또는 구글 계정으로 가입하며, 한 사람이 여러 계정을 만들어 운영을 방해해서는 안 됩니다. 회원은 언제든 '내 계정 → 회원 탈퇴'로 탈퇴할 수 있습니다.</p>
<h2>3. 채팅방 이용 규칙</h2><ul><li>불법 도박·사설 토토 사이트 홍보, 링크·연락처·메신저 아이디 공유 금지</li><li>욕설·비방·차별·음란한 내용, 다른 사람의 개인정보 공개 금지</li><li>같은 글 반복(도배) 금지 · 3초에 한 번만 보낼 수 있습니다</li></ul>
<p>규칙을 어기면 운영자가 글을 가리거나 채팅을 제한할 수 있습니다. 불법 도박 홍보는 경고 없이 제한합니다.</p>
<h2>4. 대화 보관</h2><p>채팅 대화는 1시간이 지나면 자동으로 지워집니다. 신고된 글과 제재 기록은 운영을 위해 30일 동안 보관합니다.</p>
<h2>5. 책임</h2><p>서비스의 분석·통계·점수는 참고용이며, 이를 근거로 한 이용자의 판단과 결과에 대해 RAISE는 책임지지 않습니다. 서비스 내용은 사전 안내 후 바뀔 수 있습니다.</p>
<p class="small mute">시행일: 2026년 11월 26일</p>`],
  privacy: ['개인정보 처리방침', `
<h2>1. 모으는 정보</h2><ul><li>카카오 로그인: 카카오 회원번호, 카카오 닉네임(가입 때 닉네임 추천에만 사용)</li><li>구글 로그인: 구글 회원번호, 이메일, 이름(가입 때 닉네임 추천에만 사용)</li><li>가입 때 직접 입력: RAISE 닉네임, 만 19세 이상 확인, 약관 동의 시각</li><li>이용 중 생기는 정보: 관심 경기 목록, 채팅 내용, 로그인 유지용 정보(쿠키)</li></ul>
<p>비밀번호와 주민등록번호, 휴대폰 번호는 모으지 않습니다.</p>
<h2>2. 쓰는 목적</h2><p>회원 확인과 로그인 유지, 채팅방 운영(닉네임 표시, 규칙 위반 대응), 관심 경기 저장에만 씁니다. 광고 목적으로 쓰거나 다른 곳에 팔지 않습니다.</p>
<h2>3. 보관 기간</h2><ul><li>회원 정보·관심 경기: 탈퇴하면 바로 지웁니다</li><li>채팅 대화: 1시간 뒤 자동 삭제</li><li>신고된 글·제재 기록: 30일 뒤 자동 삭제</li><li>로그인 유지 정보: 30일</li></ul>
<h2>4. 맡기는 곳(처리 위탁)</h2><p>Cloudflare(사이트 운영·정보 저장), 카카오·구글(로그인 확인). 법에 따른 요청이 아니면 다른 곳에 주지 않습니다.</p>
<h2>5. 이용자의 권리</h2><p>언제든 '내 계정 → 회원 탈퇴'로 모든 정보를 지울 수 있습니다. 카카오·구글 쪽 연결은 각 서비스의 '연결된 앱'에서 끊을 수 있습니다.</p>
<h2>6. 광고와 쿠키</h2><p>사이트에는 쿠팡 파트너스 배너가 있으며, 앞으로 Google 애드센스 광고가 실릴 수 있습니다. 광고는 각 광고 회사가 직접 보여 줍니다.</p>
<ul><li>Google을 포함한 제3자 광고 회사는 쿠키를 사용해 이용자가 이 사이트나 다른 사이트를 방문한 기록을 바탕으로 광고를 보여 줄 수 있습니다.</li>
<li>Google의 광고 쿠키 사용은 <a href="https://adssettings.google.com" target="_blank" rel="noopener">Google 광고 설정</a>에서 끌 수 있고, 다른 광고 회사의 쿠키는 <a href="https://www.aboutads.info" target="_blank" rel="noopener">www.aboutads.info</a>에서 끌 수 있습니다.</li>
<li>Google이 정보를 쓰는 방식은 <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener">Google 파트너 사이트 정책</a>에서 볼 수 있습니다.</li>
<li>쿠팡 배너를 누르면 쿠팡의 정책이 적용됩니다.</li></ul>
<p>RAISE가 모은 회원 정보는 광고 회사에 넘기지 않습니다.</p>
<h2>7. 문의</h2><p>개인정보 관련 문의: ${CONTACT_HTML}</p>
<p class="small mute">시행일: 2026년 11월 26일</p>`],
};
function renderPolicy(k) {
  const [title, body] = POLICY[k];
  view.innerHTML = `<section class="band"><div class="wrap narrow policy"><h1>${title}</h1>${body}<p><a href="/">← 경기 목록으로</a></p></div></section>`;
  // 안내 페이지 주소(/about 등)로 들어왔으면 제목·대표 주소도 그 페이지로 (검색엔진용)
  if (location.pathname.replace(/^\/+|\/+$/g, '') === k) {
    document.title = `${title} · RAISE 스포츠 분석`;
    const c = document.querySelector('link[rel=canonical]'); if (c) c.href = `${location.origin}/${k}`;
  }
}
// 안내 페이지 주소에서 # 링크(메뉴·로고)를 누르면 첫 주소로 가서 그 화면을 연다
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (!a || !onSubPage()) return;
  e.preventDefault(); location.href = '/' + a.getAttribute('href');
});


/* ---------- 공지사항 · 고객센터 ---------- */
let NOTICES = null;
async function loadNotices(force) {
  if (NOTICES && !force) return NOTICES;
  NOTICES = await fetch('/api/notice', {cache: 'no-store'}).then(r => r.ok ? r.json() : {notices: []}).then(j => j.notices || []).catch(() => []);
  return NOTICES;
}
const kdate = ms => new Date(ms).toLocaleDateString('ko-KR', {year: 'numeric', month: 'long', day: 'numeric'});
const isNew = ms => Date.now() - ms < 3 * 864e5;
function setPageMeta(title, path) {
  document.title = `${title} · RAISE`;
  const c = document.querySelector('link[rel=canonical]'); if (c) c.href = location.origin + path;
}
async function renderNotices() {
  const list = await loadNotices(true);
  setPageMeta('공지사항', '/notice');
  view.innerHTML = `<section class="band"><div class="wrap narrow cs-page">
    <h1>공지사항</h1>
    ${list.length ? `<ul class="nlist">${list.map(n => `<li><a href="/notice/${n.id}">${n.pinned ? '<span class="tag ntag">고정</span>' : ''}<b>${escRaw(n.title)}</b>${isNew(n.created) ? '<span class="newb">새 글</span>' : ''}<small>${kdate(n.created)}</small></a></li>`).join('')}</ul>`
      : '<p class="mute">아직 공지가 없어요.</p>'}
    <p class="small mute"><a href="/help">고객센터</a> · <a href="/">경기 목록</a></p></div></section>`;
}
async function renderNotice(id) {
  const r = await fetch('/api/notice/' + id, {cache: 'no-store'}).then(x => x.ok ? x.json() : null).catch(() => null);
  if (!r || !r.notice) { view.innerHTML = '<section class="band"><div class="wrap narrow"><h1>없는 공지예요</h1><p><a href="/notice">공지사항 목록</a></p></div></section>'; return; }
  const n = r.notice;
  setPageMeta(n.title, '/notice/' + id);
  view.innerHTML = `<section class="band"><div class="wrap narrow cs-page">
    <p class="small mute"><a href="/notice">공지사항</a></p>
    <h1 class="ntitle">${escRaw(n.title)}</h1><p class="small mute">${kdate(n.created)}${n.updated > n.created + 6e4 ? ` · 고침 ${kdate(n.updated)}` : ''}</p>
    <div class="nbody">${textHtml(n.body)}</div>
    <p><a class="btn ghost" href="/notice">목록으로</a></p></div></section>`;
}
const FAQ = [
  ['RAISE는 어떤 사이트인가요?', 'AI 분석가 4명이 축구 경기를 각자 분석하고 토론해서 승·무·패와 골 수 가능성을 보여 주는 스포츠 분석 사이트예요. 자세한 내용은 사이트 소개에 있어요.'],
  ['가입은 어떻게 하나요?', '오른쪽 위 로그인 버튼을 눌러 카카오나 구글로 로그인하고 닉네임을 정하면 끝나요. 만 19세 이상만 가입할 수 있어요.'],
  ['회원이 되면 무엇이 좋나요?', '채팅방에서 대화할 수 있고, 경기 시간 앞 ☆을 눌러 관심 경기를 모아 볼 수 있어요. 관심 경기는 계정에 저장돼서 폰과 PC에서 똑같이 보여요.'],
  ['닉네임을 바꾸고 싶어요.', '지금은 직접 바꾸는 기능이 없어요. 아래 1:1 문의로 원하는 닉네임을 남겨 주시면 바꿔 드릴게요.'],
  ['탈퇴는 어떻게 하나요?', '오른쪽 위 내 닉네임 → 회원 탈퇴를 누르면 바로 탈퇴돼요. 닉네임과 관심 경기가 모두 지워지고 되돌릴 수 없어요.'],
  ['채팅이 안 써져요.', '채팅은 회원만 쓸 수 있고, 3초에 한 번까지 보낼 수 있어요. 링크나 전화번호는 가려지고, 운영 정책을 어기면 채팅이 제한될 수 있어요.'],
  ['분석은 언제 올라오나요?', '하루 두 번(오전 6시, 오후 2시쯤) 새 경기를 분석해요. 스코어는 경기 중에 수시로 새로 고쳐요.'],
  ['분석대로 결과가 나오나요?', 'RAISE의 분석은 참고용 정보이며 결과를 보장하지 않아요. RAISE는 어떤 형태의 도박이나 배팅도 권하지 않아요.'],
  ['광고나 제휴 문의는 어디로 하나요?', `1:1 문의에서 "광고·제휴"를 고르거나 ${CONTACT ? `<a href="mailto:${CONTACT}">${CONTACT}</a>` : '운영 메일'}로 보내 주세요. 도박·배팅 관련 광고는 받지 않아요.`],
];
async function renderHelp() {
  setPageMeta('고객센터', '/help');
  const member = MEMBER && ME.user;
  let my = {inquiries: [], kinds: ['오류 신고', '계정', '제안', '광고·제휴', '기타']};
  if (member) my = await fetch('/api/inquiry', {cache: 'no-store'}).then(r => r.ok ? r.json() : my).catch(() => my);
  const inq = q => `<article class="inq${q.answer ? ' done' : ''}"><div class="inq-top"><span class="tag">${escRaw(q.kind)}</span><span class="tag ${q.answer ? 'mg-ok' : 'mg-wait'}">${q.answer ? '답변 완료' : '답변 기다리는 중'}</span>${q.answer && !q.seen ? '<span class="newb">새 답변</span>' : ''}<small class="mute">${kdate(q.created)}</small></div>
    <b class="inq-t">${escRaw(q.title)}</b><p class="inq-b">${textHtml(q.body)}</p>
    ${q.answer ? `<div class="inq-a"><b>운영자 답변</b> <small class="mute">${kdate(q.answered_at)}</small><p>${textHtml(q.answer)}</p></div>` : ''}</article>`;
  view.innerHTML = `<section class="band"><div class="wrap narrow cs-page">
    <h1>고객센터</h1>
    <p class="lead mute">자주 묻는 질문을 먼저 확인해 주세요. 해결되지 않으면 1:1 문의를 남겨 주세요.</p>
    <h2>자주 묻는 질문</h2>
    <div class="faq">${FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div>
    <h2 id="my">1:1 문의</h2>
    ${member ? `<form class="inq-form" novalidate>
        <label>문의 종류<select name="kind">${my.kinds.map(k => `<option>${k}</option>`).join('')}</select></label>
        <label>제목<input name="title" maxlength="60" placeholder="예: 관심 경기가 폰에서 안 보여요" required></label>
        <label>내용<textarea name="body" rows="5" maxlength="2000" placeholder="어떤 화면에서 무엇을 했는지 적어 주시면 빨리 확인할 수 있어요." required></textarea></label>
        <p class="inq-err" role="alert"></p>
        <button class="btn">문의 남기기</button></form>
      <h3>내 문의</h3>
      <div class="inq-list">${my.inquiries.length ? my.inquiries.map(inq).join('') : '<p class="mute">남긴 문의가 없어요.</p>'}</div>`
    : `<div class="inq-guest"><p>1:1 문의는 회원만 남길 수 있어요. 답변을 사이트 안에서 바로 확인할 수 있어요.</p>
        ${MEMBER ? '<button type="button" class="btn" id="helpLogin">로그인 · 회원가입</button>' : ''}
        ${CONTACT ? `<p class="small mute">회원이 아니면 <a href="mailto:${CONTACT}">${CONTACT}</a>로 보내 주세요.</p>` : ''}</div>`}
    <p class="small mute"><a href="/notice">공지사항</a> · <a href="/about">사이트 소개</a> · <a href="/terms">이용약관</a> · <a href="/privacy">개인정보 처리방침</a></p>
  </div></section>`;
  const lb = document.getElementById('helpLogin'); if (lb) lb.onclick = () => openLogin('1:1 문의는 회원 전용 기능이에요.');
  if (location.hash === '#my' || location.hash === '') { const t = location.hash === '#my' && document.getElementById('my'); if (t) t.scrollIntoView(); }
  if (member && my.inquiries.some(q => q.answer && !q.seen)) {   // 새 답변 읽음 처리 → 계정 버튼 빨간 점 끄기
    fetch('/api/inquiry/seen', {method: 'POST'}).catch(() => null);
    ME.user.unread = 0; drawAccount();
  }
  const f = view.querySelector('.inq-form');
  if (f) {
    const err = f.querySelector('.inq-err');
    f.oninput = () => { err.textContent = ''; };
    f.onsubmit = async e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      if (d.title.trim().length < 2) { err.textContent = '제목을 2자 이상 써 주세요.'; return; }
      if (d.body.trim().length < 5) { err.textContent = '내용을 5자 이상 써 주세요.'; return; }
      const btn = f.querySelector('button'); btn.disabled = true;
      const r = await fetch('/api/inquiry', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(d)}).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { err.textContent = j.error || '보내지 못했어요. 잠시 뒤 다시 해 주세요.'; btn.disabled = false; return; }
      toast('문의를 남겼어요. 답변이 달리면 닉네임 옆에 빨간 점이 떠요.');
      renderHelp();
    };
  }
}
/* 첫 화면 위 공지 띠 (운영자가 '띠로 알리기'를 켠 공지 하나, 닫으면 그 공지는 다시 안 보임) */
async function noticeBar() {
  if (!MEMBER || document.getElementById('nbar')) return;
  const n = (await loadNotices()).find(x => x.banner);
  if (!n || store.get('aa_nb') === String(n.id)) return;
  const el = document.createElement('div');
  el.id = 'nbar'; el.className = 'nbar';
  el.innerHTML = `<a href="/notice/${n.id}"><b>공지</b><span>${escRaw(n.title)}</span><i aria-hidden="true">›</i></a><button type="button" aria-label="공지 닫기">×</button>`;
  el.querySelector('button').onclick = () => { store.set('aa_nb', String(n.id)); el.remove(); };
  const w = view.querySelector('.wrap');
  if (document.getElementById('nbar') || !w) return;
  w.prepend(el);   // 목록 맨 위, 목록과 같은 폭 (운세·로또 카드·오른쪽 배너와 겹치지 않게)
}
/* 채팅방 위: 띠 공지가 있으면 제목 한 줄 */
async function chatNotice() {
  const box = document.querySelector('#chat .ch-n'); if (!box || box.dataset.n) return;
  const n = (await loadNotices()).find(x => x.banner); box.dataset.n = '1';
  if (n) box.insertAdjacentHTML('beforeend', `<a class="ch-pin" href="/notice/${n.id}">공지 · ${escRaw(n.title)}</a>`);
}

/* ---------- 회원 관리 (운영자 주소에서만) ---------- */
let memTab = 'list', memQ = '', memArm = '', memInqDone = false, memEdit = null;   // memEdit: 고치는 중인 공지   // memArm: 강제 탈퇴 확인 대기 중인 회원 번호
const mapi = async (path, body) => {
  const r = await fetch(path, body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {cache: 'no-store'});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '처리하지 못했어요.');
  return j;
};
const kdt = ms => ms ? new Date(ms).toLocaleString('ko-KR', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}) : '—';
const kd = ms => ms ? new Date(ms).toLocaleDateString('ko-KR', {year: '2-digit', month: 'numeric', day: 'numeric'}) : '—';
const BAN_DAYS = [[1, '1일'], [7, '7일'], [30, '30일'], [0, '영구']];
async function renderMembers() {
  if (!OPERATOR) { location.replace('#'); return; }
  view.innerHTML = '<section class="band"><div class="wrap"><h1>회원 관리</h1><p class="loading">불러오는 중…</p></div></section>';
  const [d, rp, iq, nt] = await Promise.all([mapi('/api/members' + (memQ ? '?q=' + encodeURIComponent(memQ) : '')), mapi('/api/members/reports').catch(() => ({reports: [], bans: []})),
    mapi('/api/inquiry/all?state=' + (memInqDone ? 'done' : 'open')).catch(() => ({inquiries: [], open: 0})),
    memTab === 'notice' ? loadNotices(true) : Promise.resolve([])]);
  const s = d.summary || {};
  const nickOf = Object.fromEntries(d.users.map(u => [String(u.id), u.nick]));
  const who = r => r === 'admin' ? '운영자' : r === 'admin-hide' ? '운영자 가림' : r === 'admin-ban' ? '운영자 제한' : (nickOf[r] || '회원 ' + r);
  const userReports = (rp.reports || []).filter(r => !String(r.reporter).startsWith('admin-'));
  const open = userReports.filter(r => !r.done).length;
  const stat = (n, t, sub = '') => `<div class="mg-stat"><b class="num">${esc(n ?? 0)}</b><span>${t}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const banTag = u => { const b = d.bans[String(u.id)]; return b ? `<span class="tag mg-ban">채팅 제한 · ${b.until > Date.now() + 3650 * 864e5 ? '영구' : kd(b.until) + '까지'}</span>` : '<span class="tag mg-ok">정상</span>'; };
  const card = u => { const b = d.bans[String(u.id)]; return `<article class="mg-card" data-uid="${u.id}" data-nick="${esc(u.nick)}">
    <div class="mg-top"><b class="mg-nick">${esc(u.nick)}</b><span class="tag mg-${u.provider}">${u.provider === 'kakao' ? '카카오' : '구글'}</span>${banTag(u)}</div>
    <dl class="mg-meta"><div><dt>가입</dt><dd>${kd(u.created)}</dd></div><div><dt>최근 접속</dt><dd>${kdt(u.last_login)}</dd></div><div><dt>관심 경기</dt><dd>☆ ${esc(u.favs)}</dd></div>${u.email ? `<div class="em"><dt>이메일</dt><dd>${esc(u.email)}</dd></div>` : ''}</dl>
    <div class="mg-act">${b ? '<button class="btn sm ghost" data-unban>제한 해제</button>'
      : `<span class="mg-lbl">채팅 제한</span>${BAN_DAYS.map(([v, t]) => `<button class="btn sm ghost" data-ban="${v}">${t}</button>`).join('')}`}
      <button class="btn sm ${memArm === String(u.id) ? 'mg-danger on' : 'ghost mg-danger'}" data-del>${memArm === String(u.id) ? '정말 탈퇴시키기' : '강제 탈퇴'}</button></div>
    ${memArm === String(u.id) ? '<p class="mg-warn">회원 정보·관심 경기·로그인이 모두 지워지고 되돌릴 수 없어요. 한 번 더 누르면 탈퇴돼요.</p>' : ''}</article>`; };
  const rcard = r => `<article class="mg-card mg-rep${r.done ? ' done' : ''}" data-rid="${r.id}" data-mid="${r.msg_id}" data-uid="${esc(r.uid)}" data-nick="${esc(r.nick)}">
    <div class="mg-top"><b class="mg-nick">${esc(r.nick || '알 수 없음')}</b><span class="tag ${r.done ? 'mg-ok' : 'mg-ban'}">${r.done ? '처리함' : '처리 전'}</span><small class="mute">${kdt(r.ts)} · 신고 ${esc(who(String(r.reporter)))}</small></div>
    <p class="mg-text">${esc(r.text || '')}</p>
    <div class="mg-act">${r.done ? '<button class="btn sm ghost" data-undo>처리 전으로</button>' : `<button class="btn sm ghost" data-hide>글 가리기</button><button class="btn sm ghost" data-rban>7일 제한</button><button class="btn sm" data-done>처리 완료</button>`}</div></article>`;
  const logs = (rp.reports || []).filter(r => String(r.reporter).startsWith('admin-'));
  view.innerHTML = `<section class="band"><div class="wrap mg">
    <h1>회원 관리</h1>
    <div class="mg-stats">${stat(s.total, '전체 회원', `카카오 ${s.kakao || 0} · 구글 ${s.google || 0}`)}${stat(s.today, '오늘 가입', `7일 ${s.week || 0}`)}${stat(s.active_today, '오늘 접속')}${stat(s.chatsToday, '오늘 채팅', `지금 ${s.online || 0}명 접속`)}${stat(open, '처리 전 신고')}${stat(iq.open, '답변 전 문의')}</div>
    <div class="segbar mg-tabs" role="group" aria-label="회원 관리 보기"><button class="seg" data-tab="list" aria-pressed="${memTab === 'list'}">회원 목록</button><button class="seg" data-tab="rep" aria-pressed="${memTab === 'rep'}">신고함${open ? ` (${open})` : ''}</button><button class="seg" data-tab="log" aria-pressed="${memTab === 'log'}">제재 기록</button><button class="seg" data-tab="inq" aria-pressed="${memTab === 'inq'}">1:1 문의${iq.open ? ` (${iq.open})` : ''}</button><button class="seg" data-tab="notice" aria-pressed="${memTab === 'notice'}">공지 관리</button></div>
    ${memTab === 'list' ? `<form class="mg-search" role="search"><input id="mgq" type="search" placeholder="닉네임 검색" value="${esc(memQ)}" aria-label="닉네임 검색"><button class="btn sm">찾기</button></form>
      <p class="small mute">${memQ ? `"${esc(memQ)}" ` : ''}${d.users.length}명 · 최근 가입 순 · 이메일은 앞 두 글자만 보여요</p>
      <div class="mg-list">${d.users.map(card).join('') || '<p class="mute">아직 가입한 회원이 없어요.</p>'}</div>`
    : memTab === 'rep' ? `<p class="small mute">회원이 신고한 채팅 글 (30일 보관). 1시간이 지나 채팅방에서 지워진 글은 가리기가 필요 없어요.</p>
      <div class="mg-list">${userReports.map(rcard).join('') || '<p class="mute">들어온 신고가 없어요.</p>'}</div>`
    : memTab === 'inq' ? `<div class="segbar mg-sub" role="group" aria-label="문의 상태"><button class="seg" data-inq="open" aria-pressed="${!memInqDone}">답변 전</button><button class="seg" data-inq="done" aria-pressed="${memInqDone}">답변 완료</button></div>
      <div class="mg-list mg-one">${iq.inquiries.map(q => `<article class="mg-card" data-qid="${q.id}">
        <div class="mg-top"><b class="mg-nick">${escRaw(q.nick || '')}</b><span class="tag">${escRaw(q.kind)}</span><small class="mute">${kdt(q.created)}</small></div>
        <p class="mg-q"><b>${escRaw(q.title)}</b></p><p class="mg-text">${textHtml(q.body)}</p>
        ${q.answer ? `<div class="inq-a"><b>보낸 답변</b> <small class="mute">${kdt(q.answered_at)}${q.seen ? ' · 회원이 읽음' : ' · 아직 안 읽음'}</small><p>${textHtml(q.answer)}</p></div>` : ''}
        <form class="mg-ans"><textarea rows="3" maxlength="3000" placeholder="답변을 써 주세요. 회원은 고객센터에서 바로 봐요.">${q.answer ? escRaw(q.answer) : ''}</textarea><button class="btn sm">${q.answer ? '답변 고치기' : '답변 보내기'}</button></form></article>`).join('')
        || `<p class="mute">${memInqDone ? '답변한 문의가 없어요.' : '답변 기다리는 문의가 없어요.'}</p>`}</div>`
    : memTab === 'notice' ? `<form class="mg-note" novalidate><h2>${memEdit ? '공지 고치기' : '새 공지 쓰기'}</h2>
        <input name="title" maxlength="80" placeholder="제목" value="${memEdit ? escRaw(memEdit.title) : ''}">
        <textarea name="body" rows="8" maxlength="5000" placeholder="내용. 줄바꿈과 링크(https://…)는 그대로 보여요.">${memEdit ? escRaw(memEdit.body) : ''}</textarea>
        <label class="mg-chk"><input type="checkbox" name="pinned" ${memEdit && memEdit.pinned ? 'checked' : ''}> 목록 맨 위에 고정</label>
        <label class="mg-chk"><input type="checkbox" name="banner" ${memEdit && memEdit.banner ? 'checked' : ''}> 첫 화면 띠와 채팅방 위에 알리기 (하나만, 켜면 다른 공지의 띠는 꺼져요)</label>
        <p class="inq-err" role="alert"></p>
        <div class="mg-act"><button class="btn">${memEdit ? '고친 내용 저장' : '공지 올리기'}</button>${memEdit ? '<button type="button" class="btn ghost" data-new>새로 쓰기</button>' : ''}</div></form>
      <div class="mg-list mg-one">${nt.map(n => `<article class="mg-card" data-nid="${n.id}"><div class="mg-top"><b class="mg-nick">${escRaw(n.title)}</b>${n.pinned ? '<span class="tag ntag">고정</span>' : ''}${n.banner ? '<span class="tag mg-ok">띠 알림</span>' : ''}<small class="mute">${kdt(n.created)}</small></div>
        <div class="mg-act"><a class="btn sm ghost" href="/notice/${n.id}" target="_blank">보기</a><button class="btn sm ghost" data-edit>고치기</button><button class="btn sm ${memArm === 'n' + n.id ? 'mg-danger on' : 'ghost mg-danger'}" data-ndel>${memArm === 'n' + n.id ? '정말 지우기' : '지우기'}</button></div></article>`).join('') || '<p class="mute">올린 공지가 없어요.</p>'}</div>`
    : `<p class="small mute">운영자가 가리거나 제한한 기록 (30일 보관)</p>
      <div class="mg-list">${logs.map(r => `<article class="mg-card"><div class="mg-top"><b class="mg-nick">${esc(r.nick || '')}</b><span class="tag">${esc(who(String(r.reporter)))}</span><small class="mute">${kdt(r.ts)}</small></div><p class="mg-text">${esc(r.text || '')}</p></article>`).join('') || '<p class="mute">기록이 없어요.</p>'}</div>`}
  </div></section>`;
  view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { memTab = b.dataset.tab; memArm = ''; memEdit = null; renderMembers(); });
  view.querySelectorAll('[data-inq]').forEach(b => b.onclick = () => { memInqDone = b.dataset.inq === 'done'; renderMembers(); });
  view.querySelectorAll('.mg-ans').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    const answer = f.querySelector('textarea').value.trim();
    if (!answer) { toast('답변을 써 주세요.'); return; }
    try { await mapi('/api/inquiry/answer', {id: +f.closest('.mg-card').dataset.qid, answer}); toast('답변을 보냈어요.'); renderMembers(); } catch (err) { toast(err.message); }
  });
  const nf = view.querySelector('.mg-note');
  if (nf) {
    const err = nf.querySelector('.inq-err');
    nf.oninput = () => { err.textContent = ''; };
    const nw = nf.querySelector('[data-new]'); if (nw) nw.onclick = () => { memEdit = null; renderMembers(); };
    nf.onsubmit = async e => {
      e.preventDefault();
      const title = nf.elements.title.value.trim(), body = nf.elements.body.value.trim();
      if (!title) { err.textContent = '제목을 써 주세요.'; return; }
      if (!body) { err.textContent = '내용을 써 주세요.'; return; }
      try {
        await mapi('/api/notice/save', {id: memEdit && memEdit.id, title, body, pinned: nf.elements.pinned.checked, banner: nf.elements.banner.checked});
        toast(memEdit ? '공지를 고쳤어요.' : '공지를 올렸어요.'); memEdit = null; NOTICES = null; renderMembers();
      } catch (er) { err.textContent = er.message; }
    };
  }
  const f = view.querySelector('.mg-search');
  if (f) f.onsubmit = e => { e.preventDefault(); memQ = view.querySelector('#mgq').value.trim(); renderMembers(); };
  view.querySelectorAll('.mg-list').forEach(l => l.onclick = async e => {
    const b = e.target.closest('button'); if (!b || b.closest('form')) return;
    const c = b.closest('.mg-card'); const uid = c.dataset.uid, nick = c.dataset.nick;
    if (b.hasAttribute('data-edit')) {
      const r = await mapi('/api/notice/' + c.dataset.nid).catch(err => { toast(err.message); return null; });
      if (r) { memEdit = r.notice; renderMembers().then(() => view.querySelector('.mg-note').scrollIntoView({block: 'start'})); }
      return;
    }
    if (b.hasAttribute('data-ndel')) {
      if (memArm !== 'n' + c.dataset.nid) { memArm = 'n' + c.dataset.nid; return renderMembers(); }
      memArm = ''; try { await mapi('/api/notice/delete', {id: +c.dataset.nid}); toast('공지를 지웠어요.'); NOTICES = null; } catch (err) { toast(err.message); }
      return renderMembers();
    }
    b.disabled = true;
    try {
      if (b.hasAttribute('data-ban')) { const days = +b.dataset.ban; await mapi('/api/members/ban', {uid, nick, days}); toast(`${nick} 님 채팅을 ${days ? days + '일' : '영구'} 제한했어요.`); }
      else if (b.hasAttribute('data-unban')) { await mapi('/api/members/unban', {uid}); toast(`${nick} 님 제한을 풀었어요.`); }
      else if (b.hasAttribute('data-del')) {
        if (memArm !== uid) { memArm = uid; return renderMembers(); }
        memArm = ''; await mapi('/api/members/delete', {uid}); toast(`${nick} 님을 탈퇴 처리했어요.`);
      }
      else if (b.hasAttribute('data-hide')) { const r = await mapi('/api/members/hide', {id: +c.dataset.mid}); toast(r.found ? '글을 가렸어요.' : '이미 채팅방에서 지워진 글이에요.'); }
      else if (b.hasAttribute('data-rban')) { await mapi('/api/members/ban', {uid, nick, days: 7}); await mapi('/api/members/done', {id: +c.dataset.rid}); toast(`${nick} 님 채팅을 7일 제한했어요.`); }
      else if (b.hasAttribute('data-done')) await mapi('/api/members/done', {id: +c.dataset.rid});
      else if (b.hasAttribute('data-undo')) await mapi('/api/members/done', {id: +c.dataset.rid, undo: true});
      renderMembers();
    } catch (err) { toast(err.message); b.disabled = false; }
  });
}

/* ---------- 실시간 채팅방 ---------- */
const Chat = {
  ws: null, tries: 0, open: false, unread: 0, me: {role: 'guest'}, list: [], online: 0, ok: false,
  isWide: () => matchMedia('(min-width:1100px)').matches,
  build() {
    if (!(MEMBER || OPERATOR) || document.getElementById('chat')) return;
    const el = document.createElement('aside');
    el.id = 'chat'; el.className = 'chat'; el.setAttribute('aria-label', '실시간 채팅');
    el.innerHTML = `<div class="ch-h"><div><span class="live" aria-hidden="true"></span><b>실시간 채팅</b> <small class="ch-on"></small></div>
      <div class="ch-hb"><button type="button" class="ch-min" aria-label="채팅 접기" title="접기">◀</button><button type="button" class="ch-x" aria-label="채팅 닫기">×</button></div></div>
      <div class="ch-n">분석은 예측일 뿐이에요 · 돈 거는 이야기·링크·홍보는 제재돼요 · 불법 도박 홍보는 즉시 차단</div>
      <div class="ch-l" aria-live="polite"><p class="ch-sys">채팅방에 연결하는 중…</p></div>
      <p class="ch-flash" role="status"></p>
      <div class="ch-f"></div>`;
    document.body.appendChild(el);
    const fab = document.createElement('button');
    fab.type = 'button'; fab.id = 'chatFab'; fab.className = 'chat-fab'; fab.innerHTML = '💬 채팅<i hidden></i>';
    document.body.appendChild(fab);
    const tab = document.createElement('button');
    tab.type = 'button'; tab.id = 'chatTab'; tab.className = 'chat-tab'; tab.innerHTML = '💬<span>채팅</span><i hidden></i>'; tab.setAttribute('aria-label', '채팅 펼치기');
    document.body.appendChild(tab);
    fab.onclick = () => this.show(true);
    tab.onclick = () => { store.set('aa_chat_min', ''); this.layout(); };
    el.querySelector('.ch-x').onclick = () => this.show(false);
    el.querySelector('.ch-min').onclick = () => { store.set('aa_chat_min', '1'); this.layout(); };
    el.querySelector('.ch-l').addEventListener('click', e => this.onListClick(e));
    addEventListener('resize', () => this.layout());
    const hdr = document.querySelector('.top');
    const setTop = () => document.documentElement.style.setProperty('--toph', (hdr ? hdr.getBoundingClientRect().height : 60) + 'px');
    setTop(); addEventListener('resize', setTop);
    this.drawFoot(); this.layout();
    if (ME.ready && ME.ready.chat === false) this.status('채팅방 오픈 준비 중이에요. 곧 열려요!'); else this.connect();
  },
  layout() {
    const wide = this.isWide(), min = !!store.get('aa_chat_min');
    const el = document.getElementById('chat'); if (!el) return;
    document.body.classList.toggle('chat-dock', wide && !min);
    el.classList.toggle('chdock', wide && !min);
    el.classList.toggle('chsheet', !wide);
    el.hidden = wide ? min : !this.open;
    document.getElementById('chatTab').hidden = !(wide && min);
    document.getElementById('chatFab').hidden = wide || this.open;
    if (!el.hidden) { this.unread = 0; this.badge(); this.scroll(true); }
  },
  show(on) { this.open = on; this.layout(); if (on) { const i = document.querySelector('#chat .ch-f input'); if (i && this.isWide()) i.focus(); } },
  badge() {
    ['#chatFab i', '#chatTab i'].forEach(s => { const i = document.querySelector(s); if (i) { i.hidden = !this.unread; i.textContent = this.unread > 99 ? '99+' : this.unread; } });
  },
  connect() {
    let ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/chat'); } catch (e) { return this.status('채팅방 준비 중이에요.'); }
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; this.ok = true; };
    ws.onmessage = ev => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } this.on(d); };
    ws.onclose = () => {
      this.ok = false;
      if (this.tries === 0 && !this.list.length) this.status('채팅방 준비 중이에요. 잠시 후 다시 연결할게요.');
      const wait = Math.min(30000, 3000 * 2 ** this.tries++);
      setTimeout(() => this.connect(), wait);
    };
  },
  status(t) { const l = document.querySelector('#chat .ch-l'); if (l && !this.list.length) l.innerHTML = `<p class="ch-sys">${esc(t)}</p>`; },
  flash(t, bad) { const f = document.querySelector('#chat .ch-flash'); if (!f) return; f.textContent = t; f.className = 'ch-flash on' + (bad ? ' bad' : ''); clearTimeout(f._h); f._h = setTimeout(() => f.className = 'ch-flash', 2800); },
  on(d) {
    if (d.t === 'hello') {
      this.me = d.me || {role: 'guest'}; this.list = d.msgs || []; this.drawList(); this.drawFoot();
      clearInterval(this.ageT); this.ageT = setInterval(() => this.prune(), 60e3);   // 열어 둔 화면에서도 1시간 지난 대화는 1분 안에 사라짐
    }
    else if (d.t === 'msg') {
      this.list.push(d.m); if (this.list.length > 300) this.list.shift();
      const l = document.querySelector('#chat .ch-l'); const atEnd = l && l.scrollHeight - l.scrollTop - l.clientHeight < 60;
      if (l) { const sys = l.querySelector('.ch-sys.wait'); if (sys) sys.remove(); l.insertAdjacentHTML('beforeend', this.item(d.m)); }
      const el = document.getElementById('chat');
      if (el && el.hidden && d.m.nick !== this.me.nick) { this.unread++; this.badge(); }
      if (atEnd || d.m.nick === this.me.nick) this.scroll(true);
    }
    else if (d.t === 'hide' || d.t === 'hideMany') {
      const ids = d.t === 'hide' ? [d.id] : d.ids;
      this.list.forEach(m => { if (ids.includes(m.id)) m.hidden = true; });
      ids.forEach(id => { const n = document.querySelector(`#chat [data-mid="${id}"]`); if (n) n.outerHTML = this.item(this.list.find(m => m.id === id) || {id, hidden: true}); });
    }
    else if (d.t === 'online') { this.online = d.n; const o = document.querySelector('#chat .ch-on'); if (o) o.textContent = `접속 ${d.n}명`; }
    else if (d.t === 'err') this.flash(d.msg, true);
    else if (d.t === 'ok') this.flash(d.msg);
  },
  prune() {
    const cut = Date.now() - 3600e3, old = this.list.filter(m => m.ts && m.ts < cut);
    if (!old.length) return;
    this.list = this.list.filter(m => !(m.ts && m.ts < cut));
    old.forEach(m => { const n = document.querySelector(`#chat [data-mid="${m.id}"]`); if (n) n.remove(); });
    if (!this.list.length) this.drawList();
  },
  item(m) {
    const admin = this.me.role === 'admin';
    if (m.hidden && !admin) return `<div class="m hid" data-mid="${m.id}"><div class="txt">관리자가 가린 메시지예요</div></div>`;
    const mine = m.nick && m.nick === this.me.nick;
    const t = new Date(m.ts).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul'});
    const op = m.role === 'admin';
    const tools = admin && !op ? `<span class="tools"><button type="button" data-act="hide">가리기</button><button type="button" data-act="ban">차단</button></span>`
      : (!mine && !op && this.me.role !== 'guest') ? `<button type="button" class="rp" data-act="report">신고</button>` : '';
    return `<div class="m${mine ? ' me' : ''}${op ? ' op' : ''}${m.hidden ? ' wasHid' : ''}" data-mid="${m.id}">
      <div class="who">${op ? '<b class="opname">👑 운영자</b>' : `<b>${esc(m.nick || '')}</b>`}<span>${t}</span>${tools}</div>
      <div class="txt">${esc(m.text || '')}${m.hidden ? ' <small>(가림)</small>' : ''}</div></div>`;
  },
  drawList() {
    const l = document.querySelector('#chat .ch-l'); if (!l) return;
    l.innerHTML = `<p class="ch-sys">1시간 지난 대화는 자동으로 지워져요</p>`
      + (this.list.length ? this.list.map(m => this.item(m)).join('') : '<p class="ch-sys wait">아직 대화가 없어요. 첫 마디를 남겨 보세요!</p>');
    this.scroll(true);
  },
  drawFoot() {
    const f = document.querySelector('#chat .ch-f'); if (!f) return;
    if (this.me.role === 'guest') {
      f.innerHTML = `<div class="ch-lock">채팅은 회원만 쓸 수 있어요. 읽기는 누구나 가능해요.<br><button type="button" class="ch-join">로그인 · 회원가입</button></div>`;
      f.querySelector('.ch-join').onclick = () => openLogin('채팅은 회원만 쓸 수 있어요');
      return;
    }
    if (this.me.banned) { f.innerHTML = '<div class="ch-lock">운영 정책 위반으로 채팅이 제한된 상태예요.</div>'; return; }
    f.innerHTML = `<form class="ch-in"><input maxlength="200" placeholder="메시지 입력 (링크·전화번호는 자동으로 가려져요)" aria-label="메시지"><button type="submit">보내기</button></form>
      <div class="ch-meta"><span>${this.me.role === 'admin' ? '👑 운영자로 말하는 중' : '닉네임: ' + esc(this.me.nick || '')}</span><span>3초에 1번</span></div>`;
    f.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const i = f.querySelector('input'), v = i.value.trim();
      if (!v) return;
      if (!this.ws || this.ws.readyState !== 1) return this.flash('연결이 끊겼어요. 잠시 후 다시 보내 주세요.', true);
      this.ws.send(JSON.stringify({t: 'say', text: v})); i.value = '';
    };
  },
  onListClick(e) {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = Number(b.closest('[data-mid]').dataset.mid), act = b.dataset.act;
    if (act === 'report' && !confirm('이 메시지를 신고할까요?')) return;
    if (act === 'ban') {
      const days = prompt('며칠 동안 채팅을 막을까요? (1~365)', '7'); if (!days) return;
      return this.ws && this.ws.send(JSON.stringify({t: 'ban', id, days: Number(days)}));
    }
    this.ws && this.ws.send(JSON.stringify({t: act, id}));
  },
  scroll(force) { const l = document.querySelector('#chat .ch-l'); if (l && force) l.scrollTop = l.scrollHeight; },
};

/* 시작: 회원 상태 받고 → 계정 버튼, ☆, 채팅방 */
(async function startMembers() {
  if (!(MEMBER || OPERATOR)) return;
  try {
    const r = await fetch('/api/me', {cache: 'no-store'});
    if (r.ok) ME = await r.json();
  } catch (e) {}
  if (ME.user) {
    try { const f = await fetch('/api/fav', {cache: 'no-store'}).then(r => r.json()); FAVS = new Set(f.ids || []); } catch (e) {}
  }
  drawAccount();
  const h = location.hash.replace(/^#\/?/, '');
  const onPage = onSubPage();   // 소개·약관·경기 주소면 목록으로 덮지 않음
  if ((!h || h === 'list') && !onPage) renderList().catch(() => {});
  if (subPath() === 'help') renderHelp();   // 회원 상태를 받은 뒤 문의 칸을 다시 그림
  Chat.build(); chatNotice();
})();

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
