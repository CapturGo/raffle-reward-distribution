import type { RaffleDraw, RaffleWinner, SettlementStatus } from './types';

const DEFAULT_CAMPAIGN_ID = 'b59966be-20cd-484c-93a3-770295a16c62';

function getApiBase(): string {
  const apiBase = process.env.CAPTURGO_API_BASE_URL;
  if (!apiBase) throw new Error('Missing CAPTURGO_API_BASE_URL');
  return apiBase.replace(/\/+$/, '');
}

function deviceHeaders() {
  return {
    'X-Device-ID': process.env.CAPTURGO_DEVICE_ID ?? '',
    'X-Device-Type': process.env.CAPTURGO_DEVICE_TYPE ?? 'ios',
    'X-App-Version': 'raffle-admin',
  };
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...deviceHeaders(),
  };
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CapturGo ${init.method ?? 'GET'} ${path}: ${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function getDraws(token: string, campaignId?: string, limit = 1): Promise<RaffleDraw[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  params.set('campaignId', campaignId ?? process.env.CAPTURGO_RAFFLE_CAMPAIGN_ID ?? DEFAULT_CAMPAIGN_ID);
  return request<RaffleDraw[]>(`/api/v1/raffles/draws?${params}`, token);
}

export async function getWinners(token: string, drawId: string): Promise<RaffleWinner[]> {
  return request<RaffleWinner[]>(`/api/v1/raffles/draws/${encodeURIComponent(drawId)}/winners`, token);
}

export async function updateSettlement(
  token: string,
  winnerId: string,
  status: SettlementStatus,
  txHash?: string,
): Promise<void> {
  await request(`/api/v1/raffles/winners/${encodeURIComponent(winnerId)}/settlement`, token, {
    method: 'PATCH',
    body: JSON.stringify({ status, txHash: txHash ?? null }),
  });
}
