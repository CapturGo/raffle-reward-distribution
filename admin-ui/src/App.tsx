import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
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
  WalletCards,
} from 'lucide-react';
import { RaffleApi } from './api';
import type { RaffleDraw, RaffleWinner, SettlementStatus } from './types';

const configuredApiBase =
  (import.meta.env.VITE_CAPTURGO_API_BASE_URL as string | undefined)
  || 'https://captur-api-208129623932.asia-east2.run.app/api/v1';
const configuredAdminEmail = (import.meta.env.VITE_ADMIN_EMAIL as string | undefined) || '';
const configuredCampaignId =
  (import.meta.env.VITE_RAFFLE_CAMPAIGN_ID as string | undefined)
  || 'b59966be-20cd-484c-93a3-770295a16c62';
const configuredDeviceId = (import.meta.env.VITE_DEVICE_ID as string | undefined) || '';
const configuredDeviceType = (import.meta.env.VITE_DEVICE_TYPE as string | undefined) || 'ios';

type BusyAction =
  | 'send-code'
  | 'login'
  | 'token'
  | 'draw'
  | 'winners'
  | `settle-${string}`
  | `processing-${string}`;

type SettlementDraft = {
  status: SettlementStatus;
  txHash: string;
};

function getWinnerId(winner: RaffleWinner): string {
  return winner.id?.trim() || '';
}

function formatNumber(value: string | number | undefined): string {
  if (value == null || value === '') return '-';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return String(value);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(numberValue);
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
  const linkedAccounts = (user as { linkedAccounts?: unknown[]; linked_accounts?: unknown[] } | null)?.linkedAccounts
    ?? (user as { linked_accounts?: unknown[] } | null)?.linked_accounts
    ?? [];
  const emailAccount = linkedAccounts.find((account) => {
    const candidate = account as { type?: string };
    return candidate.type === 'email';
  }) as { address?: string; email?: string } | undefined;

  return emailAccount?.address ?? emailAccount?.email ?? configuredAdminEmail ?? '';
}

