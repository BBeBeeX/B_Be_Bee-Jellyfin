# AGENTS.md — working on B_Be_Bee-Jellyfin

A distilled guide for AI programming assistants and contributors working on `B_Be_Bee-Jellyfin`.

---

## 1. What this repository is

`B_Be_Bee-Jellyfin` is the standalone Jellyfin media server music source for BBeBee.
It is an independent source repository following the BBeBee v3 source artifact contract:
- `src/source.json`: Raw rule document definition.
- `src/source.js`: Companion QuickJS runtime helper library (auth, data normalization, lyrics parsing).
- `index.json`: Compiled single-file distribution artifact in the repository root (committed into git).
- No obfuscated code allowed; strictly clean JSON rules and documented readable JavaScript.

---

## 2. Parameter Conventions

- **Server host (`sourceUrl` / `host`)**: Declared in `params: ["sourceurl", "user", "password"]`.
  - The URL can be entered by users as `http://192.168.1.100:8096/web/#/home.html` or `http://127.0.0.1:8096/web`.
  - `getBaseUrl()` in `src/source.js` cleans `#.*`, `\?.*`, `/web(?:\/index\.html)?\/?`, and trailing slashes.
  - All endpoint templates in `src/source.json` must use `{{@js:getBaseUrl()}}` to prevent 404s from fragment truncation.
- **Credentials (`user` and `password`)**: Declared via `loginUi`:
  ```json
  "loginUi": [
    { "id": "user", "label": "Username", "type": "text" },
    { "id": "password", "label": "Password", "type": "password" }
  ]
  ```
  `params` only lists `["sourceurl", "user", "password"]`. Do NOT add `username` or `token` to `params`, which would cause duplicated input fields in the BBeBee configuration modal.
- **Session & Auth validation (`loginCheckJs`)**:
  - `loginCheckJs` is evaluated on **both** the `/Users/AuthenticateByName` login response and **every** regular API fetch via `fetchChecked`.
  - It must store `token`, `userId`, `serverId` on login responses, but safely return `true` for standard data payloads (e.g. `{ Items: [...] }`) to avoid false session invalidation (`the session for ... is no longer valid`).

---

## 3. Commands

```bash
# Compile src/source.json and src/source.js to root index.json
npm run compile
# or: node scripts/compile.mjs

# Validate readability, byte-for-byte reproducibility, and schema
npm run validate
# or: node scripts/validate.mjs

# Run 15-case negative & functional test suite
npm test
# or: node scripts/validate.mjs --test

# Run live server e2e integration test against a real Jellyfin instance
npm run test:live -- "http://192.168.1.100:8096/web/#/home.html" "username" "password"
```

---

## 4. Acceptance Gate

Before finishing any change:
- `npm run compile` must produce a reproducible `index.json`.
- `npm run validate` must output **0 errors**.
- `npm test` must pass (15/15 unit tests).
- Recompiling must be byte-for-byte identical to committed `index.json`.
- If a live Jellyfin server is accessible, `npm run test:live` must pass all 9 stages.
