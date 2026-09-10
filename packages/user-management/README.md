# @areelai/user-management

Dashboard users with argon2id passwords, signed-JWT sessions that work as a cookie or an `Authorization: Bearer` header, and scoped client API keys with request and token quotas, usage metering and a public key-status check, all in this package's own SQLite tables. It deliberately has no HTTP layer: it reads a headers object and returns a verdict, and the caller renders the failure in whatever wire format its client speaks. It knows nothing about services beyond the plain service ids a key's scope lists, and it never generates or stores the master key that encrypts issued keys.

## Install

```
npm install @areelai/user-management
```

Runtime dependencies: `@areelai/common`, `argon2`, `jsonwebtoken`, `drizzle-orm`, `better-sqlite3`. Node 20 or newer, ESM only.

## Ten-line adoption example

```ts
import crypto from "node:crypto";
import { checkClientKey, extractPresentedToken, keyStatus, openUserStores, Sessions } from "@areelai/user-management";

const stores = openUserStores({ file: "./data/hydro.db", masterKey: crypto.randomBytes(32) });
const admin = await stores.users.create({ username: "admin", password: "change-me-now", role: "admin" });

const sessions = new Sessions({ secret: "a-long-random-session-secret", ttlMs: 8 * 3_600_000 });
const jwt = sessions.sign({ uid: admin.id, username: admin.username, role: admin.role });
console.log(sessions.verify(jwt)?.username); // "admin"; null when expired, forged or signed with another secret

const { token, secret } = stores.tokens.create({ name: "ci-bot", ownerUserId: admin.id, maxRequests: 1000 });
const presented = extractPresentedToken({ authorization: `Bearer ${secret}` }); // or an x-api-key header
const check = checkClientKey(stores.tokens, presented); // { ok: true, token } | { ok: false, status: 401 | 429, message }
if (check.ok) console.log(token.keyPrefix, keyStatus(check.token).valid); // "sk-xxxxxx" true
stores.close();
```

## Users and sessions

- `UserRepo.create({ username, password, role, enabled?, mustChangePassword? })` hashes with argon2id (`hashPassword` / `verifyPassword`). `verifyLogin(username, password)` returns the user or `null` and spends the same argon2 work on an unknown username as on a wrong password, so timing does not reveal which accounts exist. `changeOwnPassword`, `update`, `delete`, `list`, `get`, `getByUsername`, `count`, `initialCredentialHint` and `toPublic` cover the rest. Roles are `"admin" | "manager"`.
- `seedAdminIfEmpty(stores.db, { username, password })` creates the first admin when the table is empty; an empty password means the default `DEFAULT_ADMIN_PASSWORD` with `mustChangePassword` set.
- `new Sessions({ secret, ttlMs, cookieSecure? })` signs and verifies a `SessionPayload` (`uid`, `username`, `role`, `iat`). The secret must be at least 16 characters. `extractSessionToken(headers, cookies)` reads the bearer header first, then the `SESSION_COOKIE` (`hydrogen_session`); `cookieOptions(secure)` and `resolveCookieSecure(isHttps)` build the cookie for a login route.

## Client keys

- `TokenRepo.create(input)` returns `{ token, secret }`. The secret (`sk-` plus 32 random bytes, `generateToken`) is shown once; the row stores its SHA-256 (`hashToken`) for lookup and the secret itself as AES-256-GCM ciphertext under the master key so an admin can copy it again with `revealSecret(id)`. `TokenInput` carries `ownerUserId`, `scopeServices` (service ids; empty means all), `maxRequests`, `maxTokens`, `expiresAt` (epoch ms) and `enabled`.
- `checkClientKey(tokens, presented, enforceQuota = true)` authenticates by hash and enforces enabled, expiry and both quotas; `tokenAllowsService(token, serviceId)` checks the scope. `keyStatus(token)` is the public Key Check view: `{ valid, expired, requestsExceeded, tokensExceeded, checkedAt }`.
- `UsageMeter.record(tokenId, tokensUsed)` (`stores.usage`) counts one request and its tokens atomically through `TokenRepo.incrementUsage`.

## Sharing a connection

`openUserStores({ file, masterKey })` opens its own file and applies the migrations. To share one already-open, already-migrated connection with other packages, run `applyMigrations(sqlite, userMigrations)` from `@areelai/common` and call `createUserStores(sqlite, masterKey)`; it returns the same `UserStores` (`db`, `users`, `tokens`, `usage`) without `sqlite` or `close`.

## What it stores

Tables: `users` and `tokens` (`USER_TABLES`). The migrations are embedded in `userMigrations` and recorded in this package's own bookkeeping table `__migrations_user_management`, so the tables can share one SQLite file with `@areelai/supplier-management`, `@areelai/model-services` and `@areelai/micro-agent`. `tokens.owner_user_id` is a foreign key inside the package (set to null when the user is deleted); `tokens.scope_services_json` holds plain service ids with no foreign key, because those rows belong to another package.

## Swapping the store

`PublicApi<T>` is the public surface of a repository class. `UserStore` is `PublicApi<UserRepo>` and `TokenStore` is `PublicApi<TokenRepo>`: what a custom implementation must provide. `checkClientKey` only needs `Pick<TokenRepo, "authenticate">`, and `UsageMeter` only calls `incrementUsage`, so a partial backend can start with those.

## License

MIT
