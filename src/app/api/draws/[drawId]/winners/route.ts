import { NextRequest, NextResponse } from 'next/server';
import { getWinners } from '@/lib/capturgo';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ drawId: string }> },
) {
  const token = extractToken(request);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { drawId } = await params;
    const winners = await getWinners(token, drawId);
    return NextResponse.json(winners);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
