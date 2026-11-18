# pi-agy-link

Google Antigravity (`agy` CLI) provider & multi-account pool extension for [Pi Coding Agent](https://pi.dev) and [PiCrust](https://github.com/charlescroft/picrust).

Adapted from [`amlyczz/dsh-agy-link`](https://github.com/amlyczz/dsh-agy-link) for the standard Pi extension runtime (`ExtensionAPI`), driving the official unmodified `agy` CLI with full CLI/TUI parity and optional native GPUI desktop UI integration.

## Features

- **Official `agy` CLI Bridge**: Streams responses, thinking blocks, and token usage via `agy -p --output-format stream-json` without reverse-engineering private endpoints.
- **Multi-Account Pool & Smart Rotation**:
  - Sequential drain on 429 / quota exhaustion.
  - Quota-expiry-first scheduling across linked Google accounts.
  - Per-account isolated HOME sandboxes and optional per-account HTTP/SOCKS proxy.
  - Jitter-safe authentication error classification.
- **Zero-Paste Loopback OAuth**: `/agy add` and `/agy primary` open Google sign-in in your browser and capture the callback automatically.
- **Full CLI/TUI Parity**: Every UI datum (pool status, 5H/7D/Argon quotas, reset countdowns, proxy, and per-model sub-quotas) is queryable via `/agy` commands.
- **`agy_ask` Tool**: One-shot delegation tool allowing any model to consult an Antigravity model.
- **PiCrust Desktop Integration**: Automatically emits `agy-link` status and `agy-link-state` structured widgets in RPC mode for PiCrust's native GPUI pool & quota modal.

## Requirements

- [Antigravity CLI (`agy`)](https://antigravity.google/docs/cli/install) installed and available in `PATH`
- Node.js `>= 22.0.0`
- Pi Coding Agent (`@earendil-works/pi-coding-agent`)

## Installation

### From GitHub

```bash
pi install git:github.com/charlescroft/pi-agy-link
```

### From Local Clone

```bash
git clone https://github.com/charlescroft/pi-agy-link.git
cd pi-agy-link
npm install
node scripts/build-pi.mjs
pi install .
```

Restart Pi (or run `/reload`) after installation.

## Usage

### Select a Model

```text
/model agy-link/gemini-3.8-flash
```

Or run non-interactively:

```bash
pi -p --model agy-link/gemini-3.8-flash "Hello"
```

### Commands

| Command | Description |
| --- | --- |
| `/agy` | Open interactive action menu in TUI, or print pool status |
| `/agy status` | List all accounts, tier, 5H/7D/Argon quotas, reset countdowns, proxy, and cooldown/reauth flags |
| `/agy details [id\|email\|index]` | Show Tier, Priority, Proxy, and full `Official Sub-models & Quotas` breakdown |
| `/agy models [id\|email\|index]` | Alias for `/agy details` |
| `/agy add` | Add a new Google account via loopback browser OAuth |
| `/agy auth-url` | Print the Google OAuth URL for adding an account in any browser |
| `/agy primary` | Sign in the primary system account via loopback browser OAuth |
| `/agy primary-url` | Print the primary account OAuth URL for manual browser sign-in |
| `/agy reauth <id\|email\|index>` | Re-authenticate an existing account via loopback browser OAuth |
| `/agy reauth-url <id\|email\|index>` | Print the re-authentication OAuth URL for manual browser sign-in |
| `/agy switch <id\|email\|index>` | Switch the active Antigravity account |
| `/agy remove <id\|email\|index>` | Remove an account from the pool |
| `/agy proxy <id\|email\|index> <url\|clear>` | Set or clear a per-account proxy URL |
| `/agy hidden-models <ids\|clear>` | Hide or restore model IDs in the chat model selector |
| `/agy pool-wide <on\|off>` | Toggle automatic multi-account rotation/failover across the pool |
| `/agy effort <level>` | Set default thinking effort (`minimal`, `low`, `medium`, `high`, `xhigh`) |
| `/agy compact-limit [<tokens\|256k\|512k\|900k\|default>]` | Inspect or override `agy` auto-compact threshold (`AGY_CLI_AUTO_COMPACT_OVERRIDE`) |
| `/agy net [retries <0-10>\|proxy <url\|clear>]` | Configure model API max retries (`AGY_CLI_MODEL_API_MAX_RETRIES`) or global proxy |
| `/agy slim [on\|off]` | Toggle `--disable-slash-commands` in print mode and concise execution guardrails |
| `/agy plugin <enable\|disable> <name>` | Enable or disable `agy` CLI plugins (e.g. `agy-codemode`, `agy-output-guard`, `agy-rehydrate`) |
| `/agy refresh` / `/agy quota` | Force refresh all account quotas and model catalog |

### Configuration & Storage Paths

All configuration and account-pool state is stored under Pi's agent directory (`$PI_CODING_AGENT_DIR`, `$PI_AGENT_DIR`, or `~/.pi/agent` by default):

- `~/.pi/agent/agy-accounts/pool.json` — Account pool index and active account metadata
- `~/.pi/agent/agy-accounts/<accountId>/` — Isolated per-account auth & Antigravity state
- `~/.pi/agent/agy-link/runtime-overrides.json` — Runtime overrides (hidden models, effort, pool-wide toggle, etc.)

## License

[MIT](LICENSE) — adapted from [`amlyczz/dsh-agy-link`](https://github.com/amlyczz/dsh-agy-link).
