import { applyD1Migrations, env } from "cloudflare:test";

// Idempotent: applyD1Migrations records what it ran, so this is cheap per file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
