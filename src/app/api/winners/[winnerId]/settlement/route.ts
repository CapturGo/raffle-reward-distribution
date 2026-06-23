import { NextRequest, NextResponse } from 'next/server';
import { updateSettlement } from '@/lib/capturgo';
import type { SettlementStatus } from '@/lib/types';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ winnerId: string }> },
) {
  const token = extractToken(request);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { winnerId } = await params;
    const body = (await request.json()) as { status: SettlementStatus; txHash?: string };
    await updateSettlement(token, winnerId, body.status, body.txHash);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
