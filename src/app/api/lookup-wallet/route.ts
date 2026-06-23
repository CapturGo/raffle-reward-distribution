import { NextRequest, NextResponse } from 'next/server';
import { resolveSolanaWallet } from '@/lib/privy-server';

export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get('email')?.trim();
  console.log(email);
  
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  try {
    const result = await resolveSolanaWallet({ email });
    if (!result) return NextResponse.json({ email, address: null, source: null, found: false });
    return NextResponse.json({ email, address: result.address, source: result.source, found: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.toLowerCase().includes('invalid app id or app secret') ? 500 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
