# CapturGo Raffle Admin UI

Small web console for raffle settlement operations.

## Setup

```bash
cd reward-distribution/admin-ui
npm install
cp .env.example .env
npm run dev
```

Required env:

```env
VITE_CAPTURGO_API_BASE_URL=https://captur-api-208129623932.asia-east2.run.app/api/v1
VITE_PRIVY_APP_ID=cmj5wppqx00y8jo0cl794vgbz
VITE_RAFFLE_CAMPAIGN_ID=b59966be-20cd-484c-93a3-770295a16c62
VITE_ADMIN_EMAIL=admin@example.com
VITE_DEVICE_ID=your-device-id
VITE_DEVICE_TYPE=ios
```

## What It Does

- Sends Privy email OTP.
- Submits OTP and creates an authenticated Privy browser session.
- Calls `getAccessToken()` to show/copy the current JWT.
- Calls `GET /raffles/draws?limit=1&campaignId=<campaignId>`.
- Calls `GET /raffles/draws/{drawId}/winners`.
- Calls `PATCH /raffles/winners/{winnerId}/settlement` with `PROCESSING` or `SETTLED`.

The backend still needs to assign the admin role to the email used for Privy login.

The API currently enforces device headers. Set `VITE_DEVICE_ID` to the value expected by the backend for the target environment.
