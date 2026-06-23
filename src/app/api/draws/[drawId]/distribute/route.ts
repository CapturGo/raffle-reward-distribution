import { NextRequest, NextResponse } from 'next/server';
import { getWinners, updateSettlement } from '@/lib/capturgo';
import { createSolanaClient, formatTokenAmount, parseTokenAmount } from '@/lib/solana';
import { resolveSolanaWallet } from '@/lib/privy-server';
import type { DistributeResult } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ drawId: string }> },
) {
  const token = extractToken(request);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { drawId } = await params;
    const winners = await getWinners(token, drawId);
    const pending = winners.filter((w) => (w.settlementStatus ?? 'PENDING') === 'PENDING' && w.id);

    if (pending.length === 0) {
      return NextResponse.json({ distributed: 0, results: [] });
    }

    const solana = createSolanaClient();
    const results: DistributeResult[] = [];
    const payable: Array<{ winnerId: string; prizeAmount: string; wallet: string; source: string }> = [];
    let requiredBalance = 0n;

    for (const winner of pending) {
      const winnerId = winner.id!;
      const prizeAmount = String(winner.prizeAmount);

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

      requiredBalance += parseTokenAmount(prizeAmount);
      payable.push({ winnerId, prizeAmount, wallet: resolved.address, source: resolved.source });
    }

    if (payable.length === 0) {
      return NextResponse.json({ distributed: 0, results });
    }

    const availableBalance = await solana.getUsdcBalance();
    if (availableBalance < requiredBalance) {
      return NextResponse.json(
        {
          error: `Insufficient USDC balance. Need ${formatTokenAmount(requiredBalance)} USDC, available ${formatTokenAmount(availableBalance)} USDC.`,
          requiredBalance: formatTokenAmount(requiredBalance),
          availableBalance: formatTokenAmount(availableBalance),
          results,
        },
        { status: 402 },
      );
    }

    for (const payout of payable) {
      try {
        await updateSettlement(token, payout.winnerId, 'PROCESSING');
        const txHash = await solana.sendUsdc(payout.wallet, payout.prizeAmount);
        await updateSettlement(token, payout.winnerId, 'SETTLED', txHash);
        results.push({
          winnerId: payout.winnerId,
          wallet: payout.wallet,
          prizeAmount: payout.prizeAmount,
          status: 'settled',
          txHash,
          source: payout.source,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await updateSettlement(token, payout.winnerId, 'FAILED').catch(() => {});
        results.push({
          winnerId: payout.winnerId,
          wallet: payout.wallet,
          prizeAmount: payout.prizeAmount,
          status: 'failed',
          error,
          source: payout.source,
        });
      }
    }

    const distributed = results.filter((r) => r.status === 'settled').length;
    return NextResponse.json({ distributed, results });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
