import { defineConfig } from 'drizzle-kit';
import { env } from './src/config/env';

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.ts',
  out: './db/migrations',
  dbCredentials: {
    url: `file:${env.DB_PATH}`,
  },
  verbose: true,
  strict: true,
});
