// RAISE 실시간 채팅방 (Durable Object 하나 = 채팅방 하나).
//
// 누가 말하는지는 Pages 함수(functions/api/chat.js)가 로그인·운영자 잠금을 확인한 뒤 머리글로 넘긴다:
//   X-Chat-Uid   회원 번호 (비회원은 없음 → 읽기만)
//   X-Chat-Nick  닉네임
//   X-Chat-Role  "member" | "admin" | "guest"
// 이 워커는 바깥 주소가 없어서(workers_dev=false) 이 머리글을 남이 꾸며 보낼 수 없다.
//
// 저장 규칙 (사용자 결정 2026-11-26):
//   - 1시간 지난 대화는 자동 삭제 (10분마다 정리)
//   - 단, 최근 100개는 시간이 지나도 남김 (조용한 시간에도 방이 비어 보이지 않게)
//   - 신고된 메시지·차단 기록은 따로 30일 보관, 운영자만 봄
// 비용: 대기 모드 WebSocket(Hibernation API) — 말이 없을 때는 사용 시간 요금이 붙지 않는다.

const KEEP_MS = 60 * 60e3;          // 1시간
const KEEP_MIN = 100;               // 최근 100개는 남김
const LOG_MS = 30 * 24 * 3600e3;    // 신고·차단 기록 30일
const SWEEP_MS = 10 * 60e3;         // 10분마다 정리
const GAP_MS = 3000;                // 3초에 1번
const MAX_LEN = 200;

// 링크·전화번호·메신저 아이디는 가린다
const LINK = /(https?:\/\/|www\.)\S+|[a-z0-9-]+\.(com|net|org|kr|co|io|me|xyz|top|site|shop|club|vip|bet|cc|tv|link|ly)(\/\S*)?/gi;
const PHONE = /(\+?82[-\s]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}|\b0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}\b/g;
// 불법 도박 홍보로 보이면 아예 올리지 않는다
const PROMO = /(토토사이트|사설토토|먹튀|바카라|카지노|슬롯|홀덤|파워볼|충전\s*\d|가입\s*코드|추천\s*코드|텔레그램|텔레\s*@|카톡\s*@|오픈\s*채팅|꽁머니|입플|첫충|매충|환전)/i;

