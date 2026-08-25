# @veniceai/mcp-server

> Model Context Protocol server for the **Venice API** - uncensored, private AI for any MCP host (Claude Desktop, Cursor, ChatGPT, LM Studio, Continue, LibreChat, Open WebUI, AnythingLLM, Jan, Le Chat).

[![npm](https://img.shields.io/npm/v/@veniceai/mcp-server.svg)](https://www.npmjs.com/package/@veniceai/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Plug Venice's chat, image, video, audio, music, billing, and operator APIs into any agent in 30 seconds. **40 tools, one config block.**

## Quick start

### 1. Get a key from [venice.ai](https://venice.ai)

See the [API key guide](https://docs.venice.ai/guides/getting-started/generating-api-key) for step-by-step instructions.

### 2. Add this to your MCP host config

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows), **Cursor** (`~/.cursor/mcp.json`), **LM Studio**, etc:

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server@0.2.0"],
      "env": { "VENICE_API_KEY": "<your-venice-api-key>" }
    }
  }
}
```

### 3. Restart your MCP host

That's it. Type a prompt — your agent now has chat, image, video, music, TTS, ASR, and 25 more Venice tools.


## What you get

**40 tools** spanning every Venice modality plus billing and API-key operations, **3 resources** (`venice://models`, `venice://styles`, `venice://voices`) and **3 prompt templates** (uncensored research, NSFW creative writing, image style explorer).

### 💬 Chat & embeddings

| Tool | Description |
|---|---|
| `venice_chat` | OpenAI-compatible chat completion against Venice's uncensored LLM catalog (Claude, GPT-5, Llama, DeepSeek, Qwen, GLM, Kimi, Venice Uncensored, etc.). Supports `venice_parameters` for web search, citations, characters, and system prompt or reasoning control. |
| `venice_responses` | OpenAI-compatible Responses API. Single-turn or multi-turn with tool support. Supports `venice_parameters`. |
| `venice_embeddings` | Compute embeddings for text input (OpenAI-compatible). |
| `venice_chat_with_character` | Chat with a Venice character by slug. |

### 🎨 Image

| Tool | Description |
|---|---|
| `venice_image_generate` | Generate an image. Supports Flux 2 Pro/Max, Lustify SDXL, Anime (WAI), Qwen Image, GPT Image, Nano Banana Pro and others. |
| `venice_image_edit` | Edit an image with a prompt. Returns base64 PNG. |
| `venice_image_multi_edit` | Edit multiple images together with a single prompt (multi-image composition / outpainting). |
| `venice_image_upscale` | Upscale an image (2–4× scale, with a `creativity` control). Returns base64 PNG. |
| `venice_image_remove_bg` | Remove image background; returns a transparent PNG. |
| `venice_image_styles` | List image style presets available for `venice_image_generate`. |

### 🎬 Video

| Tool | Description |
|---|---|
| `venice_video_generate` | Queue a video generation. Supports Sora 2, Veo 3.1, Kling, Wan, LTX 2, Seedance (incl. r2v video-to-video), Runway Gen-4, and others. Accepts image, video, audio, and reference image inputs depending on model. |
| `venice_video_status` | Check status of a queued video job. Returns `PROCESSING` or `COMPLETED`. |
| `venice_video_complete` | Mark a completed video as downloaded; deletes server-side media. |
| `venice_video_transcriptions` | Transcribe a YouTube video URL. |
| `venice_video_quote` | Get a price quote for a video generation BEFORE queuing. |

### 🔊 Audio (TTS / ASR)

| Tool | Description |
|---|---|
| `venice_tts` | Convert text to speech. Supports cloned voices + emotion tags (`[whispers]`, `[sarcastically]`, etc.). |
| `venice_asr` | Transcribe audio from a URL. |
| `venice_voice_clone` | List built-in voices or clone a new voice from a sample audio URL. |
| `venice_audio_quote` | Get a price quote for music generation BEFORE queuing. |

### 🎵 Music

| Tool | Description |
|---|---|
| `venice_music_generate` | Queue music generation. Models: ace-step-15, elevenlabs-music, minimax-music-v2/v25/v26, stable-audio-25, mmaudio-v2, elevenlabs-sound-effects-v2. |
| `venice_music_status` | Check status of a queued music job. |
| `venice_music_complete` | Mark a completed music job as downloaded. |

### 🌐 Web augment

| Tool | Description |
|---|---|
| `venice_web_search` | Search the web (Firecrawl-backed). Returns ranked results with snippets. |
| `venice_web_scrape` | Scrape one URL into markdown text. |
| `venice_text_parser` | Extract text from a document URL (PDF, DOCX, EPUB, PPTX, XLSX, …). |

