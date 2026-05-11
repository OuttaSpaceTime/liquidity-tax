import 'dotenv/config';
import { z } from 'zod';

const Schema = z.object({
  HELIUS_API_KEY:    z.string().min(1).optional(),
  ALCHEMY_API_KEY:   z.string().min(1).optional(),
  COINGECKO_API_KEY: z.string().min(1).optional(),
  SUI_RPC_URL:       z.string().url().optional(),
  DB_PATH:           z.string().default('data/liquidity-tax.db'),
});

export type Env = z.infer<typeof Schema>;

export function parseEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment — ${issues}`);
  }
  return parsed.data;
}

export function requireEnvKey<K extends keyof Env>(env: Env, key: K): NonNullable<Env[K]> {
  const val = env[key];
  if (val == null) throw new Error(`Missing required env var: ${String(key)}`);
  return val as NonNullable<Env[K]>;
}

export const env = parseEnv();

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  return requireEnvKey(env, key);
}
