# @veniceai/mcp-server

> Model Context Protocol server for **Venice.ai** — uncensored, private AI for any MCP host (Claude Desktop, Cursor, ChatGPT, LM Studio, Continue, LibreChat, Open WebUI, AnythingLLM, Jan, Le Chat, Smithery).

[![npm](https://img.shields.io/npm/v/@veniceai/mcp-server.svg)](https://www.npmjs.com/package/@veniceai/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Plug Venice's chat, image, video, audio, music, and character models into any agent in 30 seconds. **31 tools across all modalities, one config block.**

## Quick start

### 1. Get a key from [venice.ai](https://venice.ai)

### 2. Add this to your MCP host config

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows), **Cursor** (`~/.cursor/mcp.json`), **LM Studio**, etc:

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server"],
      "env": { "VENICE_API_KEY": "<your-venice-api-key>" }
    }
  }
}
```

### 3. Restart your MCP host

That's it. Type a prompt — your agent now has chat, image, video, music, TTS, ASR, and 25 more Venice tools.

### Smithery (one-line install)

```bash
npx -y @smithery/cli install venice
```

## What you get

| Capability | Tools |
|---|---|
| **Chat** | `venice_chat`, `venice_responses`, `venice_chat_with_character`, `venice_embeddings` |
| **Image** | `venice_image_generate`, `venice_image_edit`, `venice_image_multi_edit`, `venice_image_upscale`, `venice_image_remove_bg`, `venice_image_styles` |
| **Video** | `venice_video_generate`, `venice_video_status`, `venice_video_complete`, `venice_video_transcriptions`, `venice_video_quote` |
| **Audio** | `venice_tts`, `venice_asr`, `venice_voice_clone`, `venice_audio_quote` |
| **Music** | `venice_music_generate`, `venice_music_status`, `venice_music_complete` |
| **Web** | `venice_web_search`, `venice_web_scrape`, `venice_text_parser` |
| **Models / Characters** | `venice_list_models`, `venice_list_characters` |
| **Crypto** | `venice_crypto_rpc` (Base, Ethereum, Polygon, …) |
| **x402 helpers** | `venice_x402_balance`, `venice_x402_top_up_info`, `venice_x402_transactions` |

Plus **3 resources** (`venice://models`, `venice://styles`, `venice://voices`) and **3 prompt templates** (uncensored research, NSFW creative writing, image style explorer).

Top models available: Flux 2 Pro, Lustify SDXL, Anime WAI, Qwen Image, Sora 2, Veo 3.1, Kling 2.6, Wan 2.6, LTX 2.0, ElevenLabs music, voice cloning, and more.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `VENICE_API_KEY` | _(none)_ | Your Venice API key. The simplest setup. |
| `VENICE_DEFAULT_CHAT_MODEL` | `venice-uncensored` | |
| `VENICE_DEFAULT_IMAGE_MODEL` | `flux-2-pro` | |
| `VENICE_DEFAULT_TTS_MODEL` | `tts-kokoro` | |
| `VENICE_DEFAULT_ASR_MODEL` | `openai/whisper-large-v3` | |
| `VENICE_DISABLE_NSFW` | `0` | Set to `1` to remove NSFW capability notes from tool descriptions. |
| `VENICE_HTTP_TIMEOUT_MS` | `60000` | |
| `VENICE_API_BASE_URL` | `https://api.venice.ai` | Override for self-hosted Venice. |
| `VENICE_SIWX_TOKEN` | _(none)_ | Wallet-mode auth — see [Advanced: pay with a wallet](#advanced-pay-with-a-wallet-no-account-required). |
| `PORT` | `3333` | HTTP-mode listener. |
| `VENICE_MCP_HOST` | `127.0.0.1` | HTTP-mode bind address. Set to `0.0.0.0` for LAN/container exposure. |

## Self-hosting (Streamable HTTP)

```bash
docker run -p 3333:3333 -e VENICE_API_KEY=<your-venice-api-key> ghcr.io/veniceai/venice-mcp-server:latest
# server at http://localhost:3333/mcp
```

Or run from source — see [Development](#development) below.

---

## Advanced: pay with a wallet (no account required)

> Skip this section if you're using `VENICE_API_KEY`. Everything below is optional and only matters if you specifically want to pay with a crypto wallet instead of a Venice account.

Venice supports authenticating with a **SIWE-signed wallet token** (a.k.a. SIWX) backed by **prepaid USDC credit on Base mainnet**, in addition to the normal API key flow. This lets you use Venice with no email, phone, or KYC — your wallet is the only identity.

### Two-line config

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server"],
      "env": { "VENICE_SIWX_TOKEN": "<base64 SIWE payload>" }
    }
  }
}
```

The MCP server forwards `VENICE_SIWX_TOKEN` as the `X-Sign-In-With-X` header on every Venice API call.

### How it works

```
ONE-TIME SETUP (per wallet)
  Sign a SIWE message → produces a SIWX token (base64 JSON)
  Set VENICE_SIWX_TOKEN in this MCP server's env

TOP UP (when balance is low)
  POST /api/v1/x402/top-up  (no payment header)  →  402 + payment requirements
  Sign a USDC EIP-3009 transferWithAuthorization in your wallet
  POST /api/v1/x402/top-up with X-402-Payment: <signed>  →  Venice settles via
  Coinbase CDP facilitator and credits your prepaid balance

EVERY INFERENCE CALL
  MCP server sends X-Sign-In-With-X: <SIWX token>
  Venice → wallet → credit account → debits and runs inference
