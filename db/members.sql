-- RAISE 회원 저장소 (Cloudflare D1, 이름 raise-members, Pages 바인딩 DB)
-- 비밀번호는 저장하지 않는다 (카카오·구글 로그인). 세션은 토큰의 SHA-256 만 저장.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL UNIQUE,      -- "k:카카오번호" | "g:구글번호"
  nick TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT,                            -- 구글만 (카카오는 받지 않음)
  adult_at INTEGER NOT NULL,             -- 만 19세 이상 확인한 시각
  terms_at INTEGER NOT NULL,             -- 이용약관·개인정보 동의 시각
  created INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  uid INTEGER NOT NULL,
  exp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);
-- 카카오·구글 확인은 끝났지만 닉네임·동의를 아직 안 한 사람 (15분 보관)
CREATE TABLE IF NOT EXISTS pending (
  hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  exp INTEGER NOT NULL
);
-- 관심 경기 (☆)
CREATE TABLE IF NOT EXISTS favs (
  uid INTEGER NOT NULL,
  mid TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (uid, mid)
);
