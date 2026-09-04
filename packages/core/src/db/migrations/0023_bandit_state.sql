-- Migration 0023: Persistent State for LinUCB Contextual Multi-Armed Bandit
-- Stores flattened covariance/design matrix A and reward vector b for online reinforcement learning
-- Attaches bandit decision telemetry (action, context, UCB score) to live_payment_events

CREATE TABLE IF NOT EXISTS bandit_state (
  arm_type TEXT NOT NULL,
  action TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  matrix_a_json TEXT NOT NULL,
  vector_b_json TEXT NOT NULL,
  pull_count INTEGER NOT NULL DEFAULT 0,
  total_reward REAL NOT NULL DEFAULT 0.0,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (arm_type, action)
);

CREATE INDEX IF NOT EXISTS idx_bandit_state_arm ON bandit_state(arm_type, action);

ALTER TABLE live_payment_events ADD COLUMN bandit_action TEXT;
ALTER TABLE live_payment_events ADD COLUMN bandit_context_json TEXT;
ALTER TABLE live_payment_events ADD COLUMN bandit_ucb_score REAL;

CREATE INDEX IF NOT EXISTS idx_liveevt_bandit_action ON live_payment_events(bandit_action);
