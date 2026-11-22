# Security notes

Threat model and boundaries for dsh-agy-link.

## What the plugin executes

- Only the agy binary resolved from config (`agyBin`) or `PATH` /
  `~/.local/bin`. No shell interpolation: argv is passed as an array.
- Prompt text is passed as a single `-p` argument, never through a shell.
- Every spawn is its own detached process group; watchdog + abort signal
  kill the whole tree (no orphaned agy processes).

## What it can do to your machine

- Per-account OAuth token files and `.bak` backups are written atomically with `0600` permissions; Windows Credential Manager handoffs verify refresh-token fingerprints (`sameCredentialGrant`) so foreign tokens can never overwrite an account file.
- `EcosystemService` mirrors only an explicit allowlist of primary customizations (`plugins`, `skills`, `rules`, `agents`, and MCP config) into isolated pool account HOMEs while explicitly excluding `.env`, OAuth tokens (`.bak`, `.primary-credential.json`), private keys (`.pem`/`.key`), logs, conversations, and keychains.
- DSH-side API keys and other providers' credentials are never read or modified.
- `/agy doctor` strips Google auth URLs, `4/...` codes, `ya29.*` access tokens, `1//...` refresh tokens, JWTs, API keys, and proxy credentials before writing diagnostics.

## Headless permission behavior

- Loopback Origin enforcement: browser requests carrying a non-loopback `Origin` header are rejected (`403`), and no wildcard `Access-Control-Allow-Origin: *` header is emitted on `/media`, `/open`, or `/assets`.
- `/plugins/agy-link/open` is strictly `POST`-only (`405` on `GET`, preventing auto-trigger via markdown image tags), confined via `realpathSync` to active workspace/media/brain directories, blocks sensitive credential paths (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.dsh`, `.gemini/antigravity-cli`, `.env`, private keys), refuses executable extensions, and passes Windows targets via environment variable (`-LiteralPath`) without PowerShell string interpolation.
- `/plugins/agy-link/embed` (Generative UI `<agent-embed>`) serves only confined local `.html` artifacts up to 2 MiB with strict CSP (`default-src 'none'`, `connect-src 'none'`, allowlisted Tailwind CDN script only) inside a sandboxed `<iframe sandbox="allow-scripts">` (no `allow-same-origin`).
- Request bodies are capped (`1 MiB` for plugin routes, `8 MiB` for loopback MCP `/call`), and the loopback MCP bridge requires a constant-time random bearer token plus `mcpToolAllowlist` enforcement while excluding internal tools (`run_code`, `agy_ask`, `agy_tool`).
