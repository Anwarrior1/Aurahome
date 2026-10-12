import { defineConfig } from 'drizzle-kit'

// Schema lives under src/main/db/schema (Step 3 database layer).
// Generated migration SQL is committed to drizzle/migrations and run
// by src/main/migrations/migration-runner.ts at app startup — never by
// drizzle-kit itself against a production database.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema/index.ts',
  out: './drizzle/migrations',
  verbose: true,
  strict: true
})
