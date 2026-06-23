#!/usr/bin/env node
import { mkdir, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { PrivyClient } from '@privy-io/server-auth';
import bs58 from 'bs58';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultCampaignId = 'b59966be-20cd-484c-93a3-770295a16c62';
const ictOffsetMs = 7 * 60 * 60 * 1000;
const externalEnv = new Set(Object.keys(process.env));

loadDotEnv(path.join(rootDir, '.env'), externalEnv);

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

if (!args.command) {
  usage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

async function main() {
  const token = requiredEnv('CAPTURGO_ADMIN_BEARER_TOKEN');
  const campaignId = args.campaignId || env('CAPTURGO_RAFFLE_CAMPAIGN_ID') || defaultCampaignId;
  const isDevnet = args.network === 'devnet';
  const tokenConfig = getTokenConfig(isDevnet);
  const draw = args.drawId
    ? { id: args.drawId, campaignId, status: 'provided' }
    : await getWeeklyCompletedDraw(token, campaignId, args.drawLimit);

  console.log(`Draw: ${draw.id}`);
  console.log(`Campaign: ${campaignId}`);
  console.log(`Draw status: ${draw.status ?? 'unknown'}`);
  if (draw.periodStart) console.log(`Draw period start: ${draw.periodStart}`);
  if (draw.periodEnd) console.log(`Draw period end: ${draw.periodEnd}`);
  console.log(`Network: ${isDevnet ? 'devnet test mode' : 'mainnet production mode'}`);
  if (isDevnet) console.log('Devnet mode never patches CapturGo settlement status.');

  const winners = await getWinners(token, draw.id);
  const pendingWinners = winners.filter((winner) => {
    if (!winner.id) return false;
    if (args.includeSettled) return true;
    return (winner.settlementStatus ?? 'PENDING') === 'PENDING';
  });

  if (pendingWinners.length === 0) {
    console.log('No pending winners to distribute.');
    return;
  }

  const payouts = [];
  const skipped = [];
  let requiredBalance = 0n;

  for (const winner of pendingWinners) {
    const prizeAmount = args.amount || String(winner.prizeAmount ?? '').trim();
    const wallet = await resolveWinnerWallet(winner);

    if (!wallet) {
      skipped.push({
        winnerId: winner.id,
        email: winner.email ?? '',
        reason: 'No valid seekerWallet, walletAddress, or Privy Solana wallet found',
      });
      continue;
    }

    requiredBalance += parseTokenAmount(prizeAmount, tokenConfig.tokenDecimals, tokenConfig.tokenSymbol);
    payouts.push({
      winnerId: winner.id,
      email: winner.email ?? '',
      prizeAmount,
      wallet: wallet.address,
      walletSource: wallet.source,
      settlementStatus: winner.settlementStatus ?? 'PENDING',
    });
  }

  printPlan(payouts, skipped, requiredBalance, tokenConfig.tokenDecimals, tokenConfig.tokenSymbol);

  if (args.command === 'plan' || args.dryRun) {
    console.log('Dry run only. No transactions or settlement API updates were sent.');
    return;
  }

  if (args.command !== 'distribute') {
    throw new Error(`Unknown command: ${args.command}`);
  }

  if (!args.yes) {
    throw new Error(`${isDevnet ? 'Devnet test distribution' : 'Live reward distribution'} requires --yes`);
  }

  if (payouts.length === 0) {
    throw new Error(
      `No payable winners after wallet resolution. ${skipped.length} pending winner(s) need seekerWallet, walletAddress, or email for Privy lookup before rewards can be sent.`,
    );
  }

  if (args.failFast && skipped.length > 0) {
    throw new Error(
      `${skipped.length} pending winner(s) are missing payout wallets. Refusing partial distribution because fail-fast is enabled.`,
    );
  }

  const solana = createSolanaClient(tokenConfig);
  const availableBalance = await solana.getTokenBalance();
  if (availableBalance < requiredBalance) {
    throw new Error(
      `Insufficient ${tokenConfig.tokenSymbol} balance. Need ${formatTokenAmount(requiredBalance, tokenConfig.tokenDecimals)} ${tokenConfig.tokenSymbol}, available ${formatTokenAmount(availableBalance, tokenConfig.tokenDecimals)} ${tokenConfig.tokenSymbol}.`,
    );
  }

  console.log(`Funding wallet: ${solana.fundingAddress()}`);
  console.log(`Starting ${isDevnet ? 'devnet test' : 'live'} distribution for ${payouts.length} payout(s).`);

  let settled = 0;
  let failed = 0;

  for (const payout of payouts) {
    let txHash = '';
    try {
      if (!isDevnet) {
        await updateSettlement(token, payout.winnerId, 'PROCESSING');
        await appendLedger({ event: 'processing', network: args.network, drawId: draw.id, ...payout });
      }

      console.log(`Sending ${payout.prizeAmount} ${tokenConfig.tokenSymbol} to ${mask(payout.wallet)} (${payout.winnerId})`);
      txHash = await solana.sendToken(payout.wallet, payout.prizeAmount);
      await appendLedger({ event: 'sent', network: args.network, drawId: draw.id, txHash, ...payout });

      if (!isDevnet) {
        await updateSettlement(token, payout.winnerId, 'SETTLED', txHash);
        await appendLedger({ event: 'settled', network: args.network, drawId: draw.id, txHash, ...payout });
      }
      settled += 1;
      console.log(`${isDevnet ? 'Devnet test sent' : 'Settled'} ${payout.winnerId}: ${txHash}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);

      if (txHash) {
        const event = isDevnet ? 'post_send_failed' : 'settlement_patch_failed';
        console.error(`Transaction was sent but ${isDevnet ? 'post-send handling' : 'settlement patch'} failed for ${payout.winnerId}: ${message}`);
        console.error(`Manual follow-up may be required. txHash=${txHash}`);
        await appendLedger({ event, network: args.network, drawId: draw.id, txHash, error: message, ...payout });
      } else {
        console.error(`Failed ${payout.winnerId}: ${message}`);
        if (!isDevnet) await updateSettlement(token, payout.winnerId, 'FAILED').catch(() => {});
        await appendLedger({ event: 'failed', network: args.network, drawId: draw.id, error: message, ...payout });
      }

      if (args.failFast) throw error;
    }
  }

  console.log(`Done. Settled: ${settled}. Failed: ${failed}. Skipped: ${skipped.length}.`);
}

function parseArgs(argv) {
  const parsed = {
    command: '',
    drawId: '',
    campaignId: '',
    network: 'mainnet',
    amount: '',
    drawLimit: 20,
    dryRun: false,
    yes: false,
    includeSettled: false,
    failFast: booleanEnv('REWARD_FAIL_FAST', false),
    help: false,
  };

  const commands = new Set(['plan', 'distribute']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commands.has(arg) && !parsed.command) parsed.command = arg;
    else if (arg === '--draw-id') parsed.drawId = requireArgValue(argv, ++index, arg);
    else if (arg === '--campaign-id') parsed.campaignId = requireArgValue(argv, ++index, arg);
    else if (arg === '--draw-limit') parsed.drawLimit = normalizePositiveInteger(requireArgValue(argv, ++index, arg), arg);
    else if (arg === '--network') parsed.network = parseNetwork(requireArgValue(argv, ++index, arg));
    else if (arg === '--devnet') parsed.network = 'devnet';
    else if (arg === '--amount') parsed.amount = normalizeAmount(requireArgValue(argv, ++index, arg));
    else if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--yes') parsed.yes = true;
    else if (arg === '--include-settled') parsed.includeSettled = true;
    else if (arg === '--fail-fast') parsed.failFast = true;
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function requireArgValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseNetwork(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mainnet' || normalized === 'devnet') return normalized;
  throw new Error('--network must be mainnet or devnet');
}

function normalizeAmount(value) {
  const amount = value.trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new Error('--amount must be a positive number');
  }
  return amount;
}

function normalizePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function usage() {
  console.log(`Usage:
  npm run plan -- [--draw-id <id>] [--campaign-id <id>] [--draw-limit <n>] [--include-settled]
  npm run distribute -- [--draw-id <id>] [--campaign-id <id>] [--draw-limit <n>] [--dry-run]
  npm run distribute -- --yes [--draw-id <id>] [--campaign-id <id>] [--draw-limit <n>] [--fail-fast]
  npm run plan:devnet -- [--draw-id <id>] [--amount <amount>]
  npm run distribute:devnet -- --yes [--draw-id <id>] [--amount <amount>]

What it does:
  1. Selects the latest completed weekly draw whose period ended before Monday 00:00 ICT.
  2. Fetches raffle winners from CapturGo.
  3. Resolves each winner's Solana wallet from seekerWallet, walletAddress, then Privy email lookup.
  4. Sends token rewards from REWARD_SOLANA_PRIVATE_KEY.
  5. Patches CapturGo settlement status to PROCESSING, then SETTLED with txHash.

Devnet mode:
  Uses DEVNET_SOLANA_PRIVATE_KEY, DEVNET_SOLANA_RPC_URL, DEVNET_TOKEN_ADDRESS,
  DEVNET_TOKEN_DECIMALS, and DEVNET_TOKEN_SYMBOL. It sends devnet tokens only
  and never patches CapturGo settlement status.
`);
}

async function getWeeklyCompletedDraw(token, campaignId, limit) {
  const draws = await getDraws(token, campaignId, limit);
  if (draws.length === 0) throw new Error('No draws returned by CapturGo API');

  const weekStartUtc = getCurrentIctWeekStartUtc(new Date());
  console.log(`Current weekly payout boundary: ${weekStartUtc.toISOString()} (Monday 00:00 ICT)`);

  const completedDraws = draws
    .filter(isCompletedDraw)
    .sort((a, b) => getDrawSortTime(b) - getDrawSortTime(a));

  if (completedDraws.length === 0) {
    throw new Error(`No completed draws found in the latest ${draws.length} draw(s). Use --draw-id <id> to override.`);
  }

  const eligibleDraw = completedDraws.find((draw) => getDrawEndTime(draw) < weekStartUtc.getTime());
  if (eligibleDraw) return eligibleDraw;

  const fallback = completedDraws[0];
  console.warn('No completed draw ended before the current Monday 00:00 ICT boundary.');
  console.warn(`Falling back to latest completed draw: ${fallback.id}. Use --draw-id to choose explicitly.`);
  return fallback;
}

async function getDraws(token, campaignId, limit) {
  const params = new URLSearchParams({ limit: String(limit), campaignId });
  return apiRequest(token, `/api/v1/raffles/draws?${params}`);
}

async function getWinners(token, drawId) {
  return apiRequest(token, `/api/v1/raffles/draws/${encodeURIComponent(drawId)}/winners`);
}

function isCompletedDraw(draw) {
  const status = String(draw.status ?? '').toUpperCase();
  return status === 'COMPLETED' || status === 'COMPLETE' || status === 'FINISHED' || status === 'CLOSED';
}

function getDrawEndTime(draw) {
  return parseDateMs(draw.periodEnd ?? draw.drawDate ?? draw.snapshotTime);
}

function getDrawSortTime(draw) {
  return parseDateMs(draw.drawDate ?? draw.periodEnd ?? draw.snapshotTime);
}

function parseDateMs(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function getCurrentIctWeekStartUtc(now) {
  const shifted = new Date(now.getTime() + ictOffsetMs);
  const dayOfWeek = shifted.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const localMidnight = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return new Date(localMidnight - daysSinceMonday * 24 * 60 * 60 * 1000 - ictOffsetMs);
}

async function updateSettlement(token, winnerId, status, txHash) {
  await apiRequest(token, `/api/v1/raffles/winners/${encodeURIComponent(winnerId)}/settlement`, {
    method: 'PATCH',
    body: JSON.stringify({ status, txHash: txHash ?? null }),
  });
}

async function apiRequest(token, pathName, init = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Device-ID': env('CAPTURGO_DEVICE_ID') ?? '',
    'X-Device-Type': env('CAPTURGO_DEVICE_TYPE') ?? 'ios',
    'X-App-Version': 'raffle-admin-script',
  };
  if (init.body) headers['Content-Type'] = 'application/json';

  const url = `${requiredEnv('CAPTURGO_API_BASE_URL').replace(/\/+$/, '')}${pathName}`;
  let response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    const cause = error?.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new Error(`Network request failed for ${init.method ?? 'GET'} ${url}${cause}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`CapturGo ${init.method ?? 'GET'} ${pathName}: ${response.status} ${body}`);
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

let privyClient = null;

async function resolveWinnerWallet(winner) {
  const seekerWallet = winner.seekerWallet?.trim();
  if (seekerWallet && isValidSolanaAddress(seekerWallet)) {
    return { address: seekerWallet, source: 'seekerWallet' };
  }

  const walletAddress = winner.walletAddress?.trim();
  if (walletAddress && isValidSolanaAddress(walletAddress)) {
    return { address: walletAddress, source: 'walletAddress' };
  }

  const email = winner.email?.trim();
  if (!email) return null;

  if (!privyClient) {
    privyClient = new PrivyClient(requiredEnv('PRIVY_APP_ID'), requiredEnv('PRIVY_APP_SECRET'));
  }

  const user = await privyClient.getUserByEmail(email);
  const wallet = user?.linkedAccounts?.find(
    (account) => account.type === 'wallet' && account.chainType === 'solana',
  );
  const address = wallet?.address?.trim();

  return address && isValidSolanaAddress(address) ? { address, source: 'privy' } : null;
}

function getTokenConfig(isDevnet) {
  if (isDevnet) {
    return {
      network: 'devnet',
      rpcUrl: env('DEVNET_SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com',
      privateKey: env('DEVNET_SOLANA_PRIVATE_KEY') || env('REWARD_SOLANA_PRIVATE_KEY'),
      tokenAddress: env('DEVNET_TOKEN_ADDRESS') ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      tokenDecimals: numberEnv('DEVNET_TOKEN_DECIMALS', 6),
      tokenSymbol: env('DEVNET_TOKEN_SYMBOL') ?? 'USDC-devnet',
    };
  }

  return {
    network: 'mainnet',
    rpcUrl: env('REWARD_SOLANA_RPC_URL'),
    privateKey: env('REWARD_SOLANA_PRIVATE_KEY'),
    tokenAddress: env('REWARD_TOKEN_ADDRESS') ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenDecimals: numberEnv('REWARD_TOKEN_DECIMALS', 6),
    tokenSymbol: env('REWARD_TOKEN_SYMBOL') ?? 'USDC',
  };
}

function createSolanaClient(config) {
  if (!config.privateKey) throw new Error(`Missing ${config.network === 'devnet' ? 'DEVNET_SOLANA_PRIVATE_KEY or REWARD_SOLANA_PRIVATE_KEY' : 'REWARD_SOLANA_PRIVATE_KEY'}`);

  const connection = new Connection(config.rpcUrl, 'confirmed');
  const keypair = loadKeypair(config.privateKey);
  const mint = new PublicKey(config.tokenAddress);
  const { tokenDecimals, tokenSymbol } = config;

  return {
    fundingAddress: () => keypair.publicKey.toBase58(),

    async getTokenBalance() {
      const senderAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
      try {
        const account = await getAccount(connection, senderAta);
        return account.amount;
      } catch {
        return 0n;
      }
    },

    async sendToken(recipientAddress, amount) {
      const recipient = new PublicKey(recipientAddress);
      const rawAmount = parseTokenAmount(amount, tokenDecimals, tokenSymbol);
      const senderAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
      const recipientAta = getAssociatedTokenAddressSync(mint, recipient);
      const tx = new Transaction();

      const recipientAtaExists = await connection.getAccountInfo(recipientAta);
      if (!recipientAtaExists) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            keypair.publicKey,
            recipientAta,
            recipient,
            mint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }

      tx.add(
        createTransferCheckedInstruction(
          senderAta,
          mint,
          recipientAta,
          keypair.publicKey,
          rawAmount,
          tokenDecimals,
        ),
      );

      return sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    },
  };
}

function printPlan(payouts, skipped, requiredBalance, tokenDecimals, tokenSymbol) {
  console.log(`Payable winners: ${payouts.length}`);
  console.log(`Skipped winners: ${skipped.length}`);
  console.log(`Required balance: ${formatTokenAmount(requiredBalance, tokenDecimals)} ${tokenSymbol}`);

  console.table(
    payouts.map((payout) => ({
      winnerId: payout.winnerId,
      email: payout.email,
      wallet: mask(payout.wallet),
      source: payout.walletSource,
      prizeAmount: payout.prizeAmount,
      status: payout.settlementStatus,
    })),
  );

  if (skipped.length > 0) {
    console.log('Skipped:');
    console.table(skipped);
  }
}

async function appendLedger(entry) {
  const dir = path.join(rootDir, 'artifacts');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `ledger-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function parseTokenAmount(amount, tokenDecimals, tokenSymbol) {
  const normalized = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`Invalid ${tokenSymbol} amount: ${amount}`);
  const [whole, fraction = ''] = normalized.split('.');
  const paddedFraction = fraction.padEnd(tokenDecimals, '0').slice(0, tokenDecimals);
  return BigInt(whole) * 10n ** BigInt(tokenDecimals) + BigInt(paddedFraction || '0');
}

function formatTokenAmount(amount, tokenDecimals) {
  const divisor = 10n ** BigInt(tokenDecimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(tokenDecimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function loadKeypair(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) return Keypair.fromSecretKey(Buffer.from(trimmed, 'hex'));
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function isValidSolanaAddress(value) {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function mask(value, head = 8, tail = 6) {
  if (!value) return '';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function numberEnv(key, fallback) {
  const value = env(key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

function booleanEnv(key, fallback) {
  const value = env(key);
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new Error(`${key} must be true or false`);
}

function requiredEnv(key) {
  const value = env(key);
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function env(key) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function loadDotEnv(filePath, externalKeys) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (externalKeys.has(key)) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}
