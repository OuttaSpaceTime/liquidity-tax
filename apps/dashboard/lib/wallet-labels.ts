import 'server-only';
import { join } from 'node:path';
import type { Wallet } from '@lt/config/wallets-loader';

export interface WalletInfo {
  label: string;
  status: Wallet['status'];
  chain: Wallet['chain'];
}

/**
 * Load the CLI's `loadWallets` at RUNTIME (under Bun), not through webpack.
 *
 * `wallets-loader.ts` dynamic-imports the gitignored, permission-blocked
 * `config/wallets.ts`; if webpack traced that edge the build would fail
 * resolving a file that may not exist. So we (a) keep only the erased
 * `import type { Wallet }` above, and (b) pull the loader via a `webpackIgnore`
 * dynamic import of an absolute path computed at runtime — webpack leaves it
 * alone, Bun resolves the `.ts` natively at request time.
 *
 * Repo root is derived from cwd (the dashboard is always launched from
 * apps/dashboard); override with WALLETS_LOADER_PATH if needed.
 */
async function importLoader(): Promise<(() => Promise<Wallet[]>) | null> {
  const path =
    process.env.WALLETS_LOADER_PATH ?? join(process.cwd(), '..', '..', 'src', 'config', 'wallets-loader.ts');
  try {
    const mod = (await import(/* webpackIgnore: true */ path)) as {
      loadWallets?: () => Promise<Wallet[]>;
    };
    return mod.loadWallets ?? null;
  } catch {
    return null;
  }
}

/**
 * Address → label map, loaded once. PRIVACY: the dashboard renders labels,
 * never raw addresses; resolution is server-side only. On any failure (no
 * config on a fresh checkout) it resolves to an empty map and callers fall
 * back to a privacy-safe fingerprint.
 */
let cache: Promise<Map<string, WalletInfo>> | undefined;

export function walletLabelMap(): Promise<Map<string, WalletInfo>> {
  if (cache === undefined) {
    cache = (async () => {
      const loadWallets = await importLoader();
      const map = new Map<string, WalletInfo>();
      if (loadWallets === null) return map;
      try {
        for (const w of await loadWallets()) {
          const info = { label: w.label, status: w.status, chain: w.chain };
          map.set(w.address, info);
          // EVM addresses are case-insensitive (checksum is display-only); events
          // store them lowercased. Add a lowercase alias so config checksums match.
          // Solana base58 is case-SENSITIVE — only alias 0x-style addresses.
          if (/^0x[0-9a-fA-F]{40}$/.test(w.address)) map.set(w.address.toLowerCase(), info);
        }
      } catch {
        /* leave map empty */
      }
      return map;
    })();
  }
  return cache;
}

/** A short, non-address-leaking fallback for an unmapped wallet. */
function fallbackLabel(address: string): string {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  return `wallet-${h.toString(16).padStart(6, '0').slice(0, 6)}`;
}

/** Resolve one address to its label (or a privacy-safe fingerprint). */
export function labelFor(map: Map<string, WalletInfo>, address: string): string {
  const hit = map.get(address) ?? (/^0x[0-9a-fA-F]{40}$/.test(address) ? map.get(address.toLowerCase()) : undefined);
  return hit?.label ?? fallbackLabel(address);
}
