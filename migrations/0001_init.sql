CREATE TABLE stocks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  market TEXT,
  sector TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  stock_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting','analyzing','completed','failed')),
  investment_style TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  model TEXT,
  prompt_version TEXT,
  schema_version TEXT,
  calculator_version TEXT,
  data_source TEXT,
  ai_mode TEXT,
  snapshot_json TEXT,
  source_metadata_json TEXT,
  missing_data_json TEXT,
  usage_json TEXT,
  estimated_cost_usd REAL,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX idx_runs_code_requested ON analysis_runs (stock_code, requested_at);
CREATE INDEX idx_runs_requested ON analysis_runs (requested_at);

CREATE TABLE analysis_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs (id),
  kind TEXT NOT NULL CHECK (kind IN ('fundamental','technical','supply_demand','financial','overall')),
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, kind)
);
CREATE INDEX idx_reports_run_kind ON analysis_reports (run_id, kind);

CREATE TABLE watchlists (
  stock_code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