### 📚 Catalog

| Tool | Description |
|---|---|
| `venice_list_models` | List the live model catalog with capabilities and prices. |
| `venice_list_characters` | List public Venice characters. |

### ⛓️ Crypto

| Tool | Description |
|---|---|
| `venice_crypto_rpc` | Proxy a JSON-RPC call to a supported blockchain network (`eth_call`, `eth_blockNumber`, …). Supports Base, Ethereum, Polygon, Arbitrum, Optimism. |

### 💰 Billing (ADMIN API key only)

| Tool | Description |
|---|---|
| `venice_billing_balance` | Get current USD, DIEM, and bundled-credit availability. |
| `venice_billing_usage_analytics` | Get beta aggregate usage by date, model, and API key using a lookback or custom date range. |
| `venice_billing_usage_history` | Walk detailed usage with cursor pagination, first-page filters, and JSON or CSV output. |

Usage-history continuation calls must send `cursor` without the original filters. CSV pages return a `csv:`-prefixed `nextCursor` so a cursor-only follow-up stays on `text/csv`. The deprecated `/billing/usage` route is not wrapped. Billing tools require an ADMIN `VENICE_API_KEY` and fail locally instead of falling back to SIWX. Inference keys, including keys minted through MCP, cannot call these endpoints.

### 🔑 API keys

| Tool | Description |
|---|---|
| `venice_list_api_keys` | List active key metadata without full key secrets. ADMIN API key only. |
| `venice_get_api_key` | Get one key's metadata, usage, balances, and rate limits. ADMIN API key only. |
| `venice_api_key_rate_limits` | Get current balances, access status, tier, and model limits. API key only. |
| `venice_api_key_rate_limit_logs` | Get the last 50 exceeded rate-limit events. API key only; experimental upstream. |
| `venice_web3_key_challenge` | Get the unauthenticated 15-minute Web3 mint challenge. |
| `venice_web3_key_mint` | Submit a caller-signed EVM challenge and receive a one-time INFERENCE API-key secret. ADMIN minting is rejected; a positive consumption limit is required; omitted `limit_period` defaults to `LIFETIME`. |

Web3 minting currently requires an EVM wallet with staked VVV on Base. Signing stays in the caller's wallet: this server accepts an address, signature, and challenge token, but never a private key. MCP minting is limited to `INFERENCE` keys with a required positive `consumption_limit`, because the wallet signature covers only the challenge token. Omitted `limit_period` is sent as `LIFETIME` so a dollar cap is a permanent cap rather than the upstream daily `EPOCH` default. The secret is shown once. If the mint times out or the response is lost, do not retry — use an ADMIN key to list and revoke any unexpected key, then start a new challenge. Minted secrets are returned only to the MCP caller and are not written to server logs. Create/update/delete key mutations are intentionally not exposed.

List and get require an ADMIN `VENICE_API_KEY`. Rate-limit reads accept an INFERENCE or ADMIN key. These tools never forward `SIGN-IN-WITH-X`.

### 💳 x402 wallet helpers

