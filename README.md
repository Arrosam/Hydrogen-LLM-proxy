# Hydrogen — Lightweight Personal LLM Proxy

A small, self-hosted proxy that manages your LLM API keys and lets you switch upstream models
without touching client code. It speaks both the **OpenAI** and **Anthropic** wire formats,
translates between them, and routes every request through a user-defined **Model Use Behavior
(Model Service)** — a retry/fallback workflow you build in a visual editor.

Everything runs in a single Docker container backed by SQLite. Provider keys are encrypted at
rest; client tokens are hashed.

---

## Core idea: clients only ever see a Model Service

Clients never request a raw model. They set `model` to a **Model Service name**, and Hydrogen runs that
Model Service's ordered steps over your internal catalog:

```
Client request (model = "sonnet-any")     ← only Model Services are exposed to clients
        │
   Model Use Behavior   (ordered steps: retry → provider-fallback → model-fallback)
        │
   Model  (internal catalog)  ──provided by──▶  Provider(s)   (base URL + encrypted key)
```

Each Model Service step pins an explicit **(model, provider)** pair. Provider-fallback and model-fallback
are simply "add another step". If every step is exhausted and still failing, the final upstream
error is returned to the client (translated into the client's wire format).

Examples:

| Model Service | Behavior |
|-----|----------|
| `sonnet-any` | try `sonnet4.6 @ anthropic` → on failure fall back to `gpt5.4 @ openai` |
| `sonnet-persist` | try `sonnet4.6 @ anthropic`, retry 5× at 1s intervals |

---

## Quick start (Docker)

1. **Create `.env`:**

   ```bash
   cp .env.example .env
   # set ADMIN_USERNAME / ADMIN_PASSWORD
   ```
   Leave `PROXY_MASTER_KEY` and `SESSION_SECRET` **blank** to have Hydrogen generate strong
   random values on first boot and persist them in `DATA_DIR/hydrogen-secrets.json` (kept in the
   `/data` volume, so they stay stable across restarts). To manage them yourself instead:

   ```bash
   node -e "console.log('PROXY_MASTER_KEY='+require('crypto').randomBytes(32).toString('base64'))"
   node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(48).toString('base64'))"
   ```

2. **Start it:**

   ```bash
   docker compose up -d --build
   ```

3. **Get the initial login.** If you left `ADMIN_PASSWORD` blank, Hydrogen prints a one-time
   temporary password in the startup logs:

   ```bash
   docker compose logs hydrogen | grep -A5 "initial admin account"
   ```

   Open **http://localhost:8080**, sign in as `admin` with that password, and you'll be prompted to
   **create your own password** before continuing. Then:
   - add a **Provider** (e.g. OpenAI or Anthropic) — the API key is encrypted immediately;
   - add a **Model** and map it to that provider (with the upstream model id);
   - build a **Model Service** in the workflow editor;
   - issue a **Token** scoped to that Model Service.

4. **Call it** like any OpenAI/Anthropic endpoint, using your Hydrogen token and the Model Service name:

   ```bash
   curl http://localhost:8080/v1/chat/completions \
     -H "Authorization: Bearer sk-hproxy-..." \
     -H "content-type: application/json" \
     -d '{"model":"sonnet-any","messages":[{"role":"user","content":"hello"}]}'

   curl http://localhost:8080/v1/messages \
     -H "x-api-key: sk-hproxy-..." \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{"model":"sonnet-any","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'
   ```

Point any OpenAI SDK at `http://localhost:8080/v1` or any Anthropic SDK at `http://localhost:8080`.

---

## Endpoints

**Client-facing** (authenticate with `Authorization: Bearer` or `x-api-key`; `model` = a Model Service name):

| Method | Path | Notes |
|--------|------|-------|
| POST | `/v1/chat/completions` | OpenAI Chat Completions (streaming + non-streaming) |
| POST | `/v1/responses` | OpenAI Responses API (streaming + non-streaming) |
| POST | `/v1/messages` | Anthropic Messages (streaming + non-streaming) |
| POST | `/v1/embeddings` | Passthrough to the first step's OpenAI-compatible provider |
| GET  | `/v1/models` | Lists your Model Services (Anthropic shape if `anthropic-version` header is sent) |

**Admin/console:** `POST /admin/api/login`, then session-cookie-protected CRUD under
`/admin/api/*` (providers, models, mappings, services, tokens, users, logs, stats). Served together
with the dashboard SPA.

**Health:** `GET /healthz`.

---

## Roles

- **admin** — everything, including issuing tokens, and the only role with access to **Settings**
  (language, log retention, trusted upstreams, runtime env, backup & restore).
- **manager** — everything **except** issuing tokens and Settings; also cannot create or modify
  admin accounts (to prevent privilege escalation).

The first admin is created on first boot. If `ADMIN_PASSWORD` is blank, a temporary password is
generated and printed to the logs, and the admin must set a new password at first login.

---

## Backup & restore

**Settings → Backup & restore** (admin only) exports the whole instance — providers, models,
mappings, Model Services, tokens, users, settings, and optionally the request logs — as a single
JSON file, and restores it later to an instance that is identical to the one you backed up.
Client tokens and dashboard passwords keep working, because their hashes travel with the package.

Provider API keys need care, because they are encrypted with `PROXY_MASTER_KEY`, which lives in
`hydrogen-secrets.json` rather than in the database. Copying the ciphertext would produce a backup
that only restores onto the machine that wrote it — the one you no longer have. So on export the
keys are decrypted and re-sealed under a **passphrase you choose** (scrypt + AES-256-GCM), and on
restore they are decrypted with that passphrase and re-encrypted under the *target* instance's
master key.

Two consequences worth knowing before you rely on it:

- **The passphrase is not recoverable.** It is never sent to or stored on the server. Lose it and
  the package cannot be restored — keep it wherever you keep your other credentials.
- **Restore replaces everything**, in one transaction: it either fully succeeds or changes nothing
  (a wrong passphrase or a damaged file is rejected before any data is touched). Afterwards you are
  signed out, since the user accounts you authenticated against have themselves been replaced.

The downloaded file contains no usable secret without the passphrase, but it does contain your full
configuration and request history — treat it as sensitive.

---

## Security notes

- **Provider API keys** are encrypted with AES-256-GCM using `PROXY_MASTER_KEY` and never leave the
  server in plaintext. A verification sentinel is stored on first boot; if you start with a
  different `PROXY_MASTER_KEY`, Hydrogen **refuses to boot** rather than corrupt behavior.
- **Client tokens** are shown exactly once at creation and stored only as a SHA-256 hash + prefix.
- **Passwords** are hashed with argon2id. Sessions are signed, httpOnly, `SameSite=Lax` cookies
  (marked `Secure` in production — serve behind HTTPS).
- **Rotating the master key:** decrypt-and-re-encrypt is not automated in v1. To change it, either
  start fresh (wipe the `/data` volume) or re-enter each provider's API key after updating the key.

---

## Development

Requires Node 20+.

```bash
npm install
npm run db:generate           # regenerate SQL migrations after schema changes
npm run dev                   # server (tsx watch) + web (vite) together
npm run test                  # server unit tests (translation, Model Service engine, streaming)
npm run typecheck             # server typecheck
```

The Vite dev server proxies `/admin/api`, `/v1`, and `/healthz` to the running server (default
`http://127.0.0.1:8080`, override with `HYDROGEN_API`). A throwaway single-process preview of the
production bundle is available via `node preview-server.cjs` (dev secrets only).

### Layout

```
server/   Fastify + Drizzle (SQLite) backend
  src/core/formats/   OpenAI/Anthropic ⇄ canonical IR translation (+ SSE streaming)
  src/core/service/       Model Service step schema + retry/fallback engine
  src/core/proxy/     request orchestration
  src/services/       providers, models, catalog, services, tokens, users, logs, stats
  src/routes/         proxy endpoints + admin API
web/      React + Vite + Tailwind dashboard (Bootstrap Icons)
```

---

## Deploying to Rainyun (雨云云应用)

Hydrogen can be published as a one-click Rainyun Cloud Application. A GitHub Actions workflow
(`.github/workflows/docker-publish.yml`) builds and pushes the image to GHCR, and
[docs/rainyun.md](docs/rainyun.md) has the exact RCA template values (image URL, port `8080`,
the persistent `/data` volume, and env vars). The `/data` volume is required so the
auto-generated master key stays stable across restarts.

New to Rainyun? Register with this invitation link:
[https://www.rainyun.com/MTA1NzAwNA==_](https://www.rainyun.com/MTA1NzAwNA==_)

## Roadmap

- **Virtual Providers** — a future Model Service step type (`type: "workflow"`) that packages a multi-call
  pipeline (worker → evaluator → loop-until-done) behind a single Model Service endpoint, reusing the same
  translation and resilience layers.

## License

MIT
