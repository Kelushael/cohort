#!/bin/bash
# AXIS MUNDI — Deploy script
# Run this on the Hostinger VPS as root

set -e

echo "=== AXIS MUNDI Deploy ==="

# 1. Dependencies
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! command -v docker-compose &>/dev/null && ! docker compose version &>/dev/null 2>&1; then
  echo "Installing Docker Compose plugin..."
  apt-get update -qq && apt-get install -y docker-compose-plugin
fi

if ! command -v node &>/dev/null; then
  echo "Installing Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# 2. Clone or pull
TARGET="/opt/axis-mcp"
REPO="${AXIS_REPO:-https://github.com/kelushael/cohort.git}"
BRANCH="${AXIS_BRANCH:-claude/axis-mundi-mcp-server-C8r7c}"

if [ -d "$TARGET/.git" ]; then
  echo "Pulling latest..."
  cd "$TARGET"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  echo "Cloning repo..."
  git clone --branch "$BRANCH" "$REPO" "$TARGET"
  cd "$TARGET"
fi

# 3. Traefik ACME store
mkdir -p "$TARGET/traefik"
if [ ! -f "$TARGET/traefik/acme.json" ]; then
  touch "$TARGET/traefik/acme.json"
  chmod 600 "$TARGET/traefik/acme.json"
fi

# 4. Build & deploy
cd "$TARGET"
docker compose down --remove-orphans 2>/dev/null || true
docker compose build --no-cache
docker compose up -d

# 5. Verify
echo ""
echo "Waiting for health check..."
sleep 5
curl -sf http://localhost:3000/health && echo "" && echo "Health check passed."

echo ""
echo "=== Deploy complete ==="
echo "MCP endpoint: https://srv1589112.hstgr.cloud/mcp"
echo "Health:       https://srv1589112.hstgr.cloud/health"
echo ""
echo "Add to Claude.ai:"
echo "  Settings → Connectors → Add custom connector"
echo "  Name: AXIS"
echo "  URL:  https://srv1589112.hstgr.cloud/mcp"
