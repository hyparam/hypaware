# Self-hosting Collectivus with Docker Compose

The reference [`docker-compose.yml`](../docker-compose.yml) in this repo
brings up two services that together implement the invite-and-join flow:

- **`central`** — the Collectivus server (`role: "server"`) listening on
  `:8788`. Hosts the admin API (`POST /v1/admin/invites`), the gateway
  bootstrap / refresh endpoints, and `GET /health`.
- **`rendezvous`** — the hosted-discovery service listening on `:8789`.
  Maps short join codes to the central server's connect URL, exposing
  `POST /v1/rendezvous/{invites,resolve}` and `GET /health`.

The compose file uses the public GHCR image
(`ghcr.io/hyparam/collectivus:latest`) for both services. All secrets are
resolved at runtime from the container environment (`*_env` fields in
the inline server config), so neither the compose YAML nor a `docker
inspect` dump exposes the tokens.

> Production deployments **must** terminate TLS in front of these
> services. The admin endpoint and the rendezvous registration endpoint
> both accept bearer tokens that are vulnerable to passive interception
> over plain HTTP. See [TLS](#tls) below.

## Prerequisites

- Docker Engine 24+ and the `docker compose` plugin (Compose v2).
- A host you can route public DNS to, with two reverse-proxied hostnames
  (one for central, one for rendezvous) if you want the join command
  printed by `ctvs invite create` to work from arbitrary networks. A
  single host with two DNS names — e.g. `collectivus.example.com` and
  `join.collectivus.example.com` — is the standard layout.
- A way to generate high-entropy secrets. `openssl rand -hex 32`
  produces a 64-character hex string suitable for the four token /
  secret variables described below.

## Walkthrough

### 1. Clone and prepare the environment file

```bash
git clone https://github.com/hyparam/collectivus.git
cd collectivus
cp .env.example .env
```

`.env` is gitignored — fill it in but never commit it.

### 2. Generate secrets

Open `.env` and set every variable. Each token / secret is rejected by
the config validator unless it is at least 32 characters; use a CSPRNG
to generate them, e.g.:

```bash
openssl rand -hex 32   # 64 hex chars = 32 bytes of entropy
```

| Variable | Notes |
|----------|-------|
| `COLLECTIVUS_ADMIN_TOKEN` | Bearer token the admin API requires on `POST /v1/admin/invites`. Operators paste this into `ctvs admin configure --admin-token …` on every host that runs `ctvs invite create`. |
| `COLLECTIVUS_IDENTITY_SECRET` | HMAC secret the central server uses to sign and verify gateway JWTs. Rotating it forces every gateway to re-bootstrap, so treat it as long-lived. |
| `COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN` | Shared bearer token the central server uses to register invites with rendezvous **and** that rendezvous requires on every registration. Compose passes the same value into both containers; they must match. |
| `COLLECTIVUS_RENDEZVOUS_URL` | Public URL of the rendezvous service. The central server POSTs registrations here, and `ctvs join` resolves the join code through this URL, so it must be reachable both from inside the `central` container and from end users. Typically the public HTTPS URL of a reverse proxy fronting port `8789`, e.g. `https://join.collectivus.example.com`. |
| `COLLECTIVUS_PUBLIC_URL` | Public URL of the central server. Baked into invite responses as the connect URL the gateway dials during bootstrap, so it must be reachable from gateway hosts. Reverse-proxy this to port `8788`, e.g. `https://collectivus.example.com`. |

> The four token / secret variables are validated at server boot.
> Anything shorter than 32 characters is rejected with an explicit error
> — the server will exit before it accepts requests.

### 3. Start the stack

```bash
docker compose up -d
docker compose ps
```

Compose creates two named volumes (`collectivus-server-data` and
`collectivus-rendezvous-data`) for persistent state. Both volumes are
owned by UID 1000 (the `node` user inside the image) on first start.

### 4. Verify the services are healthy

```bash
curl -fsS http://localhost:8788/health
# {"status":"ok","version":"…"}

curl -fsS http://localhost:8789/health
# {"status":"ok","version":"…"}
```

If either endpoint hangs or returns a non-2xx, jump to
[Troubleshooting](#troubleshooting) before continuing.

### 5. Issue the first invite

`ctvs invite create` is a client-side tool. Install it once (anywhere
that can reach the admin URL) and point it at the central server:

```bash
npm install -g collectivus

ctvs admin configure \
  --central https://collectivus.example.com \
  --admin-token "<your COLLECTIVUS_ADMIN_TOKEN>"

ctvs invite create --gateway-prefix gw-prod-1 --max-uses 5 --expires-in 24h
```

The admin command saves the central URL and token to
`~/.hyp/collectivus/admin.json` with `0600` permissions so future
`invite create` calls do not need to re-pass them.

The invite output looks like:

```
Join code:     ab12cd34ef56
Expires at:    2026-05-13T16:00:00.000Z
Max uses:      5
Gateway:       gw-prod-1
Rendezvous:    https://join.collectivus.example.com

Share this command:
  npx collectivus join ab12cd34ef56 --rendezvous https://join.collectivus.example.com
```

Share the printed `npx collectivus join …` command with the gateway
operator. Pass `--json` to `ctvs invite create` to get the machine-
readable shape if you are scripting against it.

## TLS

Both services bind plain HTTP inside their containers. Pick one of the
patterns below for the reverse proxy that terminates TLS — only the
proxy hostname / certificate paths change between deployments.

### Caddy

`Caddyfile` next to `docker-compose.yml`:

```caddyfile
collectivus.example.com {
    reverse_proxy central:8788
}

join.collectivus.example.com {
    reverse_proxy rendezvous:8789
}
```

Run Caddy as a third service in the same compose network and Caddy
handles cert issuance automatically (ACME). Drop the `ports:` mappings
on `central` / `rendezvous` so only Caddy is exposed to the public
internet.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name collectivus.example.com;

    ssl_certificate     /etc/letsencrypt/live/collectivus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/collectivus.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}

server {
    listen 443 ssl http2;
    server_name join.collectivus.example.com;

    ssl_certificate     /etc/letsencrypt/live/join.collectivus.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/join.collectivus.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8789;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### Traefik

If Traefik is already your edge proxy, attach the two services to its
network and add labels in `docker-compose.yml`:

```yaml
services:
  central:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.collectivus-central.rule=Host(`collectivus.example.com`)"
      - "traefik.http.routers.collectivus-central.entrypoints=websecure"
      - "traefik.http.routers.collectivus-central.tls.certresolver=le"
      - "traefik.http.services.collectivus-central.loadbalancer.server.port=8788"

  rendezvous:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.collectivus-rendezvous.rule=Host(`join.collectivus.example.com`)"
      - "traefik.http.routers.collectivus-rendezvous.entrypoints=websecure"
      - "traefik.http.routers.collectivus-rendezvous.tls.certresolver=le"
      - "traefik.http.services.collectivus-rendezvous.loadbalancer.server.port=8789"
```

After adding labels, remove the `ports:` mappings on the two services
so the only public ingress is Traefik.

## Operations

### Rotate the admin token

The admin token authorizes `POST /v1/admin/invites`. To rotate:

1. Generate a new token: `openssl rand -hex 32`.
2. Edit `.env` and set `COLLECTIVUS_ADMIN_TOKEN` to the new value.
3. `docker compose up -d central` — compose restarts the central
   service with the new token. The rendezvous service is unaffected.
4. On every host that runs `ctvs invite create`, re-run
   `ctvs admin configure --central <url> --admin-token <new-token>`.
   The old token is now rejected with `401`.

Existing invites and gateway JWTs are unaffected.

### Rotate the rendezvous registration token

The registration token is shared between `central` and `rendezvous`. To
rotate:

1. Generate a new token: `openssl rand -hex 32`.
2. Edit `.env` and set `COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN` to
   the new value.
3. `docker compose up -d` — both services restart with the new shared
   token.

Until both services have restarted, the central server may briefly fail
to register fresh invites against rendezvous. Already-registered
invites (and their join codes) continue to resolve, because the
registration token gates only the registration endpoint, not
`POST /v1/rendezvous/resolve`.

### Rotate the identity issuer secret

`COLLECTIVUS_IDENTITY_SECRET` signs gateway JWTs. Rotating it
invalidates every existing JWT and forces gateways to re-bootstrap.
Treat it as long-lived; rotate only on suspected compromise.

1. Generate a new secret: `openssl rand -hex 32`.
2. Update `.env`.
3. `docker compose up -d central`.
4. Re-bootstrap every gateway: issue a new invite and run the printed
   `npx collectivus join …` command on each gateway host.

### Back up the data volumes

Two named volumes hold persistent state:

| Volume | Mounted at | Contents |
|--------|------------|----------|
| `collectivus-server-data` | `/data` (central) | Recorded JSONL under `/data/ingested/`, the identity bootstrap store (`/data/bootstrap.json`), and per-gateway config. |
| `collectivus-rendezvous-data` | `/data/rendezvous` (rendezvous) | Rendezvous SQLite database of registered invite hashes. |

Tar-and-copy from a one-shot helper container is the supported pattern:

```bash
docker run --rm \
  -v collectivus-server-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf /backup/collectivus-server-data-$(date -u +%Y%m%d).tgz -C /data .

docker run --rm \
  -v collectivus-rendezvous-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf /backup/collectivus-rendezvous-data-$(date -u +%Y%m%d).tgz -C /data .
```

For point-in-time consistency on the rendezvous SQLite database, stop
the `rendezvous` service before the tar (`docker compose stop
rendezvous`); the server JSONL append-only files tolerate live backup.

Restore by extracting the tarballs into freshly-created volumes of the
same name before `docker compose up`.

## Troubleshooting

### `curl /health` on `:8788` or `:8789` hangs or refuses

Check container status first:

```bash
docker compose ps
docker compose logs central
docker compose logs rendezvous
```

The most common boot-time failure is a missing or invalid `.env`. The
central server writes an explicit error and exits when any of its
config secrets is unset or shorter than 32 characters — look for
`must be at least 32 characters` in the logs.

### `ctvs invite create` reports "failed to reach admin API"

The admin URL is unreachable from the host where you ran the command.
Confirm:

- DNS resolves `collectivus.example.com` to your TLS terminator.
- The terminator forwards `https://collectivus.example.com/v1/admin/invites`
  to `central:8788` on the compose network.
- Outbound from your operator host is not blocked.

`curl -fsS https://collectivus.example.com/health` from the same host
isolates the network path from the admin-token path.

### `ctvs invite create` reports `401`

The admin token sent by the client does not match `COLLECTIVUS_ADMIN_TOKEN`
on the server. Re-run `ctvs admin configure` with the value currently
in `.env`, then `ctvs admin status` to confirm the saved redaction
matches what you expect.

### `POST /v1/admin/invites` returns 5xx mentioning rendezvous

The central server could not register the invite with rendezvous.
Causes:

- `COLLECTIVUS_RENDEZVOUS_URL` is wrong, points at a non-existent host,
  or the rendezvous reverse proxy is down.
- `COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN` differs between the two
  services. Both containers must see the same value — verify with:

  ```bash
  docker compose exec central env | grep RENDEZVOUS
  docker compose exec rendezvous env | grep RENDEZVOUS
  ```

- The rendezvous service is reachable from the operator host but not
  from inside the `central` container. The `central` service connects
  to the value of `COLLECTIVUS_RENDEZVOUS_URL`, so a localhost-only URL
  will fail. Use the public URL (the same one end users see) or a
  container-network hostname such as `http://rendezvous:8789`.

### Gateways report "could not resolve join code"

The gateway is reaching rendezvous but the join code is unknown or
expired. Check:

- The join code has not exceeded `--max-uses`.
- The join code has not expired (`expires_at` is in the past).
- The gateway is dialing the rendezvous URL printed by `ctvs invite
  create` — not a stale URL from a previous deployment.

### Join succeeds but the gateway cannot fetch its config

Resolution via rendezvous worked, but the connect URL the gateway
received is not reachable. `COLLECTIVUS_PUBLIC_URL` is baked into
invite responses and the gateway dials it verbatim — confirm it
matches the public hostname of the central reverse proxy and is
reachable from wherever the gateway runs.
