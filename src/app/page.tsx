'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useLoginWithEmail, usePrivy } from '@privy-io/react-auth';
import {
  CheckCircle2,
  Clipboard,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Ticket,
  Zap,
  WalletCards,
} from 'lucide-react';
import type { DistributeResult, RaffleDraw, RaffleWinner } from '@/lib/types';

const configuredCampaignId =
  process.env.NEXT_PUBLIC_CAPTURGO_CAMPAIGN_ID ?? 'b59966be-20cd-484c-93a3-770295a16c62';

type BusyAction =
  | 'send-code'
  | 'login'
  | 'token'
  | 'draw'
  | 'winners'
  | 'distribute'
  | 'devnet-distribute'
  | 'wallet';

type WalletInfo = {
  configured: boolean;
  address: string | null;
  balance: string | null;
  symbol: string;
  error?: string;
};

type ApiErrorWithPayload = Error & {
  status?: number;
  payload?: unknown;
};

type DistributeResponse = {
  distributed: number;
  results: DistributeResult[];
  error?: string;
  requiredBalance?: string;
  availableBalance?: string;
  testMode?: boolean;
  network?: string;
  customAmount?: string | null;
};

type WalletResolution = {
  address: string | null;
  source: 'seekerWallet' | 'privy' | null;
  error?: string;
};

function getWinnerId(winner: RaffleWinner): string {
  return winner.id?.trim() || '';
}

function getWinnerKey(winner: RaffleWinner): string {
  return getWinnerId(winner) || winner.userId;
}

function isLikelySolanaAddress(value: string | null | undefined): value is string {
  return Boolean(value?.trim().match(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/));
}

