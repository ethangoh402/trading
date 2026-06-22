CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  size TEXT,
  leverage TEXT,
  entry_price TEXT,
  exit_price TEXT,
  pnl REAL,
  fee REAL,
  open_time INTEGER,
  close_time INTEGER,
  screenshot_key TEXT,
  notes TEXT,
  synced_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_trades_close_time ON trades(close_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
