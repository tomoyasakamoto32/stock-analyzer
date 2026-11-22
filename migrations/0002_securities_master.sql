-- 銘柄名・コードの候補検索(オートコンプリート)用の銘柄マスタ。
-- name_key は検索用に正規化した名前(全角半角・大文字小文字・カタカナ/ひらがなの差を吸収)。
CREATE TABLE securities_master (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  market TEXT,
  industry TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_master_name_key ON securities_master (name_key);
