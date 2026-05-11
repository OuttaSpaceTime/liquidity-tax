import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../src/config/env';

mkdirSync(dirname(env.DB_PATH), { recursive: true });

const sqlite = new Database(env.DB_PATH);
sqlite.query('PRAGMA journal_mode = WAL').run();
sqlite.query('PRAGMA foreign_keys = ON').run();

const db = drizzle(sqlite);
migrate(db, { migrationsFolder: './db/migrations' });
console.log('migrations applied →', env.DB_PATH);
