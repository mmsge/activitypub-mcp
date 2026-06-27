import { defineConfig } from 'vitest/config'

// Minimal env so importing modules that load src/config.ts (which validates env
// and process.exit(1)s on failure) doesn't abort test suites. No real DB or
// network is touched by the unit tests — db/client connects lazily.
export default defineConfig({
  test: {
    env: {
      // 'production' so logger.ts uses plain pino, not the optional pino-pretty dev transport.
      NODE_ENV: 'production',
      APP_DOMAIN: 'test.local',
      DATABASE_URL: 'postgres://test:test@localhost:5432/test',
      ADMIN_PASSWORD_HASH: 'test-hash',
      SESSION_SECRET: 'x'.repeat(32),
    },
  },
})