export default {
  async fetch() { return new Response("Not Found", { status: 404 }); },
};

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, uid TEXT, nick TEXT, role TEXT, text TEXT, hidden INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, msg_id INTEGER, reporter TEXT, uid TEXT, nick TEXT, text TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bans (uid TEXT PRIMARY KEY, nick TEXT, ts INTEGER, until INTEGER, reason TEXT)`);
    this.last = new Map();            // uid → 마지막으로 보낸 시각 (3초 제한)
  }

  who(ws) { return ws.deserializeAttachment() || { role: "guest" }; }

  rows(sql, ...args) { return this.sql.exec(sql, ...args).toArray(); }

  view(m, admin) {
    const v = { id: m.id, ts: m.ts, nick: m.nick, role: m.role, text: m.hidden && !admin ? "" : m.text, hidden: !!m.hidden };
    if (admin) v.uid = m.uid;
    return v;
  }

  history(admin) {
    return this.rows(`SELECT * FROM msgs ORDER BY id DESC LIMIT ${KEEP_MIN}`).reverse().map((m) => this.view(m, admin));
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

  broadcast(make) {
    for (const ws of this.ctx.getWebSockets()) {
      const w = this.who(ws);
      this.send(ws, make(w.role === "admin"));
    }
  }

  online() { this.broadcast(() => ({ t: "online", n: this.ctx.getWebSockets().length })); }

  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = request.headers.get("X-Chat-Role") || "guest";
    const me = { role, uid: request.headers.get("X-Chat-Uid") || null, nick: request.headers.get("X-Chat-Nick") || null };

    // 운영자 전용: 신고·차단 기록 (30일)
    if (url.pathname.endsWith("/reports")) {
      if (role !== "admin") return new Response("Forbidden", { status: 403 });
      return Response.json({
        reports: this.rows(`SELECT * FROM reports ORDER BY id DESC LIMIT 200`),
        bans: this.rows(`SELECT * FROM bans ORDER BY ts DESC LIMIT 200`),
      });
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(me);
    const ban = me.uid && this.rows(`SELECT until FROM bans WHERE uid = ?`, me.uid)[0];
    this.send(server, { t: "hello", me: { nick: me.nick, role: me.role, banned: !!(ban && ban.until > Date.now()) }, msgs: this.history(role === "admin") });
    this.online();
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    const me = this.who(ws);
    const now = Date.now();

    if (d.t === "say") {
      if (me.role === "guest" || !me.uid) return this.send(ws, { t: "err", msg: "채팅은 회원만 쓸 수 있어요." });
      const ban = this.rows(`SELECT until FROM bans WHERE uid = ?`, me.uid)[0];
      if (ban && ban.until > now) return this.send(ws, { t: "err", msg: "운영 정책 위반으로 채팅이 제한된 상태예요." });
      if (me.role !== "admin" && now - (this.last.get(me.uid) || 0) < GAP_MS) return this.send(ws, { t: "err", msg: "3초에 한 번만 보낼 수 있어요." });
      let text = String(d.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN);
      if (!text) return;
      if (me.role !== "admin" && PROMO.test(text)) return this.send(ws, { t: "err", msg: "홍보로 보이는 글은 올릴 수 없어요." });
      if (me.role !== "admin") text = text.replace(LINK, "[링크 가림]").replace(PHONE, "[번호 가림]");
      this.last.set(me.uid, now);
      const row = this.rows(`INSERT INTO msgs (ts, uid, nick, role, text) VALUES (?, ?, ?, ?, ?) RETURNING *`, now, me.uid, me.nick, me.role, text)[0];
      this.broadcast((admin) => ({ t: "msg", m: this.view(row, admin) }));
      await this.ensureAlarm();
      return;
    }

    if (d.t === "report") {
      if (me.role === "guest") return this.send(ws, { t: "err", msg: "신고는 회원만 할 수 있어요." });
      const m = this.rows(`SELECT * FROM msgs WHERE id = ?`, Number(d.id))[0];
      if (!m) return;
      const dup = this.rows(`SELECT id FROM reports WHERE msg_id = ? AND reporter = ?`, m.id, me.uid || "admin")[0];
      if (!dup) this.sql.exec(`INSERT INTO reports (ts, msg_id, reporter, uid, nick, text) VALUES (?, ?, ?, ?, ?, ?)`, now, m.id, me.uid || "admin", m.uid, m.nick, m.text);
      return this.send(ws, { t: "ok", msg: "신고했어요. 운영자가 확인할게요." });
    }

    // 운영자 전용: 가리기 / 차단
    if (me.role !== "admin") return;
    if (d.t === "hide") {
      const m = this.rows(`SELECT * FROM msgs WHERE id = ?`, Number(d.id))[0];
      if (!m) return;
      // 가린 글도 증거로 신고 기록에 남긴다 (30일)
      this.sql.exec(`INSERT INTO reports (ts, msg_id, reporter, uid, nick, text) VALUES (?, ?, 'admin-hide', ?, ?, ?)`, now, m.id, m.uid, m.nick, m.text);
      this.sql.exec(`UPDATE msgs SET hidden = 1 WHERE id = ?`, m.id);
      this.broadcast((admin) => ({ t: "hide", id: m.id }));
      return;
    }
    if (d.t === "ban") {
      const m = this.rows(`SELECT * FROM msgs WHERE id = ?`, Number(d.id))[0];
      if (!m || !m.uid || m.role === "admin") return;
      const days = Math.min(Math.max(Number(d.days) || 7, 1), 365);
      this.sql.exec(`INSERT OR REPLACE INTO bans (uid, nick, ts, until, reason) VALUES (?, ?, ?, ?, ?)`, m.uid, m.nick, now, now + days * 86400e3, String(d.reason || "운영 정책 위반").slice(0, 100));
      this.sql.exec(`INSERT INTO reports (ts, msg_id, reporter, uid, nick, text) VALUES (?, ?, 'admin-ban', ?, ?, ?)`, now, m.id, m.uid, m.nick, m.text);
      this.sql.exec(`UPDATE msgs SET hidden = 1 WHERE uid = ?`, m.uid);
      const gone = this.rows(`SELECT id FROM msgs WHERE uid = ?`, m.uid).map((r) => r.id);
      this.broadcast(() => ({ t: "hideMany", ids: gone }));
      return this.send(ws, { t: "ok", msg: `${m.nick} 님을 ${days}일 동안 채팅 제한했어요.` });
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch (e) {}
    this.online();
  }

  async webSocketError() { this.online(); }

  // 10분마다: 1시간 지난 대화 삭제(최근 100개는 남김), 30일 지난 신고·차단 기록 삭제
  async alarm() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM msgs WHERE ts < ? AND id NOT IN (SELECT id FROM msgs ORDER BY id DESC LIMIT ${KEEP_MIN})`, now - KEEP_MS);
    this.sql.exec(`DELETE FROM reports WHERE ts < ?`, now - LOG_MS);
    this.sql.exec(`DELETE FROM bans WHERE ts < ? AND until < ?`, now - LOG_MS, now);
    const left = this.rows(`SELECT COUNT(*) AS n FROM msgs`)[0].n;
    if (left > 0 || this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }
}
