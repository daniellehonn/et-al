import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Tests run inside workerd against the real Worker (src/index.ts, via
// wrangler.toml) and a real D1 with every migration applied — no mocks of the
// runtime or the database. Remote bindings (Workers AI, Vectorize) are off, so
// nothing here costs money or touches production; tests that need a model
// pass a fake one in.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml", environment: "test" },
        remoteBindings: false,
        miniflare: {
          bindings: { ET_AL_API_KEY: "test-key", TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