export function App() {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const { sendCode, loginWithCode, state: otpState } = useLoginWithEmail();

  const [apiBaseUrl, setApiBaseUrl] = useState(() => {
    return localStorage.getItem('capturgo-raffle-api-base-url') || configuredApiBase || '';
  });
  const [campaignId, setCampaignId] = useState(() => {
    return localStorage.getItem('capturgo-raffle-campaign-id') || configuredCampaignId;
  });
  const [deviceId, setDeviceId] = useState(() => {
    return localStorage.getItem('capturgo-raffle-device-id') || configuredDeviceId;
  });
  const [deviceType, setDeviceType] = useState(() => {
    return localStorage.getItem('capturgo-raffle-device-type') || configuredDeviceType;
  });
  const [email, setEmail] = useState(configuredAdminEmail || '');
  const [otp, setOtp] = useState('');
  const [jwt, setJwt] = useState('');
  const [showJwt, setShowJwt] = useState(false);
  const [latestDraw, setLatestDraw] = useState<RaffleDraw | null>(null);
  const [drawId, setDrawId] = useState('');
  const [winners, setWinners] = useState<RaffleWinner[]>([]);
  const [settlementDrafts, setSettlementDrafts] = useState<Record<string, SettlementDraft>>({});
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (apiBaseUrl.trim()) {
      localStorage.setItem('capturgo-raffle-api-base-url', apiBaseUrl.trim());
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (campaignId.trim()) {
      localStorage.setItem('capturgo-raffle-campaign-id', campaignId.trim());
    }
  }, [campaignId]);

  useEffect(() => {
    if (deviceId.trim()) {
      localStorage.setItem('capturgo-raffle-device-id', deviceId.trim());
    }
  }, [deviceId]);

  useEffect(() => {
    if (deviceType.trim()) {
      localStorage.setItem('capturgo-raffle-device-type', deviceType.trim());
    }
  }, [deviceType]);

  useEffect(() => {
    if (authenticated) {
      const resolved = getEmail(user);
      if (resolved) setEmail(resolved);
    }
  }, [authenticated, user]);

  const deviceHeaders = useCallback(() => {
    return {
      'X-Device-ID': deviceId.trim(),
      'X-Device-Type': deviceType.trim() || 'ios',
      'X-App-Version': 'raffle-admin-ui',
    };
  }, [deviceId, deviceType]);

  const api = useMemo(
    () => new RaffleApi(apiBaseUrl, getAccessToken, deviceHeaders, campaignId),
    [apiBaseUrl, getAccessToken, deviceHeaders, campaignId],
  );

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
      setNotice('Privy login successful');
    });
  }

  async function handleLoadToken() {
    await run('token', async () => {
      const token = await getAccessToken();
      if (!token) throw new Error('Privy did not return a token. Check login state.');
      setJwt(token);
      setNotice('JWT refreshed');
    });
  }

  async function copyJwt() {
    if (!jwt) return;
    await navigator.clipboard.writeText(jwt);
    setNotice('JWT copied');
  }

  async function loadLatestDraw() {
    await run('draw', async () => {
      const draw = await api.getLatestDraw();
      setLatestDraw(draw);
      setDrawId(draw?.id ?? '');
      setWinners([]);
      setSettlementDrafts({});
      setNotice(draw ? 'Latest draw loaded' : 'No draws returned');
    });
  }

  async function loadWinners(targetDrawId = drawId) {
    await run('winners', async () => {
      if (!targetDrawId.trim()) throw new Error('Draw ID is required');
      const response = await api.getWinners(targetDrawId.trim());
      setWinners(response);
      setSettlementDrafts((current) => {
        const next = { ...current };
        for (const winner of response) {
          const id = getWinnerId(winner);
          if (id && !next[id]) {
            next[id] = {
              status: winner.settlementStatus === 'SETTLED' ? 'SETTLED' : 'SETTLED',
              txHash: winner.txHash ?? '',
            };
          }
        }
        return next;
      });
      setNotice(`${response.length} winner${response.length === 1 ? '' : 's'} loaded`);
    });
  }

  async function patchWinner(winner: RaffleWinner, status: SettlementStatus) {
    const winnerId = getWinnerId(winner);
    const draft = settlementDrafts[winnerId] ?? { status, txHash: '' };
    await run(status === 'PROCESSING' ? `processing-${winnerId}` : `settle-${winnerId}`, async () => {
      if (!winnerId) throw new Error('Winner payload is missing id. Ask backend to include raffle_winners.id.');
      if (status === 'SETTLED' && !draft.txHash.trim()) throw new Error('Tx hash is required for SETTLED.');
      await api.updateSettlement(winnerId, status, draft.txHash.trim());
      setNotice(`${winner.username || winner.userId} marked ${status}`);
      await loadWinners(drawId);
    });
  }

  function updateDraft(winnerId: string, patch: Partial<SettlementDraft>) {
    setSettlementDrafts((current) => ({
      ...current,
      [winnerId]: {
        status: current[winnerId]?.status ?? 'SETTLED',
        txHash: current[winnerId]?.txHash ?? '',
        ...patch,
      },
    }));
  }

  const pendingCount = winners.filter((winner) => (winner.settlementStatus ?? 'PENDING') === 'PENDING').length;
  const settledCount = winners.filter((winner) => winner.settlementStatus === 'SETTLED').length;
  const totalPrize = winners.reduce((sum, winner) => sum + (Number(winner.prizeAmount) || 0), 0);
  const tokenPreview = jwt ? (showJwt ? jwt : mask(jwt, 24, 18)) : 'No JWT loaded';

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">CapturGo Admin</p>
          <h1>Raffle Settlement Console</h1>
        </div>
        <div className={`session-pill ${authenticated ? 'is-on' : ''}`}>
          <ShieldCheck size={18} />
          {ready ? (authenticated ? 'Privy session active' : 'Not logged in') : 'Privy loading'}
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
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                placeholder="admin@example.com"
                disabled={authenticated || busy === 'send-code'}
              />
            </label>
            {!authenticated ? (
              <button className="primary" type="submit" disabled={!ready || !email.trim() || busy === 'send-code'}>
                {busy === 'send-code' ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                Send OTP
              </button>
            ) : null}
          </form>

          {!authenticated ? (
            <form className="stack" onSubmit={handleLogin}>
              <label>
                <span>OTP</span>
                <input
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 8))}
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
              <button className="secondary" type="button" onClick={handleLoadToken} disabled={busy === 'token'}>
                {busy === 'token' ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Get JWT
              </button>
              <div className="token-box">
                <code>{tokenPreview}</code>
                <div className="token-actions">
                  <button className="icon-button" type="button" onClick={() => setShowJwt((value) => !value)}>
                    {showJwt ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                  <button className="icon-button" type="button" onClick={copyJwt} disabled={!jwt}>
                    <Clipboard size={18} />
                  </button>
                </div>
              </div>
              <button
                className="ghost danger"
                type="button"
                onClick={() => {
                  setJwt('');
                  void logout();
                }}
              >
                <LogOut size={18} />
                Logout
              </button>
            </div>
          )}

          <div className="divider" />

          <label>
            <span>API Base URL</span>
            <input
              value={apiBaseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
              placeholder="https://.../api/v1"
            />
          </label>

          <label>
            <span>Campaign ID</span>
            <input
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
              placeholder="b59966be-20cd-484c-93a3-770295a16c62"
            />
          </label>

          <div className="device-grid">
            <label>
              <span>Device ID</span>
              <input
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
                placeholder="X-Device-ID"
              />
            </label>
            <label>
              <span>Device Type</span>
              <input
                value={deviceType}
                onChange={(event) => setDeviceType(event.target.value)}
                placeholder="ios"
              />
            </label>
          </div>
        </aside>

        <section className="main-grid">
          <div className="panel draw-panel">
            <div className="panel-header split">
              <div className="title-row">
                <Ticket size={22} />
                <div>
                  <h2>Latest Draw</h2>
                  <p>{latestDraw ? latestDraw.id : 'No draw loaded'}</p>
                </div>
              </div>
              <button className="secondary" type="button" onClick={loadLatestDraw} disabled={!authenticated || busy === 'draw'}>
                {busy === 'draw' ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Load
              </button>
            </div>

            <div className="stats-grid">
              <div>
                <span>Status</span>
                <strong>{latestDraw?.status ?? '-'}</strong>
              </div>
              <div>
                <span>Total Tickets</span>
                <strong>{formatNumber(latestDraw?.totalTickets)}</strong>
              </div>
              <div>
                <span>Total Winners</span>
                <strong>{latestDraw?.totalWinners ?? '-'}</strong>
              </div>
              <div>
                <span>Draw Date</span>
                <strong>{formatDate(latestDraw?.drawDate)}</strong>
              </div>
            </div>

            <div className="draw-search">
              <label>
                <span>Draw ID</span>
                <input value={drawId} onChange={(event) => setDrawId(event.target.value)} placeholder="550e8400..." />
              </label>
              <button className="primary" type="button" onClick={() => loadWinners()} disabled={!authenticated || busy === 'winners'}>
                {busy === 'winners' ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
                Winners
              </button>
            </div>
          </div>

          <div className="panel totals-panel">
            <div>
              <span>Loaded Winners</span>
              <strong>{winners.length}</strong>
            </div>
            <div>
              <span>Pending</span>
              <strong>{pendingCount}</strong>
            </div>
            <div>
              <span>Settled</span>
              <strong>{settledCount}</strong>
            </div>
            <div>
              <span>Prize Total</span>
              <strong>${formatNumber(totalPrize)}</strong>
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
              <button className="secondary" type="button" onClick={() => loadWinners()} disabled={!authenticated || !drawId || busy === 'winners'}>
                {busy === 'winners' ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Refresh
              </button>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Winner</th>
                    <th>Wallet</th>
                    <th>Tickets</th>
                    <th>Prize</th>
                    <th>Status</th>
                    <th>Tx Hash</th>
                    <th>Patch</th>
                  </tr>
                </thead>
                <tbody>
                  {winners.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="empty-cell">
                        No winners loaded
                      </td>
                    </tr>
                  ) : (
                    winners.map((winner) => {
                      const winnerId = getWinnerId(winner);
                      const draft = settlementDrafts[winnerId] ?? { status: 'SETTLED', txHash: winner.txHash ?? '' };
                      const settlementBusy = busy === `settle-${winnerId}`;
                      const processingBusy = busy === `processing-${winnerId}`;
                      return (
                        <tr key={winnerId || winner.userId}>
                          <td>
                            <div className="person">
                              <strong>{winner.username || 'Unknown'}</strong>
                              <span>{mask(winnerId || winner.userId, 10, 8)}</span>
                              {winner.email ? <span>{winner.email}</span> : null}
                            </div>
                          </td>
                          <td>
                            <div className="person">
                              <span>{mask(winner.walletAddress, 8, 6)}</span>
                              {winner.seekerWallet ? <span>{mask(winner.seekerWallet, 8, 6)}</span> : null}
                            </div>
                          </td>
                          <td>{formatNumber(winner.ticketsAtDraw)}</td>
                          <td>${formatNumber(winner.prizeAmount)}</td>
                          <td>
                            <span className={`status ${winner.settlementStatus || 'PENDING'}`}>{winner.settlementStatus || 'PENDING'}</span>
                          </td>
                          <td>
                            <input
                              className="tx-input"
                              value={draft.txHash}
                              onChange={(event) => updateDraft(winnerId, { txHash: event.target.value })}
                              placeholder="0x..."
                              disabled={!winnerId}
                            />
                          </td>
                          <td>
                            <div className="row-actions">
                              <button
                                className="secondary compact"
                                type="button"
                                onClick={() => patchWinner(winner, 'PROCESSING')}
                                disabled={!winnerId || processingBusy || winner.settlementStatus === 'SETTLED'}
                              >
                                {processingBusy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                                Processing
                              </button>
                              <button
                                className="primary compact"
                                type="button"
                                onClick={() => patchWinner(winner, 'SETTLED')}
                                disabled={!winnerId || settlementBusy || !draft.txHash.trim()}
                              >
                                {settlementBusy ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
                                Settled
                              </button>
                            </div>
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
        <div className={`toast ${error ? 'error' : 'success'}`}>
          {error || notice}
        </div>
      )}
    </main>
  );
}
