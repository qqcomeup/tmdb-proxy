# TMDB Proxy

Zero-dependency Node.js proxy for TMDB API and image requests, with optional memory/disk cache and an admin dashboard.

## Configuration

Copy the example environment file and fill in your own values:

```bash
cp .env.example .env
```

Required variables:

- `TMDB_API_KEY`: your TMDB API key.
- `ADMIN_API_KEY`: administrator key for admin endpoints.

## Run with Docker Compose

```bash
docker compose up -d --build
```

By default, the service binds to `127.0.0.1:54321`. Override with:

```bash
BIND_ADDRESS=0.0.0.0 PORT=54321 docker compose up -d --build
```

## Run locally

```bash
npm start
```

## Endpoints

- `/health` or `/ping`: health check.
- `/t/p/...`: TMDB image proxy.
- `/3/...`: TMDB API proxy.
- `/admin/dashboard`: admin dashboard.
