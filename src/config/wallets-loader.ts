import { z } from 'zod';
import type { Chain } from '../types/event';

export const WalletSchema = z.object({
  chain: z.enum(['base', 'solana', 'sui']),
  address: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['active', 'archived']),
});
const WalletsSchema = z.array(WalletSchema).min(1);

export type Wallet = z.infer<typeof WalletSchema>;
export type WalletStatus = Wallet['status'] | 'all';

/**
 * Candidate module specifiers, tried in order: the real (gitignored,
 * permission-blocked) config first, then the committed staged file.
 * Resolved relative to this module so cwd does not matter.
 */
const DEFAULT_CANDIDATES: readonly string[] = [
  new URL('../../config/wallets.ts', import.meta.url).href,
  new URL('../../config/wallets.staged.ts', import.meta.url).href,
];

/**
 * Load wallet config at runtime via dynamic import. Falls through the
 * candidate list when a module is missing or its `WALLETS` export fails
 * validation. Never logs or throws wallet addresses — zod issues are
 * reduced to path + code.
 */
export async function loadWallets(
  candidates: readonly string[] = DEFAULT_CANDIDATES,
): Promise<Wallet[]> {
  const failures: string[] = [];
  for (const candidate of candidates) {
    let moduleExports: Record<string, unknown>;
    try {
      // Computed specifier: not statically resolved by tsc, may be absent at runtime.
      moduleExports = (await import(candidate)) as Record<string, unknown>;
    } catch {
      failures.push('module not loadable');
      continue;
    }
    const parsed = WalletsSchema.safeParse(moduleExports.WALLETS);
    if (!parsed.success) {
      // Address-safe summary: zod paths/codes only, never received values.
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code}`).join('; ');
      failures.push(`invalid WALLETS export (${issues})`);
      continue;
    }
    return parsed.data;
  }
  throw new Error(
    `No valid wallet config found across ${candidates.length} candidate module(s): ` +
      failures.map((f, i) => `[${i}] ${f}`).join(' | '),
  );
}

/** Wallets for one chain, filtered by status (default: active only). */
export async function walletsFor(
  chain: Chain,
  status: WalletStatus = 'active',
  candidates?: readonly string[],
): Promise<Wallet[]> {
  const wallets = await loadWallets(candidates);
  return wallets.filter((w) => w.chain === chain && (status === 'all' || w.status === status));
}
