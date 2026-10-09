import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// The extraction eval runs the real extractor against the real Workers AI model,
// so unlike the test suite it uses the default environment and remote bindings.
// It needs `wrangler login`, and it costs a few cents of Workers AI per run.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" }, remoteBindings: true })],
  test: { include: ["eval/**/*.eval.ts"] },
});
