import { NextRequest, NextResponse } from 'next/server';
import { getDraws } from '@/lib/capturgo';

export async function GET(request: NextRequest) {
  const token = extractToken(request);
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const campaignId = request.nextUrl.searchParams.get('campaignId') ?? undefined;
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? '10');
    const draws = await getDraws(token, campaignId, limit);
    return NextResponse.json(draws);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}
