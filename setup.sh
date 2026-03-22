#!/usr/bin/env bash
# First-time setup for Oracle Cloud deployment.
# Usage: bash setup.sh <domain> <email>
# Example: bash setup.sh 1.2.3.4.sslip.io admin@example.com
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
    echo "Usage: $0 <domain> <email>"
    echo ""
    echo "Tip: use <YOUR_PUBLIC_IP>.sslip.io as domain (no custom domain needed)"
    echo "Example: $0 1.2.3.4.sslip.io admin@example.com"
    exit 1
fi

# Replace YOUR_DOMAIN placeholder in nginx config
sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" nginx/nginx.conf

# Create dummy self-signed cert so nginx can start before the real cert exists
CERT_DIR="data/certbot/conf/live/${DOMAIN}"
mkdir -p "${CERT_DIR}" data/certbot/www

openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "${CERT_DIR}/privkey.pem" \
    -out    "${CERT_DIR}/fullchain.pem" \
    -subj '/CN=localhost' 2>/dev/null

# Start database, app, and nginx (nginx uses the dummy cert)
docker compose up -d db app nginx

echo "Waiting for app to be ready..."
sleep 10

# Obtain real Let's Encrypt certificate
docker compose run --rm certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --email "${EMAIL}" \
    --agree-tos \
    --no-eff-email \
    -d "${DOMAIN}"

# Reload nginx with the real cert
docker compose exec nginx nginx -s reload

echo ""
echo "Setup complete!"
echo "  App:     https://${DOMAIN}"
echo ""
echo "Next steps:"
echo "  1. Set BASE_URL=https://${DOMAIN} in your .env"
echo "  2. Set LINE webhook URL to: https://${DOMAIN}/webhook"
echo "  3. Renew certs automatically: add to crontab:"
echo "     0 3 * * * cd $(pwd) && docker compose run --rm certbot renew && docker compose exec nginx nginx -s reload"