```

This MCP server **never sees your private key**. SIWE signing and USDC authorization happen in your wallet (MetaMask, Coinbase Wallet, viem script, etc.) — the server is purely a header forwarder.

The helper tools `venice_x402_balance`, `venice_x402_top_up_info`, and `venice_x402_transactions` make balance + top-up flow inspectable from inside the agent.

### Why prepaid instead of per-call?

- ⚡ **Latency** — once topped up, calls are sub-100ms (no on-chain settlement per call)
- 🧮 **Throughput** — Coinbase CDP facilitator settles top-ups in batches
- 🔒 **Privacy** — wallet ↔ credit account is the only identity link; no email/phone/KYC
- 🪙 **DIEM shortcut** — wallets linked to a Venice user with DIEM staked consume from staking balance, no USDC needed
- 💸 **Min top-up $5** (anti-dust). Minimum balance to inference is $0.10.

### Per-call HTTP 402 — not supported

Venice rejects `X-402-Payment` on inference routes. The header is only accepted on `/api/v1/x402/top-up`. This is by design — Venice settles top-ups in batches via the Coinbase CDP facilitator, then debits a fast off-chain credit account on inference. If you need per-call settlement semantics, you'll need a separate proxy that pays the credit account on demand.

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
│  (Claude / Cursor /  ├────────────────────────▶│  - 31 tools            │
│   ChatGPT / etc.)    │                         │  - 3 resources         │
└──────────────────────┘                         │  - 3 prompts           │
                                                 │  - header forwarder    │
                                                 └────────────┬───────────┘
                                                              │ HTTPS
                                                              │   Authorization: Bearer ***
                                                              │   OR
                                                              │   X-Sign-In-With-X: <SIWX>
                                                              ▼
                                                 ┌────────────────────────┐
                                                 │  Venice API            │
                                                 │  api.venice.ai         │
                                                 └────────────────────────┘
```

## Tool reference

<details>
<summary>Click to expand the full tool catalog (31 tools, endpoint mapping)</summary>

### Inference (API key OR x402)

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

### x402 wallet helpers

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
npm test                  # full suite (71 tests across 10 suites, ~3s)
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
├── tools.test.ts              # 31 tool registry + endpoint+method+body mappings
├── integration.test.ts        # end-to-end JSON-RPC over stdio against a mock Venice
└── helpers/
    ├── stub-client.ts         # in-process VeniceClient stub
    └── mock-venice-server.ts  # real http.Server fake of Venice for integration tests
```

The integration suite spawns the compiled CLI and speaks JSON-RPC on its stdin/stdout, exercising `initialize` → `tools/list` → `tools/call` → `resources/list` → `resources/read` against a real HTTP mock Venice in three auth scenarios (API key only, SIWX only, no auth).

### End-to-end with live Venice + Base mainnet

`test/e2e/` is a phased harness against the **real** Venice API and **real** Base mainnet — not a mock. It generates a throwaway wallet, signs SIWE + EIP-3009 payloads with `viem`, and drives the MCP server via JSON-RPC over stdio. The wallet is persisted at `.e2e-wallet.json` (chmod 600, gitignored — **never commit**).

| Phase | npm script | Cost | What it tests |
|---|---|---|---|
| `create` | `test:e2e:create` | free | Generate / reload wallet, print address + balance |
| `empty` | `test:e2e:empty` | free | SIWX → MCP `venice_chat` → expect 402 with helpful diagnostics |
| `topup` | `test:e2e:topup` | $5 USDC + gas | Sign EIP-3009 → POST `/api/v1/x402/top-up` → settle on-chain via CDP facilitator |
| `funded` | `test:e2e:funded` | ~$0.001 / call | SIWX → MCP `venice_chat` → real LLM completion charged to prepaid balance |
| `balance` | `test:e2e:balance` | free | Read on-chain USDC + Venice prepaid via `venice_x402_balance` tool |
| `safe` | `test:e2e:safe` | free | `create` + `empty` + `balance` (no money spent) |

```bash
# Comprehensive — all 31 tools × both auth modes, side-by-side report
VENICE_API_KEY=<your-venice-api-key> npm run test:e2e:all-tools
```

## FAQ

**Do I have to deal with crypto?**
No. The simple path is `VENICE_API_KEY` + a normal Venice account. x402 is an *option* for users who want a wallet-only flow.

**Where does the wallet's private key live?**
Not in this server. You sign the SIWE message + USDC top-up authorizations in your own wallet (MetaMask, Coinbase Wallet, viem-script, etc.). The server only sees the resulting SIWX token and never sees a private key.

**Can my agent self-rate-limit?**
Pass `X-Venice-Max-Cost: 0.05` (USDC) on requests via your client; Venice will 402 with a `cost_cap_exceeded` reason before running expensive jobs.

**What's the Venice receiver wallet?**
`0x2670B922ef37C7Df47158725C0CC407b5382293F` on Base mainnet. Top-ups are USDC. (Check the live `topUpInstructions` in the 402 response — this is the source of truth.)

**Minimum top-up?**
$5 USD (anti-dust). Minimum balance to call inference is $0.10. Default suggested top-up is $10.

**Privacy guarantees?**
No email, phone, or KYC if you go the SIWX path. The wallet ↔ credit account mapping is the only identity link. The MCP server itself does not log prompts or responses. Combine with `X-Venice-TEE-Required: 1` (passed through by your client) to also run inference inside Intel TDX + NVIDIA NRAS confidential compute.

**DIEM staking?**
If your wallet is linked to a Venice user with DIEM staked, calls consume from the staking balance instead of USDC credits — no top-up needed.

---

## Disclaimer

Community-maintained. Provided **as-is**, with no warranty or SLA from Venice AI. Use at your own risk.

## License

MIT
