#!/usr/bin/env bash
# Deploy RecoverRoute (frontend + API server + shared logic) to the demo EC2 server.
# Lives at the repo root, next to frontend/, server/ and shared/.
#
# Usage:
#   ./deploy-ec2.sh              # build on the server, publish the frontend, restart the API
#   ./deploy-ec2.sh --rollback   # restore the previously live frontend and API code
#
# Nothing live is replaced unless the frontend build succeeds. The API's .env and SQLite data
# (server/.env, server/data/) stay on the server and are never overwritten.
set -euo pipefail

HOST="16.178.3.52"
SSH_USER="ubuntu"
SSH_KEY="$HOME/.ssh/roadshow-key.pem"
WEB_ROOT="/var/www/business-impact-bot"
REMOTE_APP="business-impact-bot"            # relative to the server user's home
SERVICE="recoverroute"                       # systemd unit running server/ on :8787

AWS_PROFILE_NAME="sush"
AWS_REGION_NAME="ap-southeast-2"
SECURITY_GROUP="sg-02d8a67a2a5be8c47"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SSH=(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$SSH_USER@$HOST")

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY"
for d in frontend server shared; do
  [ -f "$REPO_ROOT/$d/package.json" ] || die "No $d/package.json next to this script ($REPO_ROOT)"
done

if ! "${SSH[@]}" true 2>/dev/null; then
  die "Can't SSH to $HOST. If your internet IP changed, allow the new one with:
  aws ec2 authorize-security-group-ingress --profile $AWS_PROFILE_NAME --region $AWS_REGION_NAME \\
    --group-id $SECURITY_GROUP --protocol tcp --port 22 --cidr \$(curl -s https://checkip.amazonaws.com)/32"
fi

verify() {
  log "Verifying https://$HOST/"
  local html asset
  html=$(curl -fsS --max-time 15 "https://$HOST/") || die "Site did not respond over HTTPS"
  asset=$(grep -oE '/assets/[^"]+\.js' <<<"$html" | head -1 || true)
  [ -n "$asset" ] || die "Live index.html references no JS bundle"
  curl -fsS -o /dev/null --max-time 15 "https://$HOST$asset" || die "Bundle $asset is not reachable"
  # The API can take a moment to come back after a restart
  for _ in 1 2 3 4 5 6; do
    curl -fsS -o /dev/null --max-time 5 "https://$HOST/api/health" && { BUNDLE=$asset; return; }
    sleep 2
  done
  die "API is not healthy: https://$HOST/api/health (check: ssh in, then journalctl -u $SERVICE -n 50)"
}

if [ "${1:-}" = "--rollback" ]; then
  log "Rolling back $HOST to the previous build"
  "${SSH[@]}" bash -s -- "$REMOTE_APP" "$WEB_ROOT" "$SERVICE" <<'REMOTE'
set -euo pipefail
APP="$HOME/$1"; WEB_ROOT="$2"; SERVICE="$3"
sudo test -d "$WEB_ROOT.prev" && test -d "$APP.prev" || { echo 'No previous build to roll back to' >&2; exit 1; }
sudo rsync -a --delete "$WEB_ROOT.prev/" "$WEB_ROOT/"
rsync -a --delete --exclude .env --exclude data --exclude node_modules "$APP.prev/" "$APP/"
sudo systemctl restart "$SERVICE"
REMOTE
  verify
  log "Rolled back: https://$HOST/"
  exit 0
fi

COMMIT=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "no-git")
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- frontend server shared 2>/dev/null)" ]; then
  COMMIT="$COMMIT+uncommitted"
fi
log "Deploying @ $COMMIT"

# 1. Upload source to a staging folder on the server
log "Uploading to $HOST"
"${SSH[@]}" "rm -rf ~/$REMOTE_APP.new && mkdir -p ~/$REMOTE_APP.new"
COPYFILE_DISABLE=1 tar -C "$REPO_ROOT" --no-xattrs \
    --exclude node_modules --exclude dist --exclude .git --exclude .DS_Store \
    --exclude 'server/data' --exclude 'server/.env' -czf - frontend server shared \
  | "${SSH[@]}" "tar -C ~/$REMOTE_APP.new -xzf - --warning=no-unknown-keyword"

# 2. Build on the server; publish only if the build succeeds
log "Building on server"
"${SSH[@]}" bash -s -- "$REMOTE_APP" "$WEB_ROOT" "$SERVICE" <<'REMOTE'
set -euo pipefail
APP="$HOME/$1"; WEB_ROOT="$2"; SERVICE="$3"
NEW="$APP.new"

cd "$NEW/frontend"
npm ci --no-audit --no-fund --loglevel=error
npm run build
[ -f dist/index.html ] || { echo "Build produced no dist/index.html" >&2; exit 1; }

# Keep the current live build for --rollback
sudo rsync -a --delete "$WEB_ROOT/" "$WEB_ROOT.prev/"
rsync -a --delete --exclude .env --exclude data --exclude node_modules "$APP/" "$APP.prev/"

# Publish the frontend
sudo rsync -a --delete dist/ "$WEB_ROOT/"
sudo chown -R www-data:www-data "$WEB_ROOT"

# Publish server/ and shared/ (server/.env, server/data and node_modules are kept), then restart the API
rsync -a --delete --exclude .env --exclude data --exclude node_modules "$NEW/server/" "$APP/server/"
rsync -a --delete "$NEW/shared/" "$APP/shared/"
rsync -a --delete --exclude node_modules --exclude dist "$NEW/frontend/" "$APP/frontend/"
sudo systemctl restart "$SERVICE"

rm -rf "$NEW"
REMOTE

# 3. Check the live site and API
verify
log "Deployed $COMMIT: https://$HOST/  (bundle $BUNDLE)"
