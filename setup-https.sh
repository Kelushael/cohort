#!/bin/bash
# Configure nginx + Let's Encrypt for AXIS MUNDI
set -e

DOMAIN="srv1589112.hstgr.cloud"
EMAIL="root@${DOMAIN}"

echo "=== Setting up HTTPS for AXIS MUNDI ==="

# Install nginx + certbot if needed
apt-get install -y nginx certbot python3-certbot-nginx 2>/dev/null

# Write nginx config
cat > /etc/nginx/sites-available/axis-mcp << 'EOF'
server {
    listen 80;
    server_name srv1589112.hstgr.cloud;

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
EOF

ln -sf /etc/nginx/sites-available/axis-mcp /etc/nginx/sites-enabled/axis-mcp
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

echo "Getting Let's Encrypt certificate..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo ""
echo "=== HTTPS setup complete ==="
echo "MCP: https://${DOMAIN}/mcp"
echo "Health: https://${DOMAIN}/health"
