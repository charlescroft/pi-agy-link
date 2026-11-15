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
| `/agy primary` | Sign in the primary system account via loopback browser OAuth |
| `/agy switch <id\|email\|index>` | Switch the active Antigravity account |
| `/agy remove <id\|email\|index>` | Remove an account from the pool |
| `/agy proxy <id\|email\|index> <url\|clear>` | Set or clear a per-account proxy URL |
| `/agy refresh` / `/agy quota` | Force refresh all account quotas and model catalog |

## License

[MIT](LICENSE) — adapted from [`amlyczz/dsh-agy-link`](https://github.com/amlyczz/dsh-agy-link).