function formatNumber(value: string | number | undefined): string {
  if (value == null || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
}

function formatDate(value: string | undefined | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(date);
}

function mask(value: string | null | undefined, head = 10, tail = 8): string {
  if (!value) return '-';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function getEmail(user: unknown): string {
  const linked =
    (user as { linkedAccounts?: unknown[] } | null)?.linkedAccounts ??
    (user as { linked_accounts?: unknown[] } | null)?.linked_accounts ??
    [];
  const email = linked.find((a) => (a as { type?: string }).type === 'email') as
    | { address?: string; email?: string }
    | undefined;
  return email?.address ?? email?.email ?? '';
}

async function getWalletResolutions(loadedWinners: RaffleWinner[]): Promise<Record<string, WalletResolution>> {
  const resolutions: Record<string, WalletResolution> = {};

  for (const winner of loadedWinners) {
    const key = getWinnerKey(winner);
    const seekerWallet = winner.seekerWallet?.trim();
    resolutions[key] = isLikelySolanaAddress(seekerWallet)
      ? { address: seekerWallet, source: 'seekerWallet' }
      : { address: null, source: null };
  }

  const lookups = loadedWinners
    .filter((winner) => !resolutions[getWinnerKey(winner)]?.address && winner.email)
    .map(async (winner) => {
      const key = getWinnerKey(winner);
      try {
        const res = await fetch(`/api/lookup-wallet?email=${encodeURIComponent(winner.email!.trim())}`);
        const data = await res.json() as { address?: string | null; source?: string | null; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Lookup failed');
        return {
          key,
          resolution: data.address
            ? { address: data.address, source: data.source === 'privy' ? 'privy' as const : null }
            : { address: null, source: null },
        };
      } catch (err) {
        return {
          key,
          resolution: {
            address: null,
            source: null,
            error: err instanceof Error ? err.message : String(err),
          } satisfies WalletResolution,
        };
      }
    });

  const resolved = await Promise.all(lookups);
  for (const item of resolved) resolutions[item.key] = item.resolution;

  return resolutions;
}

export default function Page() {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const { sendCode, loginWithCode, state: otpState } = useLoginWithEmail();

  const [campaignId, setCampaignId] = useState(configuredCampaignId);

  useEffect(() => {
    const saved = localStorage.getItem('capturgo-campaign-id');
    if (saved) setCampaignId(saved);
  }, []);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [jwt, setJwt] = useState('');
  const [showJwt, setShowJwt] = useState(false);
  const [latestDraw, setLatestDraw] = useState<RaffleDraw | null>(null);
  const [drawId, setDrawId] = useState('');
  const [winners, setWinners] = useState<RaffleWinner[]>([]);
  const [distributeResults, setDistributeResults] = useState<DistributeResult[] | null>(null);
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [walletResolutions, setWalletResolutions] = useState<Record<string, WalletResolution>>({});
  const [lastDistributionMode, setLastDistributionMode] = useState<'production' | 'devnet' | null>(null);
  const [devnetCustomAmount, setDevnetCustomAmount] = useState('');
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const autoLoadedKeyRef = useRef('');

  useEffect(() => {
    if (campaignId) localStorage?.setItem('capturgo-campaign-id', campaignId);
  }, [campaignId]);

  useEffect(() => {
    if (authenticated) {
      const resolved = getEmail(user);
      if (resolved) setEmail(resolved);
    }
  }, [authenticated, user]);

  const run = useCallback(async (action: BusyAction, task: () => Promise<void>) => {
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }, []);

  async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getAccessToken();
    if (!token) throw new Error('No Privy session. Please log in.');
    const res = await fetch(path, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        payload = undefined;
      }
      const message =
        payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : text || res.statusText;
      const error = new Error(message) as ApiErrorWithPayload;
      error.status = res.status;
      error.payload = payload;
      throw error;
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async function handleSendCode(event: FormEvent) {
    event.preventDefault();
    await run('send-code', async () => {
      await sendCode({ email: email.trim() });
      setNotice(`OTP sent to ${email.trim()}`);
    });
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    await run('login', async () => {
      await loginWithCode({ code: otp.trim() });
      setOtp('');
      setNotice('Logged in');
    });
  }

  async function handleLoadToken() {
    await run('token', async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('No token returned. Check login state.');
      setJwt(token);
      setNotice('JWT refreshed');
    });
  }

  async function loadWallet() {
    await run('wallet', async () => {
      const info = await fetch('/api/wallet').then((r) => r.json()) as WalletInfo;
      setWalletInfo(info);
    });
  }

  async function loadLatestDraw() {
    await run('draw', async () => {
      const params = new URLSearchParams({ limit: '1', campaignId });
      const draws = await apiRequest<RaffleDraw[]>(`/api/draws?${params}`);
      const draw = draws[0] ?? null;
      setLatestDraw(draw);
      setDrawId(draw?.id ?? '');
      setWinners([]);
      setWalletResolutions({});
      setNotice(draw ? 'Latest draw loaded' : 'No draws found');
    });
  }

  async function loadWinners(targetDrawId = drawId) {
    await run('winners', async () => {
      if (!targetDrawId.trim()) throw new Error('Draw ID is required');
      const response = await apiRequest<RaffleWinner[]>(`/api/draws/${encodeURIComponent(targetDrawId.trim())}/winners`);
      setWinners(response);
      setDistributeResults(null);
      setWalletResolutions(await getWalletResolutions(response));
      setNotice(`${response.length} winner${response.length === 1 ? '' : 's'} loaded`);
    });
  }

  async function distributeAll() {
    await run('distribute', async () => {
      if (!drawId.trim()) throw new Error('Load a draw first');
      if (!walletInfo?.configured) throw new Error(walletInfo?.error ?? 'Distribution wallet is not configured');
      if (Number(walletInfo.balance ?? 0) <= 0) throw new Error(`Distribution wallet has 0 ${walletInfo.symbol}`);

      let result: DistributeResponse;
      try {
        result = await apiRequest<DistributeResponse>(
          `/api/draws/${encodeURIComponent(drawId.trim())}/distribute`,
          { method: 'POST' },
        );
      } catch (caught) {
        const payload = (caught as ApiErrorWithPayload).payload as Partial<DistributeResponse> | undefined;
        setLastDistributionMode('production');
        if (payload?.results) setDistributeResults(payload.results);
        throw caught;
      }
      setLastDistributionMode('production');
      setDistributeResults(result.results);
      setWalletResolutions((current) => {
        const next = { ...current };
        for (const row of result.results) {
          if (row.wallet) {
            next[row.winnerId] = {
              address: row.wallet,
              source: row.source === 'seekerWallet' || row.source === 'privy' ? row.source : null,
            };
          }
        }
        return next;
      });
      const failed = result.results.filter((row) => row.status === 'failed').length;
      const skipped = result.results.filter((row) => row.status === 'skipped').length;
      setNotice(`Settled ${result.distributed}, failed ${failed}, skipped ${skipped}`);
      await loadWallet();
      await loadWinners(drawId);
    });
  }

  async function distributeDevnetTest() {
    await run('devnet-distribute', async () => {
      if (!drawId.trim()) throw new Error('Load a draw first');

      let result: DistributeResponse;
      const customAmount = devnetCustomAmount.trim();
      try {
        result = await apiRequest<DistributeResponse>(
          `/api/draws/${encodeURIComponent(drawId.trim())}/distribute-devnet`,
          {
            method: 'POST',
            body: customAmount ? JSON.stringify({ customAmount }) : undefined,
          },
        );
      } catch (caught) {
        const payload = (caught as ApiErrorWithPayload).payload as Partial<DistributeResponse> | undefined;
        setLastDistributionMode('devnet');
        if (payload?.results) setDistributeResults(payload.results);
        throw caught;
      }

      setLastDistributionMode('devnet');
      setDistributeResults(result.results);
      setWalletResolutions((current) => {
        const next = { ...current };
        for (const row of result.results) {
          if (row.wallet) {
            next[row.winnerId] = {
              address: row.wallet,
              source: row.source === 'seekerWallet' || row.source === 'privy' ? row.source : null,
            };
          }
        }
        return next;
      });
      const failed = result.results.filter((row) => row.status === 'failed').length;
      const skipped = result.results.filter((row) => row.status === 'skipped').length;
      const amountNote = result.customAmount ? ` using ${result.customAmount} per winner` : '';
      setNotice(`Devnet test sent ${result.distributed}${amountNote}, failed ${failed}, skipped ${skipped}. CapturGo API was not updated.`);
    });
  }

  useEffect(() => {
    if (!ready || !authenticated || !campaignId.trim()) return;

    const autoLoadKey = `${campaignId.trim()}:${getEmail(user) || 'authenticated'}`;
    if (autoLoadedKeyRef.current === autoLoadKey) return;
    autoLoadedKeyRef.current = autoLoadKey;

    let cancelled = false;

    async function autoLoad() {
      setBusy('draw');
      setError('');
      setNotice('Loading raffle data...');

      try {
        const walletPromise = fetch('/api/wallet')
          .then((r) => r.json() as Promise<WalletInfo>)
          .catch((caught) => ({
            configured: false,
            address: null,
            balance: null,
            symbol: 'USDC',
            error: caught instanceof Error ? caught.message : String(caught),
          }));

        const token = await getAccessToken();
        if (!token) throw new Error('No Privy session. Please log in.');

        const params = new URLSearchParams({ limit: '1', campaignId: campaignId.trim() });
        const drawsResponse = await fetch(`/api/draws?${params}`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });
        const drawsText = await drawsResponse.text();
        if (!drawsResponse.ok) throw new Error(`${drawsResponse.status}: ${drawsText}`);
        const draws = drawsText ? JSON.parse(drawsText) as RaffleDraw[] : [];
        const draw = draws[0] ?? null;

        const wallet = await walletPromise;
        if (cancelled) return;

        setWalletInfo(wallet);
        setLatestDraw(draw);
        setDrawId(draw?.id ?? '');
        setDistributeResults(null);

        if (!draw) {
          setWinners([]);
          setWalletResolutions({});
          setNotice('No draws found');
          return;
        }

        setBusy('winners');
        const winnersResponse = await fetch(`/api/draws/${encodeURIComponent(draw.id)}/winners`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });
        const winnersText = await winnersResponse.text();
        if (!winnersResponse.ok) throw new Error(`${winnersResponse.status}: ${winnersText}`);
        const loadedWinners = winnersText ? JSON.parse(winnersText) as RaffleWinner[] : [];
        const resolutions = await getWalletResolutions(loadedWinners);

        if (cancelled) return;

        setWinners(loadedWinners);
        setWalletResolutions(resolutions);
        setNotice(`${loadedWinners.length} winner${loadedWinners.length === 1 ? '' : 's'} loaded`);
      } catch (caught) {
        if (!cancelled) {
          autoLoadedKeyRef.current = '';
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    }

    void autoLoad();

    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, campaignId, user, getAccessToken]);

  const pendingCount = winners.filter((w) => (w.settlementStatus ?? 'PENDING') === 'PENDING').length;
  const totalPrize = winners.reduce((sum, w) => sum + (Number(w.prizeAmount) || 0), 0);
  const settledResultCount = distributeResults?.filter((row) => row.status === 'settled').length ?? 0;
  const failedResultCount = distributeResults?.filter((row) => row.status === 'failed').length ?? 0;
  const skippedResultCount = distributeResults?.filter((row) => row.status === 'skipped').length ?? 0;
  const distributionBlockedReason = !walletInfo?.configured
    ? walletInfo?.error ?? 'Distribution wallet is not configured'
    : Number(walletInfo.balance ?? 0) <= 0
      ? `Distribution wallet has 0 ${walletInfo.symbol}`
      : '';
  const devnetAmountInvalid =
    devnetCustomAmount.trim() !== '' &&
    (!/^\d+(\.\d+)?$/.test(devnetCustomAmount.trim()) || Number(devnetCustomAmount.trim()) <= 0);
  const tokenPreview = jwt ? (showJwt ? jwt : mask(jwt, 24, 18)) : 'No JWT loaded';

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">CapturGo</p>
          <h1>Reward Distribution</h1>
        </div>
        <div className={`session-pill ${authenticated ? 'is-on' : ''}`}>
          <ShieldCheck size={18} />
          {ready ? (authenticated ? 'Logged in' : 'Not logged in') : 'Loading'}
        </div>
      </section>

      <section className="workspace">
        <aside className="panel auth-panel">
          <div className="panel-header">
            <KeyRound size={22} />
            <div>
              <h2>Admin Login</h2>
              <p>{authenticated ? getEmail(user) || email : 'Email OTP'}</p>
            </div>
          </div>

          <form className="stack" onSubmit={handleSendCode}>
            <label>
              <span>Email</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="admin@example.com"
                disabled={authenticated || busy === 'send-code'}
              />
            </label>
            {!authenticated && (
              <button className="primary" type="submit" disabled={!ready || !email.trim() || busy === 'send-code'}>
                {busy === 'send-code' ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                Send OTP
              </button>
            )}
          </form>

          {!authenticated ? (
            <form className="stack" onSubmit={handleLogin}>
              <label>
                <span>OTP</span>
                <input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  inputMode="numeric"
                  placeholder="6-digit code"
                  disabled={busy === 'login'}
                />
              </label>
              <button className="primary" type="submit" disabled={!otp.trim() || busy === 'login'}>
                {busy === 'login' ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />}
                Submit OTP
              </button>
              <p className="muted">{otpState.status}</p>
            </form>
          ) : (
            <div className="stack">
              <button className="ghost danger" type="button" onClick={() => { setJwt(''); void logout(); }}>
                <LogOut size={18} />
                Logout
              </button>
              <details className="advanced-auth">
                <summary>Advanced</summary>
                <button className="secondary" type="button" onClick={handleLoadToken} disabled={busy === 'token'}>
                  {busy === 'token' ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                  Get JWT
                </button>
                <div className="token-box">
                  <code>{tokenPreview}</code>
                  <div className="token-actions">
                    <button className="icon-button" type="button" onClick={() => setShowJwt((v) => !v)}>
                      {showJwt ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                    <button className="icon-button" type="button" onClick={() => navigator.clipboard.writeText(jwt)} disabled={!jwt}>
                      <Clipboard size={18} />
                    </button>
                  </div>
                </div>
              </details>
            </div>
          )}

          <div className="divider" />

          <label>
            <span>Campaign ID</span>
            <input
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              placeholder="b59966be-..."
            />
          </label>
        </aside>

        <section className="main-grid">
          <div className="panel draw-panel">
            <div className="panel-header split">
              <div className="title-row">
                <Ticket size={22} />
                <div>
                  <h2>Raffle</h2>
                  <p>{latestDraw ? formatDate(latestDraw.drawDate) : 'Load latest draw'}</p>
                </div>
              </div>
              <button className="secondary" type="button" onClick={loadLatestDraw} disabled={!authenticated || busy === 'draw'}>
                {busy === 'draw' ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Load
              </button>
            </div>

            <div className="summary-strip">
              <div><span>Winners</span><strong>{winners.length || latestDraw?.totalWinners || '-'}</strong></div>
              <div><span>Pending</span><strong>{pendingCount}</strong></div>
              <div><span>Total</span><strong>${formatNumber(totalPrize)}</strong></div>
              <div>
                <span>Wallet</span>
                <strong className={walletInfo?.configured && Number(walletInfo.balance) > 0 ? '' : 'warn'}>
                  {walletInfo?.configured ? `${walletInfo.balance} ${walletInfo.symbol}` : 'Not ready'}
                </strong>
              </div>
            </div>

            {walletInfo?.configured && walletInfo.address && (
              <div className="deposit-wallet">
                <span>Deposit USDC/SOL to</span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(walletInfo.address!);
                    setNotice('Admin wallet copied');
                  }}
                >
                  <code>{mask(walletInfo.address, 10, 8)}</code>
                  <Clipboard size={14} />
                </button>
              </div>
            )}

            <div className="draw-search">
              <label>
                <span>Draw ID</span>
                <input value={drawId} onChange={(e) => setDrawId(e.target.value)} placeholder="550e8400-..." />
              </label>
              <button className="primary" type="button" onClick={() => loadWinners()} disabled={!authenticated || busy === 'winners'}>
                {busy === 'winners' ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                Load winners
              </button>
            </div>
          </div>

          <div className="panel winners-panel">
            <div className="panel-header split">
              <div className="title-row">
                <WalletCards size={22} />
                <div>
                  <h2>Winners</h2>
                  <p>{drawId || 'Select a draw'}</p>
                </div>
              </div>
              <div className="row-actions">
                <button className="secondary" type="button" onClick={() => loadWinners()} disabled={!authenticated || !drawId || busy === 'winners'}>
                  {busy === 'winners' ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                  Refresh
                </button>
                <button
                  className="primary"
                  type="button"
                  onClick={distributeAll}
                  title={distributionBlockedReason || undefined}
                  disabled={!authenticated || !drawId || pendingCount === 0 || busy === 'distribute' || Boolean(distributionBlockedReason)}
                >
                  {busy === 'distribute' ? <Loader2 className="spin" size={18} /> : <Zap size={18} />}
                  Distribute ({pendingCount})
                </button>
                <div className="devnet-test-controls">
                  <label className="inline-field">
                    <span>Devnet amount / winner</span>
                    <input
                      value={devnetCustomAmount}
                      onChange={(event) => setDevnetCustomAmount(event.target.value.replace(/[^0-9.]/g, ''))}
                      inputMode="decimal"
                      placeholder="Use prize"
                    />
                  </label>
                  <button
                    className="secondary devnet-button"
                    type="button"
                    onClick={distributeDevnetTest}
                    title="Send devnet test transfers only. Does not patch CapturGo settlement status or tx hash."
                    disabled={!authenticated || !drawId || pendingCount === 0 || busy === 'devnet-distribute' || devnetAmountInvalid}
                  >
                    {busy === 'devnet-distribute' ? <Loader2 className="spin" size={18} /> : <Zap size={18} />}
                    Devnet Test
                  </button>
                </div>
              </div>
            </div>

            {devnetAmountInvalid && (
              <div className="distribution-warning">
                <strong>Invalid devnet test amount</strong>
                <span>Enter a positive number like 0.01, or leave it empty to use each winner&apos;s prize amount.</span>
              </div>
            )}

            {distributionBlockedReason && pendingCount > 0 && (
              <div className="distribution-warning">
                <strong>Distribution blocked</strong>
                <span>{distributionBlockedReason}</span>
              </div>
            )}

            {distributeResults && (
              <div className="distribute-results">
                {lastDistributionMode === 'devnet' && (
                  <div className="devnet-test-banner">
                    Devnet test only. No settlement status or transaction hash was submitted to CapturGo.
                  </div>
                )}
                <div className="distribute-summary">
                  <span><strong>{settledResultCount}</strong> settled</span>
                  <span><strong>{failedResultCount}</strong> failed</span>
                  <span><strong>{skippedResultCount}</strong> skipped</span>
                </div>
                {distributeResults.map((r) => (
                  <div key={r.winnerId} className={`distribute-row ${r.status}`}>
                    <span className={`status ${r.status === 'settled' ? 'SETTLED' : r.status === 'failed' ? 'FAILED' : 'PENDING'}`}>
                      {r.status.toUpperCase()}
                    </span>
                    <span>{mask(r.winnerId, 8, 6)}</span>
                    <span>${r.prizeAmount} USDC</span>
                    {r.txHash && <code className="tx-small">{mask(r.txHash, 8, 8)}</code>}
                    {r.error && <span className="error-text">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Winner</th>
                    <th>Wallet</th>
                    <th>Prize</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {winners.length === 0 ? (
                    <tr><td colSpan={4} className="empty-cell">No winners loaded</td></tr>
                  ) : (
                    winners.map((winner) => {
                      const winnerId = getWinnerId(winner);
                      const winnerKey = getWinnerKey(winner);
                      const wallet = walletResolutions[winnerKey];
                      return (
                        <tr key={winnerId || winner.userId}>
                          <td>
                            <div className="winner-identity">
                              <strong className="winner-name">{winner.username || 'Unknown'}</strong>
                              {winner.email && <span className="winner-email">{winner.email}</span>}
                              <span className="winner-id">{mask(winnerId || winner.userId, 10, 8)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="wallet-cell">
                              {wallet?.address ? (
                                <>
                                  <button
                                    className="copy-wallet"
                                    type="button"
                                    onClick={() => {
                                      void navigator.clipboard.writeText(wallet.address!);
                                      setNotice('Wallet address copied');
                                    }}
                                  >
                                    <code>{mask(wallet.address, 8, 8)}</code>
                                    <Clipboard size={14} />
                                  </button>
                                  {wallet.source && <span className={`source-badge source-${wallet.source}`}>{wallet.source}</span>}
                                </>
                              ) : (
                                <>
                                  <span className="wallet-missing">No Solana wallet</span>
                                  {wallet?.error && <span className="wallet-error-inline">{wallet.error}</span>}
                                </>
                              )}
                            </div>
                          </td>
                          <td>${formatNumber(winner.prizeAmount)}</td>
                          <td>
                            <span className={`status ${winner.settlementStatus || 'PENDING'}`}>
                              {winner.settlementStatus || 'PENDING'}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </section>

      {(notice || error) && (
        <div className={`toast ${error ? 'error' : 'success'}`}>{error || notice}</div>
      )}
    </main>
  );
}
