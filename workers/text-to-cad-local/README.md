# Local text-to-CAD worker

This worker runs STEP generation on this PC with Docker/Python. Supabase `cad-chat`
uses OpenRouter to generate build123d Python, then sends that source to this
worker for STEP/STL export.

## Run locally

```powershell
$env:TEXT_TO_CAD_WORKER_TOKEN="<random shared token>"
docker compose -f workers/text-to-cad-local/docker-compose.yml up --build -d
curl.exe http://127.0.0.1:8787/health
```

## Expose to Supabase

Supabase runs in the cloud, so it cannot reach `127.0.0.1` on this PC. Use a
tunnel such as Cloudflare Tunnel. The npm wrapper works even when `cloudflared`
is not installed globally:

```powershell
npx --yes cloudflared tunnel --url http://127.0.0.1:8787
```

Set the printed `https://...trycloudflare.com` URL as:

```powershell
$env:PUBLIC_BASE_URL="https://your-tunnel-url"
docker compose -f workers/text-to-cad-local/docker-compose.yml up -d
npx supabase secrets set TEXT_TO_CAD_WORKER_URL="https://your-tunnel-url" TEXT_TO_CAD_WORKER_TOKEN="$env:TEXT_TO_CAD_WORKER_TOKEN" --project-ref <your-project-ref>
npx supabase functions deploy cad-chat --use-api --project-ref <your-project-ref>
```

Keep Docker and the tunnel running while using the `STEP` option.
