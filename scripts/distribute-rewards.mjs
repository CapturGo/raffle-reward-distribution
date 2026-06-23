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

loadDotEnv(path.join(rootDir, '.env'));

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
  const campaignId = args.campaignId ?? env('CAPTURGO_RAFFLE_CAMPAIGN_ID') ?? defaultCampaignId;
  const draw = args.drawId
    ? { id: args.drawId, campaignId, status: 'provided' }
    : await getLatestDraw(token, campaignId);

  console.log(`Draw: ${draw.id}`);
  console.log(`Campaign: ${campaignId}`);

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
  const tokenDecimals = numberEnv('REWARD_TOKEN_DECIMALS', 6);
  const tokenSymbol = env('REWARD_TOKEN_SYMBOL') ?? 'USDC';

  for (const winner of pendingWinners) {
    const prizeAmount = String(winner.prizeAmount ?? '').trim();
    const wallet = await resolveWinnerWallet(winner);

    if (!wallet) {
      skipped.push({
        winnerId: winner.id,
        email: winner.email ?? '',
        reason: 'No valid seekerWallet or Privy Solana wallet found',
      });
      continue;
    }

    requiredBalance += parseTokenAmount(prizeAmount, tokenDecimals, tokenSymbol);
    payouts.push({
      winnerId: winner.id,
      email: winner.email ?? '',
      prizeAmount,
      wallet: wallet.address,
      walletSource: wallet.source,
      settlementStatus: winner.settlementStatus ?? 'PENDING',
    });
  }

  printPlan(payouts, skipped, requiredBalance, tokenDecimals, tokenSymbol);

  if (args.command === 'plan' || args.dryRun) {
    console.log('Dry run only. No transactions or settlement API updates were sent.');
    return;
  }

  if (args.command !== 'distribute') {
    throw new Error(`Unknown command: ${args.command}`);
  }

  if (!args.yes) {
    throw new Error('Live reward distribution requires --yes');
  }

  if (payouts.length === 0) {
    console.log('No payable winners after wallet resolution.');
    return;
  }

  const solana = createSolanaClient({ tokenDecimals, tokenSymbol });
  const availableBalance = await solana.getTokenBalance();
  if (availableBalance < requiredBalance) {
    throw new Error(
      `Insufficient ${tokenSymbol} balance. Need ${formatTokenAmount(requiredBalance, tokenDecimals)} ${tokenSymbol}, available ${formatTokenAmount(availableBalance, tokenDecimals)} ${tokenSymbol}.`,
    );
  }

  console.log(`Funding wallet: ${solana.fundingAddress()}`);
  console.log(`Starting live distribution for ${payouts.length} payout(s).`);

  let settled = 0;
  let failed = 0;

  for (const payout of payouts) {
    let txHash = '';
    try {
      await updateSettlement(token, payout.winnerId, 'PROCESSING');
      await appendLedger({ event: 'processing', drawId: draw.id, ...payout });

      console.log(`Sending ${payout.prizeAmount} ${tokenSymbol} to ${mask(payout.wallet)} (${payout.winnerId})`);
      txHash = await solana.sendToken(payout.wallet, payout.prizeAmount);
      await appendLedger({ event: 'sent', drawId: draw.id, txHash, ...payout });

      await updateSettlement(token, payout.winnerId, 'SETTLED', txHash);
      await appendLedger({ event: 'settled', drawId: draw.id, txHash, ...payout });
      settled += 1;
      console.log(`Settled ${payout.winnerId}: ${txHash}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);

      if (txHash) {
        console.error(`Transaction was sent but settlement patch failed for ${payout.winnerId}: ${message}`);
        console.error(`Manual follow-up required. txHash=${txHash}`);
        await appendLedger({ event: 'settlement_patch_failed', drawId: draw.id, txHash, error: message, ...payout });
      } else {
        console.error(`Failed ${payout.winnerId}: ${message}`);
        await updateSettlement(token, payout.winnerId, 'FAILED').catch(() => {});
        await appendLedger({ event: 'failed', drawId: draw.id, error: message, ...payout });
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
    dryRun: false,
    yes: false,
    includeSettled: false,
    failFast: false,
    help: false,
  };

  const commands = new Set(['plan', 'distribute']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (commands.has(arg) && !parsed.command) parsed.command = arg;
    else if (arg === '--draw-id') parsed.drawId = requireArgValue(argv, ++index, arg);
    else if (arg === '--campaign-id') parsed.campaignId = requireArgValue(argv, ++index, arg);
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

function usage() {
  console.log(`Usage:
  npm run plan -- [--draw-id <id>] [--campaign-id <id>] [--include-settled]
  npm run distribute -- [--draw-id <id>] [--campaign-id <id>] [--dry-run]
  npm run distribute -- --yes [--draw-id <id>] [--campaign-id <id>] [--fail-fast]

What it does:
  1. Fetches raffle winners from CapturGo.
  2. Resolves each winner's Solana wallet from seekerWallet, then Privy email lookup.
  3. Sends token rewards from REWARD_SOLANA_PRIVATE_KEY.
  4. Patches CapturGo settlement status to PROCESSING, then SETTLED with txHash.
`);
}

async function getLatestDraw(token, campaignId) {
  const params = new URLSearchParams({ limit: '1', campaignId });
  const draws = await apiRequest(token, `/api/v1/raffles/draws?${params}`);
  const draw = draws[0];
  if (!draw) throw new Error('No draw returned by CapturGo API');
  return draw;
}

async function getWinners(token, drawId) {
  return apiRequest(token, `/api/v1/raffles/draws/${encodeURIComponent(drawId)}/winners`);
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

  const response = await fetch(`${requiredEnv('CAPTURGO_API_BASE_URL').replace(/\/+$/, '')}${pathName}`, {
    ...init,
    headers,
  });

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

function createSolanaClient({ tokenDecimals, tokenSymbol }) {
  const connection = new Connection(requiredEnv('REWARD_SOLANA_RPC_URL'), 'confirmed');
  const keypair = loadKeypair(requiredEnv('REWARD_SOLANA_PRIVATE_KEY'));
  const mint = new PublicKey(env('REWARD_TOKEN_ADDRESS') ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

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

function requiredEnv(key) {
  const value = env(key);
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function env(key) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}
