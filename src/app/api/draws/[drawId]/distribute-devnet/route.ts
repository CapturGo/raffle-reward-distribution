import { NextRequest, NextResponse } from 'next/server';
import { getWinners } from '@/lib/capturgo';
import { createSolanaClient, formatTokenAmount, parseTokenAmount } from '@/lib/solana';
import { resolveSolanaWallet } from '@/lib/privy-server';
import type { DistributeResult } from '@/lib/types';

const DEVNET_RPC_URL = process.env.DEVNET_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const DEVNET_TOKEN_ADDRESS = process.env.DEVNET_TOKEN_ADDRESS ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEVNET_TOKEN_DECIMALS = Number(process.env.DEVNET_TOKEN_DECIMALS ?? '6');
const DEVNET_TOKEN_SYMBOL = process.env.DEVNET_TOKEN_SYMBOL ?? 'USDC-devnet';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ drawId: string }> },
) {
  const token = extractToken(request);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { drawId } = await params;
    const body = await readJsonBody<{ customAmount?: unknown }>(request);
    const customAmount = normalizeCustomAmount(body?.customAmount);
    const winners = await getWinners(token, drawId);
    const pending = winners.filter((winner) => (winner.settlementStatus ?? 'PENDING') === 'PENDING' && winner.id);

    if (pending.length === 0) {
      return NextResponse.json({ distributed: 0, results: [], testMode: true, network: 'devnet', customAmount });
    }

    const solana = createSolanaClient({
      rpcUrl: DEVNET_RPC_URL,
      privateKey: process.env.DEVNET_SOLANA_PRIVATE_KEY ?? process.env.REWARD_SOLANA_PRIVATE_KEY,
      tokenAddress: DEVNET_TOKEN_ADDRESS,
      tokenDecimals: DEVNET_TOKEN_DECIMALS,
      tokenSymbol: DEVNET_TOKEN_SYMBOL,
    });
    const results: DistributeResult[] = [];
    const payable: Array<{ winnerId: string; prizeAmount: string; wallet: string; source: string }> = [];
    let requiredBalance = 0n;

    for (const winner of pending) {
      const winnerId = winner.id!;
      const prizeAmount = customAmount ?? String(winner.prizeAmount);
      const resolved = await resolveSolanaWallet({
        seekerWallet: winner.seekerWallet,
        email: winner.email,
      });

      if (!resolved) {
        results.push({
          winnerId,
          wallet: '',
          prizeAmount,
          status: 'skipped',
          error: 'No Solana wallet found (checked seekerWallet, then Privy email)',
        });
        continue;
      }

      requiredBalance += parseTokenAmount(prizeAmount, DEVNET_TOKEN_DECIMALS, DEVNET_TOKEN_SYMBOL);
      payable.push({ winnerId, prizeAmount, wallet: resolved.address, source: resolved.source });
    }

    if (payable.length === 0) {
      return NextResponse.json({ distributed: 0, results, testMode: true, network: 'devnet' });
    }

    const availableBalance = await solana.getUsdcBalance();
    if (availableBalance < requiredBalance) {
      return NextResponse.json(
        {
          error: `Insufficient devnet ${DEVNET_TOKEN_SYMBOL} balance. Need ${formatTokenAmount(requiredBalance, DEVNET_TOKEN_DECIMALS)} ${DEVNET_TOKEN_SYMBOL}, available ${formatTokenAmount(availableBalance, DEVNET_TOKEN_DECIMALS)} ${DEVNET_TOKEN_SYMBOL}. No CapturGo settlement API was updated.`,
          requiredBalance: formatTokenAmount(requiredBalance, DEVNET_TOKEN_DECIMALS),
          availableBalance: formatTokenAmount(availableBalance, DEVNET_TOKEN_DECIMALS),
          results,
          testMode: true,
          network: 'devnet',
          customAmount,
        },
        { status: 402 },
      );
    }

    for (const payout of payable) {
      try {
        const txHash = await solana.sendUsdc(payout.wallet, payout.prizeAmount);
        results.push({
          winnerId: payout.winnerId,
          wallet: payout.wallet,
          prizeAmount: payout.prizeAmount,
          status: 'settled',
          txHash,
          source: payout.source,
        });
      } catch (err) {
        results.push({
          winnerId: payout.winnerId,
          wallet: payout.wallet,
          prizeAmount: payout.prizeAmount,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          source: payout.source,
        });
      }
    }

    const distributed = results.filter((result) => result.status === 'settled').length;
    return NextResponse.json({ distributed, results, testMode: true, network: 'devnet', customAmount });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        testMode: true,
        network: 'devnet',
      },
      { status: error instanceof Error && error.message.startsWith('Devnet custom amount') ? 400 : 500 },
    );
  }
}

async function readJsonBody<T>(request: NextRequest): Promise<T | null> {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) as T : null;
  } catch {
    return null;
  }
}

function normalizeCustomAmount(value: unknown): string | null {
  if (value == null || value === '') return null;
  const amount = String(value).trim();
  if (!amount) return null;
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('Devnet custom amount must be a positive number');
  if (Number(amount) <= 0) throw new Error('Devnet custom amount must be greater than 0');
  parseTokenAmount(amount, DEVNET_TOKEN_DECIMALS, DEVNET_TOKEN_SYMBOL);
  return amount;
}

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
