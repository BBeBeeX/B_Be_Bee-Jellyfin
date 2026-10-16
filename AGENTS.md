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

- **Server host (`host`)**: Configured via `sourceUrl` (e.g. `https://jellyfin.example.org`). The app uses this to recalculate outbound network allowed hosts (`allowedHostsFor`).
- **Credentials (`user` and `password`)**: Declared via `loginUi`:
  ```json
  "loginUi": [
    { "id": "user", "label": "Username", "type": "text" },
    { "id": "password", "label": "Password", "type": "password" }
  ]
  ```
  In BBeBee, these are routed into `ctx.secrets` (hardware OS Keychain / encrypted storage) and never stored in plain SQLite tables.
- **Token / API Key (`token`)**: Supports direct Jellyfin API keys or tokens via `token` / `api_key` in variables or form login.

---

## 3. Commands

```bash
# Compile src/source.json and src/source.js to root index.json
node scripts/compile.mjs

# Validate readability, byte-for-byte reproducibility, and schema
node scripts/validate.mjs

# Run negative test suite
node scripts/validate.mjs --test
```

---

## 4. Acceptance Gate

Before finishing any change:
- `node scripts/validate.mjs` must output **0 errors**.
- Recompiling must be byte-for-byte identical to committed `index.json`.
- `node scripts/validate.mjs --test` must pass (all negative test cases).