> Optional — only needed if you authenticate with a wallet via **x402** instead of an API key. See [**x402** — pay with a wallet](#x402--pay-with-a-wallet-no-account-required).

| Tool | Description |
|---|---|
| `venice_x402_balance` | Check the prepaid x402 credit balance for a wallet address. |
| `venice_x402_top_up_info` | Fetch top-up requirements (network, USDC token address, receiver wallet, minimum amount). |
| `venice_x402_transactions` | List recent x402 top-up + debit transactions for a wallet. |

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `VENICE_API_KEY` | _(none)_ | Your Venice API key. The simplest setup. |
| `VENICE_DEFAULT_CHAT_MODEL` | `deepseek-v4-flash-0731` | |
| `VENICE_DEFAULT_IMAGE_MODEL` | `flux-2-pro` | |
| `VENICE_DEFAULT_TTS_MODEL` | `tts-kokoro` | |
| `VENICE_DEFAULT_ASR_MODEL` | `openai/whisper-large-v3` | |
| `VENICE_DISABLE_NSFW` | `0` | Set to `1` to remove NSFW capability notes from tool descriptions. |
| `VENICE_HTTP_TIMEOUT_MS` | `60000` | |
| `VENICE_SIWX_TOKEN` | _(none)_ | **x402** wallet-mode auth token — see [**x402** — pay with a wallet](#x402--pay-with-a-wallet-no-account-required). |
| `PORT` | `3333` | HTTP-mode listener. |
| `VENICE_MCP_HOST` | `127.0.0.1` | HTTP-mode bind address. Set to `0.0.0.0` for LAN/container exposure. |
| `VENICE_MCP_AUTH_TOKEN` | _(none)_ | Bearer token required by `/mcp` whenever HTTP mode binds outside loopback. Use a long random value. |
| `VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP` | `0` | Emergency escape hatch for unauthenticated exposed HTTP mode. Use only behind a trusted authenticated proxy. |
| `VENICE_MCP_MAX_SESSIONS` | `100` | Maximum active Streamable HTTP sessions. |
| `VENICE_MCP_SESSION_TTL_MS` | `1800000` | Idle Streamable HTTP session lifetime before cleanup. |

## Self-hosting (Streamable HTTP)

`/mcp` is a credential-backed tool execution endpoint: callers can spend the configured Venice API key or x402 balance. When HTTP mode binds outside loopback, startup fails unless `VENICE_MCP_AUTH_TOKEN` is set, or `VENICE_MCP_ALLOW_UNAUTHENTICATED_HTTP=1` is explicitly set behind a trusted authenticated proxy.

```bash
docker run -p 3333:3333 \
  -e VENICE_API_KEY=<your-venice-api-key> \
  -e VENICE_MCP_AUTH_TOKEN=<choose-a-long-random-token> \
  ghcr.io/veniceai/venice-mcp-server:latest
# server at http://localhost:3333/mcp
```

Clients should send `Authorization: Bearer <choose-a-long-random-token>` with HTTP MCP requests. HTTP clients should create new sessions without an `mcp-session-id` header and then reuse the server-issued session ID; unknown or malformed caller-provided session IDs are rejected. For reproducible production installs, pin the npm package version as shown in the examples instead of using an unversioned `latest` install path.

Or run from source — see [Development](#development) below.

---

## x402 — pay with a wallet, no account required

> Skip this section if you're using `VENICE_API_KEY`. Everything below is optional and only matters if you specifically want to pay with a crypto wallet instead of a Venice account.

Venice supports **EVM SIWE or Solana SIWX wallet authentication** backed by prepaid USDC credit on **Base or Solana mainnet**, in addition to the normal API key flow. This lets you use Venice with no email, phone, or KYC — your wallet is the only identity.

### Two-line config

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server@0.2.0"],
      "env": { "VENICE_SIWX_TOKEN": "<base64 signed SIWX payload>" }
    }
  }
}
```

The MCP server forwards the existing `VENICE_SIWX_TOKEN` env format using Venice's preferred `SIGN-IN-WITH-X` header.

### How it works

```
ONE-TIME SETUP (per wallet)
  Sign an EVM SIWE or Solana SIWX message → produces a SIWX token (base64 JSON)
  Set VENICE_SIWX_TOKEN in this MCP server's env

TOP UP (when balance is low)
  POST /api/v1/x402/top-up  (no payment header)  →  402 + payment requirements
  Choose a Base or Solana USDC option and sign it in your wallet
  POST /api/v1/x402/top-up with PAYMENT-SIGNATURE: <signed>  →  Venice settles
  the payment and credits your prepaid balance

EVERY INFERENCE CALL
  MCP server sends SIGN-IN-WITH-X: <SIWX token>
  Venice → wallet → credit account → debits and runs inference
```

This MCP server **never sees your private key**. EVM/Solana SIWX signing and USDC payment signing happen in your wallet — the server forwards only the signed SIWX token. The top-up helper discovers requirements but does not accept or submit payment signatures.

The helper tools `venice_x402_balance`, `venice_x402_top_up_info`, and `venice_x402_transactions` make balance + top-up flow inspectable from inside the agent.

### Why prepaid instead of per-call?

- ⚡ **Latency** — once topped up, calls are sub-100ms (no on-chain settlement per call)
- 🧮 **Throughput** — Coinbase CDP facilitator settles top-ups in batches
- 🔒 **Privacy** — wallet ↔ credit account is the only identity link; no email/phone/KYC
- 🪙 **DIEM shortcut** — wallets linked to a Venice user with DIEM staked consume from staking balance, no USDC needed
- 💸 **Min top-up $5** (anti-dust). Minimum balance to inference is $0.10.

### Per-call HTTP 402 — not supported

Venice rejects payment headers on inference routes. The preferred `PAYMENT-SIGNATURE` header is only used when submitting a signed payment to `/api/v1/x402/top-up`; this MCP server does not submit payments. After an external top-up, Venice debits the wallet's off-chain credit account on inference.

### Auth-mode coverage notes

Some Venice endpoints don't accept both auth modes:

| Tool | API key | x402 | Notes |
|---|---|---|---|
| `venice_list_characters` | ✓ | ✗ | Characters endpoint is API-key only |
| `venice_x402_balance` | ✗ | ✓ | Wallet-bound by design |
| `venice_x402_transactions` | ✗ | ✓ | Wallet-bound by design |
| `venice_x402_top_up_info` | ✓ | ✓ | Auth-free; same 402 response in both modes |

### Hybrid

Set both `VENICE_API_KEY` AND `VENICE_SIWX_TOKEN` — API key wins. SIWX is only used when the key is absent.

---

## Architecture

```
┌──────────────────────┐        stdio  OR        ┌────────────────────────┐
│  MCP host            │      Streamable HTTP    │  @veniceai/mcp-server  │
│  (Claude / Cursor /  ├────────────────────────▶│  - 40 tools            │
│   ChatGPT / etc.)    │                         │  - 3 resources         │
└──────────────────────┘                         │  - 3 prompts           │
                                                 │  - header forwarder    │
                                                 └────────────┬───────────┘
                                                              │ HTTPS
                                                              │   Authorization: Bearer ***
                                                              │   OR
                                                              │   SIGN-IN-WITH-X: <SIWX>
                                                              ▼
                                                 ┌────────────────────────┐
                                                 │  Venice API            │
                                                 │  api.venice.ai         │
                                                 └────────────────────────┘
