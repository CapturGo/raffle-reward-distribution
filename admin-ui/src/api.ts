import type { RaffleDraw, RaffleWinner, SettlementStatus } from './types';

type RequestOptions = {
  method?: string;
  body?: unknown;
};

export class RaffleApi {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly getDeviceHeaders: () => Record<string, string>,
    private readonly campaignId?: string,
  ) {}

  async getDraws(limit = 1): Promise<RaffleDraw[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (this.campaignId?.trim()) params.set('campaignId', this.campaignId.trim());
    return this.request<RaffleDraw[]>(`/raffles/draws?${params.toString()}`);
  }

  async getLatestDraw(): Promise<RaffleDraw | null> {
    const draws = await this.getDraws(1);
    return draws[0] ?? null;
  }

  async getWinners(drawId: string): Promise<RaffleWinner[]> {
    return this.request<RaffleWinner[]>(`/raffles/draws/${encodeURIComponent(drawId)}/winners`);
  }

  async updateSettlement(winnerId: string, status: SettlementStatus, txHash?: string): Promise<void> {
    await this.request<string>(`/raffles/winners/${encodeURIComponent(winnerId)}/settlement`, {
      method: 'PATCH',
      body: { status, txHash: txHash || null },
    });
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = await this.getToken();
    if (!token) throw new Error('Missing Privy access token. Log in first.');

    const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...this.getDeviceHeaders(),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${options.method ?? 'GET'} ${path} failed: ${response.status} ${text}`);
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}
