export type SettlementStatus = 'PENDING' | 'PROCESSING' | 'SETTLED' | 'FAILED';

export type RaffleDraw = {
  id: string;
  campaignId: string;
  drawDate: string;
  periodStart?: string;
  periodEnd?: string;
  totalTickets: number | string;
  totalWinners: number;
  status: string;
  drawSeed?: string | null;
  snapshotTime?: string | null;
};

export type RaffleWinner = {
  id?: string;
  userId: string;
  username?: string;
  email?: string;
  walletAddress?: string | null;
  seekerWallet?: string | null;
  ticketsAtDraw: number | string;
  prizeAmount: number | string;
  settlementStatus?: SettlementStatus;
  txHash?: string | null;
};

export type ApiSettings = {
  apiBaseUrl: string;
};
