-- Migration 0008: product analytics events (spec §7.7).
--
-- Deliberately local and first-party: these rows never leave the account, and
-- exist to answer the product's own success questions — above all the
-- north-star, "weekly active transformation rate": the share of weeks in which
-- a capture actually became a project, note, tested tool, or content seed.
--
-- Counting captures would measure collection. The point is to measure
-- transformation, so the events recorded are the moments something CHANGED
-- state, not the moments something was stored.

CREATE TABLE analytics_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  event      TEXT NOT NULL,          -- capture_created, project_activated, tool_status_changed, ...
  properties TEXT NOT NULL DEFAULT '{}',
  week       TEXT NOT NULL,          -- ISO year-week, so weekly rollups need no date maths
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_analytics_event ON analytics_events(event);
CREATE INDEX idx_analytics_week  ON analytics_events(user_id, week);
