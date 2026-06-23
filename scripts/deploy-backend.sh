#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
SERVICE_NAME="reward-backend"
HEALTH_URL="${HEALTH_URL:-}"

required_env=(
  CAPTURGO_API_BASE_URL
  CAPTURGO_RAFFLE_CAMPAIGN_ID
  CAPTURGO_DEVICE_ID
  CAPTURGO_DEVICE_TYPE
  NEXT_PUBLIC_PRIVY_APP_ID
  NEXT_PUBLIC_CAPTURGO_CAMPAIGN_ID
  REWARD_SOLANA_RPC_URL
  REWARD_SOLANA_PRIVATE_KEY
  REWARD_TOKEN_ADDRESS
  REWARD_TOKEN_DECIMALS
  REWARD_TOKEN_SYMBOL
  PRIVY_APP_ID
  PRIVY_APP_SECRET
)

usage() {
  cat <<USAGE
Usage: scripts/deploy-backend.sh [options]

Build and restart the CapturGo reward backend with Docker Compose.

Options:
  --env-file <path>   Env file to validate and pass to Compose. Default: .env
  --service <name>    Compose service name. Default: reward-backend
  --health-url <url>  Base URL to smoke-test. Default: http://127.0.0.1:3000
  -h, --help          Show this help text

Examples:
  scripts/deploy-backend.sh
  HOST_PORT=8080 scripts/deploy-backend.sh --health-url http://127.0.0.1:8080
USAGE
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "Missing value for $option" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      require_value "$1" "${2:-}"
      ENV_FILE="$2"
      shift 2
      ;;
    --service)
      require_value "$1" "${2:-}"
      SERVICE_NAME="$2"
      shift 2
      ;;
    --health-url)
      require_value "$1" "${2:-}"
      HEALTH_URL="${2%/}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required. Install Docker Desktop or the compose plugin." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for smoke tests." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the Docker daemon is not running." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it from .env.example and fill in deployment values." >&2
  exit 1
fi
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"

env_value() {
  local key="$1"
  grep -E "^[[:space:]]*${key}=" "$ENV_FILE" \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*${key}=//; s/[[:space:]]+#.*$//; s/^['\"]//; s/['\"]$//"
}

env_has_value() {
  local key="$1"
  env_value "$key" | grep -q '[^[:space:]]'
}

missing=()
for key in "${required_env[@]}"; do
  if ! env_has_value "$key"; then
    missing+=("$key")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required env values in $ENV_FILE:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

if [[ -z "$HEALTH_URL" ]]; then
  HOST_PORT="${HOST_PORT:-$(env_value HOST_PORT || true)}"
  HEALTH_URL="http://127.0.0.1:${HOST_PORT:-3000}"
fi

export APP_ENV_FILE="$ENV_FILE"

echo "Using env file: $ENV_FILE"
echo "Building and restarting Docker service: $SERVICE_NAME"

cd "$ROOT_DIR"
docker compose --env-file "$ENV_FILE" up --build -d "$SERVICE_NAME"

echo "Waiting for backend at $HEALTH_URL ..."
for attempt in {1..30}; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Backend is responding."
    break
  fi

  if [[ "$attempt" -eq 30 ]]; then
    echo "Backend did not respond after 30 seconds." >&2
    docker compose --env-file "$ENV_FILE" logs --tail=80 "$SERVICE_NAME" >&2
    exit 1
  fi

  sleep 1
done

echo "Checking wallet endpoint..."
curl -fsS "$HEALTH_URL/api/wallet" >/dev/null

echo "Deployment complete."
docker compose --env-file "$ENV_FILE" ps "$SERVICE_NAME"
