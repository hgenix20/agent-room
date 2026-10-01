import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// A key pair made for this test run. The worker reads the public half from ACCESS_TEST_JWKS
// in place of fetching Cloudflare's certs; tests sign Access tokens with the private half.
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-kid", alg: "RS256", use: "sig" };

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
          ACCESS_TEAM_DOMAIN: "team.test",
          ACCESS_AUD: "test-aud",
          HUMANS: JSON.stringify(["kameron@example.com", "second@example.com", "k.green+room@example.com", "+++@example.com"]),
          ACCESS_TEST_JWKS: JSON.stringify({ keys: [publicJwk] }),
          TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateKey.export({ format: "jwk" })),
        },
      },
    }),
  ],
  test: { maxWorkers: 1, fileParallelism: false, testTimeout: 90_000 },
});
