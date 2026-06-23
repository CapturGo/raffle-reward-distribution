import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';

const USDC_MINT = process.env.REWARD_TOKEN_ADDRESS ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_DECIMALS = Number(process.env.REWARD_TOKEN_DECIMALS ?? '6');
const TOKEN_SYMBOL = process.env.REWARD_TOKEN_SYMBOL ?? 'USDC';

type SolanaClientOptions = {
  rpcUrl?: string;
  privateKey?: string;
  tokenAddress?: string;
  tokenDecimals?: number;
  tokenSymbol?: string;
};

export function parseTokenAmount(
  amount: string | number,
  tokenDecimals = TOKEN_DECIMALS,
  tokenSymbol = TOKEN_SYMBOL,
): bigint {
  const normalized = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error(`Invalid ${tokenSymbol} amount: ${amount}`);

  const [whole, fraction = ''] = normalized.split('.');
  const paddedFraction = fraction.padEnd(tokenDecimals, '0').slice(0, tokenDecimals);
  return BigInt(whole) * 10n ** BigInt(tokenDecimals) + BigInt(paddedFraction || '0');
}

export function formatTokenAmount(amount: bigint, tokenDecimals = TOKEN_DECIMALS): string {
  const divisor = 10n ** BigInt(tokenDecimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(tokenDecimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function createSolanaClient(options: SolanaClientOptions = {}) {
  const rpcUrl = options.rpcUrl ?? process.env.REWARD_SOLANA_RPC_URL;
  const privateKeyRaw = options.privateKey ?? process.env.REWARD_SOLANA_PRIVATE_KEY;
  const tokenAddress = options.tokenAddress ?? USDC_MINT;
  const tokenDecimals = options.tokenDecimals ?? TOKEN_DECIMALS;
  const tokenSymbol = options.tokenSymbol ?? TOKEN_SYMBOL;

  if (!rpcUrl || !privateKeyRaw) {
    throw new Error('Missing REWARD_SOLANA_RPC_URL or REWARD_SOLANA_PRIVATE_KEY');
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const keypair = loadKeypair(privateKeyRaw);
  const mint = new PublicKey(tokenAddress);

  return {
    fundingAddress: () => keypair.publicKey.toBase58(),
    tokenSymbol: () => tokenSymbol,
    tokenDecimals: () => tokenDecimals,

    async getUsdcBalance(): Promise<bigint> {
      const senderAta = getAssociatedTokenAddressSync(mint, keypair.publicKey);
      try {
        const account = await getAccount(connection, senderAta);
        return account.amount;
      } catch {
        return 0n;
      }
    },

    async sendUsdc(recipientAddress: string, amount: string): Promise<string> {
      const recipient = new PublicKey(recipientAddress);
      const lamports = parseTokenAmount(amount, tokenDecimals, tokenSymbol);

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
          lamports,
          tokenDecimals,
        ),
      );

      return sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
    },
  };
}

export function isValidSolanaAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function loadKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return Keypair.fromSecretKey(Buffer.from(trimmed, 'hex'));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}
