-- Idempotent capture. A client that retries a capture (a share sheet that fires
-- twice, a flaky network, an agent re-running a step) sends the same key and gets
-- the same source back instead of a duplicate.
ALTER TABLE source ADD COLUMN capture_key TEXT;
CREATE UNIQUE INDEX idx_source_capture_key ON source(capture_key) WHERE capture_key IS NOT NULL;
CREATE INDEX idx_source_url ON source(url, status);
