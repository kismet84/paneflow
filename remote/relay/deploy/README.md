# Codex Pane Relay deployment

This directory is a self-contained Relay deployment package. It does not contain the Codex Pane desktop application or mobile business interface.

## Deploy

Requires Docker with Compose.

1. Point a domain name to the server and allow TCP 443. Allow TCP 80 when available; UDP 443 is optional.
2. Copy `.env.example` to `.env` and set `PANE_DOMAIN` to the domain name without a scheme or path. Keep `PANE_BASE_PATH=/` for a root deployment, or set a path such as `/codex-pane-relay` when sharing an existing domain.
3. Run:

```sh
docker compose up -d --build
docker compose ps
docker compose logs -f
```

4. Check `https://<your-domain>/health` for a root deployment or `https://<your-domain>/codex-pane-relay/health` for a path deployment.
5. In Codex Pane under Settings → Remote access, enter the relay base URL: `https://<your-domain>` for a root deployment or `https://<your-domain>/codex-pane-relay` for a path deployment.

If the server already has an HTTPS entry point, run `docker compose -f docker-compose.proxy.yml up -d --build`. Relay then listens only on `127.0.0.1:8787`. Configure the existing reverse proxy to preserve the configured path prefix when forwarding requests to that port.

For Nginx:

```nginx
location = /codex-pane-relay {
    return 301 /codex-pane-relay/;
}

location /codex-pane-relay/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Do not add a trailing `/` to `proxy_pass`; it would strip the path prefix required by the relay.

To update, replace the deployment package while preserving `.env`, then repeat the Compose startup command for your chosen deployment mode.