```

## Tool reference (endpoints + auth modes)

<details>
<summary>Click to expand — full mapping of tool → Venice endpoint → auth mode</summary>

### Inference (API key OR x402 wallet)

| Tool | Endpoint |
|---|---|
| `venice_chat` | `POST /v1/chat/completions` |
| `venice_responses` | `POST /v1/responses` |
| `venice_embeddings` | `POST /v1/embeddings` |
| `venice_image_generate` | `POST /v1/image/generate` |
| `venice_image_edit` | `POST /v1/image/edit` |
| `venice_image_multi_edit` | `POST /v1/image/multi-edit` |
| `venice_image_upscale` | `POST /v1/image/upscale` |
| `venice_image_remove_bg` | `POST /v1/image/background-remove` |
| `venice_video_generate` | `POST /v1/video/queue` |
| `venice_video_status` | `POST /v1/video/retrieve` |
| `venice_video_complete` | `POST /v1/video/complete` |
| `venice_video_transcriptions` | `POST /v1/video/transcriptions` |
| `venice_tts` | `POST /v1/audio/speech` |
| `venice_asr` | `POST /v1/audio/transcriptions` |
| `venice_voice_clone` | `POST /v1/audio/voices` |
| `venice_music_generate` | `POST /v1/audio/queue` |
| `venice_music_status` | `POST /v1/audio/retrieve` |
| `venice_music_complete` | `POST /v1/audio/complete` |
| `venice_web_search` | `POST /v1/augment/search` |
| `venice_web_scrape` | `POST /v1/augment/scrape` |
| `venice_text_parser` | `POST /v1/augment/text-parser` |
| `venice_crypto_rpc` | `POST /v1/crypto/rpc/:network` |

### Catalog & quotes (auth-free)

| Tool | Endpoint |
|---|---|
| `venice_list_models` | `GET /v1/models` |
| `venice_image_styles` | `GET /v1/image/styles` |
| `venice_audio_quote` | `POST /v1/audio/quote` |
| `venice_video_quote` | `POST /v1/video/quote` |

### Characters (API key only)

| Tool | Endpoint |
|---|---|
| `venice_list_characters` | `GET /v1/characters` |
| `venice_chat_with_character` | `POST /v1/chat/completions` (with `character_slug`) |

### Billing and API-key reads (ADMIN API key only, except rate-limit tools)

| Tool | Endpoint |
|---|---|
| `venice_billing_balance` | `GET /v1/billing/balance` |
| `venice_billing_usage_analytics` | `GET /v1/billing/usage-analytics` |
| `venice_billing_usage_history` | `GET /v1/billing/usage-history` |
| `venice_list_api_keys` | `GET /v1/api_keys` |
| `venice_get_api_key` | `GET /v1/api_keys/:id` |
| `venice_api_key_rate_limits` | `GET /v1/api_keys/rate_limits` (INFERENCE or ADMIN) |
| `venice_api_key_rate_limit_logs` | `GET /v1/api_keys/rate_limits/log` (INFERENCE or ADMIN) |

### Web3 API-key mint (auth-free)

| Tool | Endpoint |
|---|---|
| `venice_web3_key_challenge` | `GET /v1/api_keys/generate_web3_key` |
| `venice_web3_key_mint` | `POST /v1/api_keys/generate_web3_key` |

### x402 wallet helpers (SIWX reads + auth-free discovery)

| Tool | Endpoint |
|---|---|
| `venice_x402_balance` | `GET /v1/x402/balance/:wallet` |
| `venice_x402_top_up_info` | `POST /v1/x402/top-up` (no payment) |
| `venice_x402_transactions` | `GET /v1/x402/transactions/:wallet` |

</details>

## Development

```bash
npm install
npm run build
npm test                  # full suite (108 tests across 12 suites, ~3s)
npm run test:unit         # unit tests only
npm run test:integration  # spawns dist/cli.js + a mock Venice over real stdio JSON-RPC
npm start                 # stdio mode
npm run start:http        # http mode on :3333
```

### Test layout

```
test/
├── config.test.ts             # env parsing, defaults, header precedence
├── format.test.ts             # 402 formatter cases
├── venice-client.test.ts      # HTTP client + real mock Venice
├── tools.test.ts              # 40-tool registry + endpoint/method/body mappings
├── integration.test.ts        # end-to-end JSON-RPC over stdio against a mock Venice
└── helpers/
    ├── stub-client.ts         # in-process VeniceClient stub
    └── mock-venice-server.ts  # real http.Server fake of Venice for integration tests
