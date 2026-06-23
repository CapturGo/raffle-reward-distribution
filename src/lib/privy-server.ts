import { PrivyClient } from '@privy-io/server-auth';
import type { WalletWithMetadata } from '@privy-io/server-auth';
import { isValidSolanaAddress } from './solana';

let _client: PrivyClient | null = null;

function getClient(): PrivyClient {
  if (!_client) {
    const appId = process.env.PRIVY_APP_ID;
    const appSecret = process.env.PRIVY_APP_SECRET;
    if (!appId || !appSecret) throw new Error('Missing PRIVY_APP_ID or PRIVY_APP_SECRET');
    _client = new PrivyClient(appId, appSecret);
  }
  return _client;
}

/**
 * Resolves the best Solana wallet address for a winner using this priority:
 *  1. seekerWallet  — explicitly linked Solana wallet
 *  2. Privy Solana wallet — looked up by email via Privy admin API
 *
 * Returns the address string, or null if none found.
 */
export async function resolveSolanaWallet(winner: {
  seekerWallet?: string | null;
  email?: string | null;
}): Promise<{ address: string; source: string } | null> {
  const seekerWallet = winner.seekerWallet?.trim();
  if (seekerWallet && isValidSolanaAddress(seekerWallet)) return { address: seekerWallet, source: 'seekerWallet' };

  const email = winner.email?.trim();
  if (email) {
    console.log("Email in privy erver");
    
    const address = await getSolanaWalletFromPrivy(email);
    if (address) return { address, source: 'privy' };
  }

  return null;
}

async function getSolanaWalletFromPrivy(email: string): Promise<string | null> {
  const privy = getClient();
  const user = await privy.getUserByEmail(email);
  if (!user) return null;

  const solanaWallet = user.linkedAccounts.find(
    (account): account is WalletWithMetadata =>
      account.type === 'wallet' &&
      (account as WalletWithMetadata).chainType === 'solana',
  );

  const address = solanaWallet?.address?.trim();
  return address && isValidSolanaAddress(address) ? address : null;
}
