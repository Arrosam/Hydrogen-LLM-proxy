# Publishing Hydrogen on Rainyun (雨云云应用 / RCA)

Rainyun Cloud Applications deploy a **pre-built public Docker image** (they do not build
from source). Each app becomes a Kubernetes Deployment configured through Rainyun's visual
template builder. Hydrogen fits cleanly: one container, one web port, a `/data` volume, and
secrets it generates itself.

There are three steps: **publish the image → fill in the RCA template → submit for review.**

> **Don't have a Rainyun account yet?** Register with this invitation link:
> <https://www.rainyun.com/MTA1NzAwNA==_>

---

## 1. Publish the image to GHCR

A GitHub Actions workflow is included at `.github/workflows/docker-publish.yml`.

1. Push this repo to GitHub (Actions must be enabled).
2. Every push to `main` (and every `v*` tag) builds and pushes:
   ```
   ghcr.io/<your-github-username>/hydrogen-llm-proxy:latest
   ```
   Tagged releases also publish `:vX.Y.Z`. **Pin a version tag for production**, not `latest`.
3. **Make the package public once** so Rainyun can pull it without credentials:
   GitHub → your profile → **Packages** → `hydrogen-llm-proxy` → **Package settings** →
   **Change visibility** → **Public**.

<details>
<summary>Manual build & push (alternative to CI, or for another registry)</summary>

```bash
# GHCR login (create a PAT with write:packages)
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin

docker buildx build --platform linux/amd64 \
  -t ghcr.io/<your-github-username>/hydrogen-llm-proxy:latest \
  --push .
```
Rainyun's cluster is amd64, so `linux/amd64` is sufficient.
</details>

---

## 2. Create the RCA template

Go to **https://app.rainyun.com/apps/rca/app-template** → create an App template, then add a
**Version**. Fill it in as follows.

### Image & resources
| Field | Value |
|-------|-------|
| 镜像 (Image) | `ghcr.io/<your-github-username>/hydrogen-llm-proxy:latest` (prefer a pinned `:vX.Y.Z`) |
| CPU | 0.5 core min (1 core recommended) |
| 内存 (Memory) | 512 MB min (1 GB recommended) |

### Service (端口 / networking)
One public service:

| Field | Value |
|-------|-------|
| 服务名 (name) | `web` |
| 显示名 | `Console & API` |
| 类型 | **外部访问** (public internet) |
| 内部端口 (container port) | `8080` |
| 外部端口 | `8080` (or platform-assigned) |
| 协议 | `tcp` |

The dashboard **and** the OpenAI/Anthropic API are both served on this one port.

### Environment variables
All of these are optional — Hydrogen auto-generates what's missing — but set them explicitly
for clarity. Expose `ADMIN_USERNAME` / `ADMIN_PASSWORD` as user-editable **Options** if you want
deployers to choose them.

| Name | Value | Notes |
|------|-------|-------|
| `PORT` | `8080` | Must match the service's internal port |
| `DATA_DIR` | `/data` | Must match the volume mount below |
| `NODE_ENV` | `production` | |
| `COOKIE_SECURE` | `auto` | Session cookie is Secure only on HTTPS. Set `true` if Rainyun always fronts the app with HTTPS; `false` for plain HTTP |
| `ADMIN_USERNAME` | `admin` | |
| `ADMIN_PASSWORD` | *(leave empty)* | Empty → first login is `admin` / `password`, and the user is forced to set a new password. Or expose as an Option |
| `PROXY_MASTER_KEY` | *(leave empty)* | Auto-generated and persisted in `/data`. **Do not** use Rainyun's random generator — it won't be a valid 32-byte key |
| `SESSION_SECRET` | *(leave empty)* | Auto-generated and persisted in `/data` |

### Volume mount (persistent data — REQUIRED)
| Field | Value |
|-------|-------|
| 名称 (name) | `data` |
| 容器路径 (mount path) | `/data` |
| 子路径 (sub-path on project disk) | `hydrogen/data` |
| 类型 | 目录 (directory) |

> **Why this is mandatory:** `/data` holds the SQLite database, the auto-generated master key,
> and the session secret. The master key decrypts stored provider API keys. Without a persistent
> volume the key would be regenerated on restart and Hydrogen would **refuse to boot**
> (master-key sentinel mismatch). With the volume, everything stays stable across restarts.

### Command / Args / Scripts
Leave empty — the image already starts with `node server/dist/server.cjs`.

---

## 3. First run & submit

1. Deploy once yourself to test. Open the external service URL. The login page shows the initial
   credentials (`admin` / `password`); sign in and set a new password.
2. Add a provider, a model + mapping, a MUB, and a token; call `/v1/chat/completions` to confirm.
3. In the app-template tab, **submit the template for review** (提交上架审核).
4. Once approved, share your promotion link from
   **https://app.rainyun.com/apps/rca/store** (append `?ref=<your-UID>`, e.g. `?ref=1057004`).
   You can also share the account invitation link above (<https://www.rainyun.com/MTA1NzAwNA==_>)
   to earn referral credit when new users sign up.

---

## Notes & troubleshooting

- **Login fails / keeps returning to sign-in:** the session cookie is being marked `Secure` on a
  plain-HTTP page. Set `COOKIE_SECURE=false` (or ensure HTTPS + `COOKIE_SECURE=auto`).
- **"PROXY_MASTER_KEY does not match…" on boot:** the `/data` volume was lost or changed. Restore
  the original volume, or wipe `/data` to start fresh (you'll re-enter provider keys).
- **Slow image pull:** pin a specific tag and consider mirroring the image to a China-based
  registry (Aliyun ACR / Tencent TCR) if GHCR pulls are slow from Rainyun's network.
