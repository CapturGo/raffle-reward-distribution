import { NextResponse } from 'next/server';
import { formatTokenAmount } from '@/lib/solana';

const TOKEN_SYMBOL = process.env.REWARD_TOKEN_SYMBOL ?? 'USDC';

export async function GET() {
  const rpcUrl = process.env.REWARD_SOLANA_RPC_URL;
  const privateKeyRaw = process.env.REWARD_SOLANA_PRIVATE_KEY;

  if (!rpcUrl || !privateKeyRaw) {
    return NextResponse.json({
      configured: false,
      address: null,
      balance: null,
      symbol: TOKEN_SYMBOL,
      error: 'REWARD_SOLANA_RPC_URL or REWARD_SOLANA_PRIVATE_KEY not set',
    });
  }

  try {
    const { createSolanaClient } = await import('@/lib/solana');
    const solana = createSolanaClient();
    const address = solana.fundingAddress();
    const balance = formatTokenAmount(await solana.getUsdcBalance());

    return NextResponse.json({ configured: true, address, balance, symbol: TOKEN_SYMBOL });
  } catch (error) {
    return NextResponse.json({ configured: false, address: null, balance: null, symbol: TOKEN_SYMBOL, error: String(error) });
  }
}
