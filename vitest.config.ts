import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          PROJECT_KEYS: JSON.stringify({ genix: "test-key-genix", other: "test-key-other" }),
          ORCHESTRATOR_CREDENTIALS: JSON.stringify({ laptop: "orch-cred-laptop", box: "orch-cred-box" }),
          ADMIN_TOKEN: "admin-test-token",
          MIND_TOKEN: "mind-test-token",
          ALLOW_TEST_CLOCK: "1",
          BLOCK_CACHE_MS: "0",
        },
      },
    }),
  ],
  test: { maxWorkers: 1, fileParallelism: false, testTimeout: 90_000 },
});
