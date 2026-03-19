-- ============================================================
-- TRADING JOURNAL — PostgreSQL Schema
-- Syncs from Notion via API
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── 1. Journal Day ──────────────────────────────────────────
CREATE TABLE journal_day (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_page_id       TEXT UNIQUE,          -- Notion page ID for sync
  trade_date           DATE NOT NULL,
  instrument           TEXT NOT NULL,        -- e.g. 'NQ', 'ES', 'BTC'
  day_bias             TEXT,                 -- 'bullish' | 'bearish' | 'neutral'

  -- Pre-market
  premarket_analysis   TEXT,
  premarket_chart_url  TEXT,
  news_events          JSONB DEFAULT '[]',   -- [{time, currency, event, actual, forecast}]

  -- Post-market
  postmarket_summary   TEXT,
  key_lesson           TEXT,

  -- Emotion tracking (1=very disciplined, 10=very impulsive)
  emotional_state      SMALLINT CHECK (emotional_state BETWEEN 1 AND 10),
  emotion_tags         TEXT[],              -- e.g. {'patient','FOMO','disciplined'}

  -- Meta
  notion_last_synced   TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_journal_day_date       ON journal_day (trade_date DESC);
CREATE INDEX idx_journal_day_instrument ON journal_day (instrument);
CREATE INDEX idx_journal_day_bias       ON journal_day (day_bias);

-- ── 2. Session ──────────────────────────────────────────────
CREATE TABLE session (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id             UUID NOT NULL REFERENCES journal_day(id) ON DELETE CASCADE,
  session_type       TEXT NOT NULL,  -- 'premarket' | 'am' | 'pm' | 'fomc' | 'postmarket'
  notes              TEXT,
  chart_url          TEXT,
  direction_clarity  TEXT,           -- 'clear' | 'mixed' | 'no-trade'
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_session_day_id      ON session (day_id);
CREATE INDEX idx_session_type        ON session (session_type);
CREATE INDEX idx_session_clarity     ON session (direction_clarity);

-- ── 3. Trade Setup ──────────────────────────────────────────
CREATE TABLE trade_setup (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id              UUID NOT NULL REFERENCES journal_day(id) ON DELETE CASCADE,
  notion_block_id     TEXT,                  -- Notion block ID for sync

  instrument          TEXT NOT NULL,
  setup_type          TEXT,                  -- e.g. 'Continuation OB', 'FVG Rejection'
  htf_bias            TEXT,                  -- 'bullish' | 'bearish'
  entry_tf            TEXT,                  -- '1m' | '5m' | '15m'

  -- Prices
  entry_price         NUMERIC(12,4),
  stop_loss           NUMERIC(12,4),
  take_profit         NUMERIC(12,4),

  -- Outcome
  taken               BOOLEAN DEFAULT false,
  reason_skipped      TEXT,                  -- e.g. 'PM session uncertainty'
  trade_result        TEXT,                  -- 'win' | 'loss' | 'breakeven' | 'missed'
  exit_price          NUMERIC(12,4),
  pnl                 NUMERIC(12,2),         -- in USD or points
  rr_ratio            NUMERIC(6,2),          -- e.g. 2.5 for 2.5R

  entry_chart_url     TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_setup_day_id      ON trade_setup (day_id);
CREATE INDEX idx_setup_result      ON trade_setup (trade_result);
CREATE INDEX idx_setup_taken       ON trade_setup (taken);
CREATE INDEX idx_setup_instrument  ON trade_setup (instrument);

-- ── 4. Chart Image ───────────────────────────────────────────
CREATE TABLE chart_image (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id      UUID NOT NULL REFERENCES journal_day(id) ON DELETE CASCADE,
  setup_id    UUID REFERENCES trade_setup(id) ON DELETE SET NULL,
  label       TEXT,          -- e.g. 'Pre-market FVG', 'Entry OB'
  timeframe   TEXT,          -- 'Daily' | '15m' | '5m' | '1m'
  url         TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chart_day_id   ON chart_image (day_id);
CREATE INDEX idx_chart_setup_id ON chart_image (setup_id);

-- ── 5. Stats View (auto-computed) ────────────────────────────
CREATE VIEW trading_stats AS
SELECT
  instrument,
  COUNT(*)                                           AS total_setups,
  COUNT(*) FILTER (WHERE taken = true)               AS trades_taken,
  COUNT(*) FILTER (WHERE trade_result = 'win')       AS wins,
  COUNT(*) FILTER (WHERE trade_result = 'loss')      AS losses,
  ROUND(
    COUNT(*) FILTER (WHERE trade_result = 'win')::numeric
    / NULLIF(COUNT(*) FILTER (WHERE taken = true), 0) * 100, 1
  )                                                  AS win_rate_pct,
  ROUND(AVG(rr_ratio) FILTER (WHERE taken = true), 2) AS avg_rr,
  ROUND(SUM(pnl) FILTER (WHERE taken = true), 2)     AS total_pnl
FROM trade_setup
GROUP BY instrument;

-- ── Trigger: auto-update updated_at on journal_day ──────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_day_updated
  BEFORE UPDATE ON journal_day
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