```

The integration suite spawns the compiled CLI and speaks JSON-RPC on its stdin/stdout, exercising `initialize` → `tools/list` → `tools/call` → `resources/list` → `resources/read` against a real HTTP mock Venice in three auth scenarios (API key only, SIWX only, no auth).

### End-to-end with live Venice + Base EVM harness

`test/e2e/` currently exercises the EVM rail against the **real** Venice API and **real** Base mainnet—not a mock. Venice and the MCP x402 helpers support both Base and Solana, but this harness generates a throwaway EVM wallet and signs SIWE + EIP-3009 payloads with `viem`. The wallet is persisted at `.e2e-wallet.json` (chmod 600, gitignored—**never commit**).

| Phase | npm script | Cost | What it tests |
|---|---|---|---|
| `create` | `test:e2e:create` | free | Generate / reload wallet, print address + balance |
| `empty` | `test:e2e:empty` | free | SIWX → MCP `venice_chat` → expect 402 with helpful diagnostics |
| `topup` | `test:e2e:topup` | $5 USDC + gas | Sign EIP-3009 → POST `/api/v1/x402/top-up` → settle on-chain via CDP facilitator |
| `funded` | `test:e2e:funded` | ~$0.001 / call | SIWX → MCP `venice_chat` → real LLM completion charged to prepaid balance |
| `balance` | `test:e2e:balance` | free | Read on-chain USDC + Venice prepaid via `venice_x402_balance` tool |
| `safe` | `test:e2e:safe` | free | `create` + `empty` + `balance` (no money spent) |

```bash
# Comprehensive — all 40 tools × applicable auth modes, side-by-side report
VENICE_API_KEY=<your-venice-api-key> npm run test:e2e:all-tools
```

## FAQ

**Do I have to deal with crypto?**
No. The simple path is `VENICE_API_KEY` + a normal Venice account. x402 is an *option* for users who want a wallet-only flow.

**Where does the wallet's private key live?**
Not in this server. You sign the EVM SIWE or Solana SIWX message and any USDC top-up payment in your own wallet. The server only sees signed payloads and never accepts a private key.


**Minimum top-up?**
$5 USD (anti-dust). Minimum balance to call inference is $0.10. Default suggested top-up is $10.

**Privacy guarantees?**
No email, phone, or KYC if you go the SIWX path. The wallet ↔ credit account mapping is the only identity link. The MCP server itself does not log prompts or responses. Combine with `X-Venice-TEE-Required: 1` (passed through by your client) to also run inference inside Intel TDX + NVIDIA NRAS confidential compute.

**DIEM staking?**
If your wallet is linked to a Venice user with DIEM staked, calls consume from the staking balance instead of USDC credits — no top-up needed.

**Getting 402 errors even though I have an API key?**
The most common cause is that `VENICE_API_KEY` isn't being forwarded to the MCP server process. Most MCP hosts (Claude Desktop, Cursor, Codex, etc.) only pass environment variables that are **explicitly listed** in the `"env"` block of your MCP config — system-level env vars are not automatically inherited. Make sure your config looks like this:
```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server@0.2.0"],
      "env": { "VENICE_API_KEY": "<your-venice-api-key>" }
    }
  }
}
```
If the key is missing or blank, the server falls back to x402 mode and returns a 402 payment challenge.

---

## Disclaimer

Community-maintained. Provided **as-is**, with no warranty or SLA from Venice AI. Use at your own risk.

## License

MIT
