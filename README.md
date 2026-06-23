# CapturGo Reward Distribution

Standalone utility for settling raffle winners. It is intentionally separate from the Sui proof work and from the mobile app.

This expects the winners endpoint to return Rahul's updated payload with `id`, `email`, `seekerWallet`, `prizeAmount`, and `settlementStatus`.

## Flow

1. Fetch the latest completed draw with `GET /api/v1/raffles/draws?limit=1&campaignId=<campaignId>`.
2. Fetch draw winners with `GET /api/v1/raffles/draws/{drawId}/winners`.
3. Send Solana USDC transfers from the funding wallet.
4. Patch each winner with `PATCH /api/v1/raffles/winners/{winnerId}/settlement` using `{ "status": "SETTLED", "txHash": "<solana-signature>" }`.

Live distribution marks a winner `PROCESSING` before broadcasting and patches `SETTLED` after the transaction is confirmed. Payout address resolution uses a valid `seekerWallet` first; if `seekerWallet` is missing or invalid, it looks up the user's Solana wallet in Privy by `email`.

## Setup

```bash
cd reward-distribution
npm install
cp .env.example .env
```

Fill in:

- `CAPTURGO_API_BASE_URL`
- `CAPTURGO_ADMIN_BEARER_TOKEN`, from the Privy/admin login with required roles
- `CAPTURGO_RAFFLE_CAMPAIGN_ID`, currently `b59966be-20cd-484c-93a3-770295a16c62`
- `REWARD_SOLANA_RPC_URL`
- `REWARD_SOLANA_PRIVATE_KEY`, only for live distribution
- `REWARD_TOKEN_ADDRESS`, `REWARD_TOKEN_DECIMALS`, and `REWARD_TOKEN_SYMBOL`
- `PRIVY_APP_ID` and `PRIVY_APP_SECRET`, for server-side fallback lookup by email

## Admin UI

The web UI lives in `admin-ui`. It lets an admin log in with Privy email OTP, copy the current JWT, load the latest draw, load winners, and patch settlement status.

```bash
cd reward-distribution/admin-ui
npm install
cp .env.example .env
npm run dev
```

Or from this folder:

```bash
npm run admin:dev
```

Set these UI env vars:

- `VITE_PRIVY_APP_ID`
- `VITE_CAPTURGO_API_BASE_URL`, including `/api/v1`
- `VITE_RAFFLE_CAMPAIGN_ID`, currently `b59966be-20cd-484c-93a3-770295a16c62`
- `VITE_ADMIN_EMAIL`, optional default email
- `VITE_DEVICE_ID` and `VITE_DEVICE_TYPE`, for APIs protected by device locking

The JWT is generated in the browser by Privy after OTP login. The UI sends it only as `Authorization: Bearer <token>` to the configured CapturGo API.

## Docker

Build and run the backend container locally:

```bash
docker compose up --build
```

The service listens on `http://localhost:3000` and loads runtime configuration from `.env` through Compose. For hosted deployments, build the image and configure the same environment variables in your deployment platform instead of copying `.env` into the image:

```bash
docker build -t capturgo-reward-distribution .
docker run --env-file .env -p 3000:3000 capturgo-reward-distribution
```

The Docker image is a Next.js standalone production build. Server secrets such as `REWARD_SOLANA_PRIVATE_KEY` and `PRIVY_APP_SECRET` are intentionally injected at runtime.

`NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_CAPTURGO_CAMPAIGN_ID` are browser-exposed values, so Docker passes them as build args. Compose reads them from `.env`; hosted deployments should set them in the build environment.

### Automated Docker Deploy

For a VM or backend server with Docker installed, fill in `.env` and run:

```bash
npm run deploy:docker
```

The script validates required env values, builds the Docker image, restarts the `reward-backend` service, and smoke-tests `/` plus `/api/wallet`. To bind a different host port:

```bash
HOST_PORT=8080 npm run deploy:docker -- --health-url http://127.0.0.1:8080
```

To deploy with a different env file:

```bash
npm run deploy:docker -- --env-file /secure/path/reward-backend.env
```

### GitHub Actions Deploy

The workflow at `.github/workflows/deploy-backend.yml` runs the deploy script whenever `main` is pushed. It expects:

- A self-hosted GitHub Actions runner installed on the backend server.
- Docker and Docker Compose v2 installed on that server.
- A GitHub Actions secret named `REWARD_BACKEND_ENV` containing the full `.env` file contents.

Do not use `ubuntu-latest` for the real deploy unless the workflow SSHes into the backend server. GitHub-hosted runners are temporary, so any container started there disappears when the job ends.

## Commands

Preview the latest draw and pending payouts. This resolves winner wallets and prints the payout plan, but does not send transactions or patch settlements:

```bash
npm run plan
```

Preview a specific draw:

```bash
npm run plan -- --draw-id 550e8400-e29b-41d4-a716-446655440000
```

Send direct transfers and update the API:

```bash
npm run distribute -- --yes
```

Test with devnet USDC without updating CapturGo settlement status:

```bash
npm run plan:devnet -- --amount 0.01
npm run distribute:devnet -- --yes --amount 0.01
```

Live distribution does this for each pending winner:

1. Resolve Solana payout address from `seekerWallet`, then Privy email lookup.
2. Patch CapturGo settlement status to `PROCESSING`.
3. Send token reward from `REWARD_SOLANA_PRIVATE_KEY`.
4. Patch CapturGo settlement status to `SETTLED` with the Solana transaction hash.
5. Write an append-only local ledger entry under `artifacts/`.

Devnet distribution uses `DEVNET_SOLANA_RPC_URL`, `DEVNET_SOLANA_PRIVATE_KEY`, `DEVNET_TOKEN_ADDRESS`, `DEVNET_TOKEN_DECIMALS`, and `DEVNET_TOKEN_SYMBOL`. It still fetches the real draw and resolves real winner wallets, but sends devnet tokens only and never patches CapturGo settlement status.

## Safety Notes

- Live transfer refuses to run without `--yes`.
- Winners whose `settlementStatus` is not `PENDING` are skipped by default.
- `artifacts/ledger-*.jsonl` is append-only and records the local attempt status.
- If a transfer succeeds but the final API patch fails, the script prints the tx hash and records `settlement_patch_failed` in the ledger for manual follow-up.
