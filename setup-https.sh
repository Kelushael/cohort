#!/bin/bash
# Configure nginx + Let's Encrypt for AXIS MUNDI
set -e

DOMAIN="markyninox.com"
EMAIL="root@${DOMAIN}"
VPS_IP=$(curl -s https://api.ipify.org)

echo "=== Setting up HTTPS for AXIS MUNDI ==="
echo "Domain: ${DOMAIN}"
echo "VPS IP: ${VPS_IP}"

# Check DNS resolves to this VPS
RESOLVED=$(dig +short "$DOMAIN" | tail -1)
if [ "$RESOLVED" != "$VPS_IP" ]; then
  echo ""
  echo "WARNING: ${DOMAIN} resolves to ${RESOLVED}, but this VPS is ${VPS_IP}"
  echo "Point your DNS A record for ${DOMAIN} -> ${VPS_IP} before running certbot."
  echo ""
  echo "Continuing with nginx config (skipping certbot until DNS is ready)..."
  SKIP_CERTBOT=1
fi

# Install nginx + certbot if needed
apt-get install -y nginx certbot python3-certbot-nginx dnsutils 2>/dev/null

# Write nginx config
cat > /etc/nginx/sites-available/axis-mcp << 'NGINXEOF'
server {
    listen 80;
    server_name markyninox.com www.markyninox.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/axis-mcp /etc/nginx/sites-enabled/axis-mcp
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

if [ "${SKIP_CERTBOT}" = "1" ]; then
  echo ""
  echo "nginx is configured. Once DNS is pointed to ${VPS_IP}, run:"
  echo "  certbot --nginx -d ${DOMAIN} -d www.${DOMAIN} --non-interactive --agree-tos -m ${EMAIL} --redirect"
  echo ""
  echo "HTTP test (no TLS yet): http://${DOMAIN}/health"
  exit 0
fi

echo "Getting Let's Encrypt certificate..."
certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo ""
echo "=== HTTPS setup complete ==="
echo "MCP:    https://${DOMAIN}/mcp"
echo "Health: https://${DOMAIN}/health"
echo ""
echo "Add to Claude.ai:"
echo "  Settings -> Connectors -> Add custom connector"
echo "  Name: AXIS"
echo "  URL:  https://markyninox.com/mcp"
