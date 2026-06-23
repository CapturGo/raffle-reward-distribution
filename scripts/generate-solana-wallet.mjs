#!/usr/bin/env node
/**
 * Generates a new Solana keypair for use as the reward distribution funding wallet.
 * Run: node scripts/generate-solana-wallet.mjs
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const keypair = Keypair.generate();
const publicKey = keypair.publicKey.toBase58();
const privateKeyBase58 = bs58.encode(keypair.secretKey);
const privateKeyJson = JSON.stringify(Array.from(keypair.secretKey));

console.log('');
console.log('✅ New Solana wallet generated');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Public key (address):  ${publicKey}`);
console.log('');
console.log('  Private key (Base58) — paste this into .env as REWARD_SOLANA_PRIVATE_KEY:');
console.log(`  ${privateKeyBase58}`);
console.log('');
console.log('  Private key (JSON array) — compatible with solana-keygen:');
console.log(`  ${privateKeyJson}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('  ⚠️  Save the private key somewhere safe. It will not be shown again.');
console.log('  ⚠️  Only fund this wallet with the amount needed for payouts.');
console.log('');
console.log('  Next steps:');
console.log('  1. Copy the Base58 private key into your .env:');
console.log('       REWARD_SOLANA_PRIVATE_KEY=<private key>');
console.log(`  2. Fund this wallet with USDC on Solana mainnet: ${publicKey}`);
console.log('  3. Run: npm run plan -- --draw-id <id>');
console.log('');
