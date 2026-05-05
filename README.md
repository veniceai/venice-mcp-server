# @veniceai/mcp-server

> Model Context Protocol server for **Venice.ai** — uncensored, private, crypto-native AI for any MCP host (Claude Desktop, Cursor, ChatGPT, LM Studio, Continue, LibreChat, Open WebUI, AnythingLLM, Jan, Le Chat, Smithery).

[![npm](https://img.shields.io/npm/v/@veniceai/mcp-server.svg)](https://www.npmjs.com/package/@veniceai/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> ⚠️ **Disclaimer:** Community-maintained. Provided as-is, with no warranty or SLA from Venice AI. Use at your own risk.

## Why

Plug Venice's uncensored chat, image, video, audio, music, and character APIs into **any agent** — with **no account required**. Authenticate via API key OR pay-per-call via **x402 (HTTP 402 Payment Required)** stablecoin micropayments.

## Two ways to authenticate

### 1. API key (the normal way)

Get a key from venice.ai → set `VENICE_API_KEY=vk_...` in env. Done. Every tool call is billed against your Venice account.

### 2. x402 wallet — prepaid credit, no account *(unique to Venice)*

[**x402**](https://x402.org) is an open HTTP `402 Payment Required` standard for crypto micropayments. Venice uses x402 primitives to let users pay with a wallet instead of a Stripe-tied account, but the **mechanism is a prepaid credit account**, not per-call settlement.

> **Important:** Venice rejects `X-402-Payment` on inference routes. Per-request HTTP-402 payment-and-retry is **not** how Venice's API works. If you've used "x402" elsewhere (e.g. raw x402.org demos), the flow here is different.

#### How it actually works

```
                  ┌────────────────────────────────────┐
                  │  ONE-TIME SETUP (per wallet)       │
                  └────────────────────────────────────┘
1. Sign a SIWE message → produces a SIWX token (base64 JSON).
2. Set VENICE_SIWX_TOKEN in this MCP server's env.

                  ┌────────────────────────────────────┐
                  │  TOP UP (when balance is low)       │
                  └────────────────────────────────────┘
3. POST /api/v1/x402/top-up (no payment header)
       → Venice returns 402 with payment requirements
         (USDC token addr, receiver wallet, network, min amount).
   Use the venice_x402_top_up_info tool for this.
4. With your wallet, sign a USDC EIP-3009 transferWithAuthorization
   for the amount, with payTo = Venice receiver wallet.
5. POST /api/v1/x402/top-up with X-402-Payment: <signed> header
       → Venice settles via Coinbase CDP facilitator and credits
         your X402CreditAccount.

                  ┌────────────────────────────────────┐
                  │  EVERY INFERENCE CALL              │
                  └────────────────────────────────────┘
6. MCP server sends `X-Sign-In-With-X: <SIWX token>` (NOT X-402-Payment).
7. Venice resolves wallet → credit account → checks balance.
8. If sufficient: runs inference, debits credit account, returns result.
   If insufficient: 402 with current balance + top-up instructions.
```

**Concretely, what this MCP server does:**

- If `VENICE_API_KEY` is set → uses it. Standard. (Recommended for most users.)
- Else if `VENICE_SIWX_TOKEN` is set → forwards it as `X-Sign-In-With-X` on every call. Calls debit your prepaid x402 credit account.
- Else → every call gets a 402; we format the response as a friendly "set one of those env vars or top up" message.

**The signing + top-up steps happen outside this server.** This server never sees your private key. Use Venice's documented x402 SDK or any EIP-3009 capable wallet to:
1. Generate the SIWX token (sign a SIWE message once).
2. Sign the USDC authorization (when you want to top up).
3. POST the signed top-up to `/api/v1/x402/top-up`.

The two helper tools `venice_x402_balance` and `venice_x402_top_up_info` make steps 1 + 3 inspectable from inside the agent host.

**Why prepaid instead of per-call?**

- ⚡ **Latency** — once topped up, calls are sub-100ms (no on-chain settlement per call).
- 🧮 **Throughput** — Coinbase CDP facilitator settles top-ups in batches.
- 🪙 **DIEM staking shortcut** — if your wallet is linked to a Venice user with DIEM staked, calls consume from the staking balance (no USDC needed).
- 🔒 **Privacy preserved** — wallet ↔ credit account is the only identity link; no email/phone/KYC.
- 💸 **Min top-up is $5** (anti-dust) and minimum balance to inference is $0.10.

**Example real 402 response** (when balance is exhausted):

```json
{
  "error": "Payment required",
  "code": "PAYMENT_REQUIRED",
  "reason": "insufficient_balance",
  "currentBalanceUsd": 0.001,
  "minimumBalanceUsd": 0.1,
  "suggestedTopUpUsd": 10.0,
  "minimumTopUpUsd": 5.0,
  "supportedTokens": ["USDC"],
  "supportedChains": ["base"],
  "topUpInstructions": {
    "step1": "POST /api/v1/x402/top-up with no payment header to get payment requirements",
    "step2": "Sign a USDC transfer authorization using the x402 SDK (createPaymentHeader)",
    "step3": "POST /api/v1/x402/top-up with the signed X-402-Payment header",
    "receiverWallet": "0x2670B922ef37C7Df47158725C0CC407b5382293F",
    "network": "base",
    "minimumAmountUsd": 5.0
  }
}
```

The MCP server reformats this into a human-readable top-up instruction the agent can show to the user.

**Hybrid mode:** Set `VENICE_API_KEY` AND `VENICE_SIWX_TOKEN` if you want — API key wins. SIWX is only used when the key is absent.



## Tools

This MCP server exposes **31 tools** mapped to Venice API endpoints.

### Inference (x402 wallet OR API key)

| Tool | Endpoint | Notes |
|---|---|---|
| `venice_chat` | `POST /v1/chat/completions` | OpenAI-compat chat |
| `venice_responses` | `POST /v1/responses` | OpenAI Responses API |
| `venice_embeddings` | `POST /v1/embeddings` | Text embeddings |
| `venice_image_generate` | `POST /v1/image/generate` | Flux 2, Lustify SDXL, Anime WAI, Qwen Image, etc. |
| `venice_image_edit` | `POST /v1/image/edit` | Edit with prompt |
| `venice_image_multi_edit` | `POST /v1/image/multi-edit` | Multi-image composition |
| `venice_image_upscale` | `POST /v1/image/upscale` | 2× / 4× |
| `venice_image_remove_bg` | `POST /v1/image/background-remove` | Transparent PNG |
| `venice_video_generate` | `POST /v1/video/queue` | Sora 2, Veo 3.1, Kling 2.6, Wan 2.6, LTX 2.0, Ovi, Longcat |
| `venice_video_status` | `POST /v1/video/retrieve` | Status: PROCESSING / COMPLETED |
| `venice_video_complete` | `POST /v1/video/complete` | Cleanup; remove server-side media |
| `venice_video_transcriptions` | `POST /v1/video/transcriptions` | ASR over a video |
| `venice_tts` | `POST /v1/audio/speech` | TTS + voice cloning + emotion tags |
| `venice_asr` | `POST /v1/audio/transcriptions` | Speech-to-text (URL; multipart on real endpoint) |
| `venice_voice_clone` | `POST /v1/audio/voices` | Manage cloned voices |
| `venice_music_generate` | `POST /v1/audio/queue` | Music gen (queue) |
| `venice_music_status` | `POST /v1/audio/retrieve` | Music status (POST) |
| `venice_music_complete` | `POST /v1/audio/complete` | Music cleanup |
| `venice_web_search` | `POST /v1/augment/search` | Firecrawl-backed web search |
| `venice_web_scrape` | `POST /v1/augment/scrape` | Single-URL scrape → markdown |
| `venice_text_parser` | `POST /v1/augment/text-parser` | PDF/DOCX/EPUB/PPTX/XLSX text extraction |
| `venice_crypto_rpc` | `POST /v1/crypto/rpc/:network` | JSON-RPC proxy (eth, base, polygon, …) |

### Catalog & quotes (auth-free)

| Tool | Endpoint | |
|---|---|---|
| `venice_list_models` | `GET /v1/models` | |
| `venice_image_styles` | `GET /v1/image/styles` | |
| `venice_audio_quote` | `GET /v1/audio/quote` | Music price quote |
| `venice_video_quote` | `GET /v1/video/quote` | Video price quote |

### Characters (API key only — no x402)

| Tool | Endpoint | |
|---|---|---|
| `venice_list_characters` | `GET /v1/characters` | API key required |
| `venice_chat_with_character` | `POST /v1/chat/completions` (with `character_slug`) | Inference itself supports x402, but discovery doesn't |

### x402 wallet (helpers)

| Tool | Endpoint | |
|---|---|---|
| `venice_x402_balance` | `GET /v1/x402/balance/:wallet` | Check prepaid USDC balance |
| `venice_x402_top_up_info` | `POST /v1/x402/top-up` (no payment) | Returns 402 + payment requirements |
| `venice_x402_transactions` | `GET /v1/x402/transactions/:wallet` | Top-up + debit history |

## Resources

- `venice://models` — live model catalog (auth-free)
- `venice://styles` — image style presets
- `venice://voices` — TTS voices including cloned

## Prompts

- `uncensored-research` — security / medical / legal / journalism scaffold
- `nsfw-creative-writing` — adult creative-writing scaffold
- `image-style-explorer` — comparative style generation

## Install

### Claude Desktop / Cursor / LM Studio (stdio)

Add to your MCP config:

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server"],
      "env": { "VENICE_API_KEY": "vk_..." }
    }
  }
}
```

If you omit `VENICE_API_KEY`, the server forwards 402 payment challenges back to the host so an agent with a wallet can pay per call (x402 mode).

### Smithery (hosted)

```bash
npx -y @smithery/cli install venice
```

### x402 wallet mode (no Venice account)

Pre-generate a SIWX token (sign a SIWE message with your wallet — see Venice x402 SDK), then:

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["-y", "@veniceai/mcp-server"],
      "env": {
        "VENICE_SIWX_TOKEN": "<base64-encoded-signed-SIWE-payload>"
      }
    }
  }
}
```

The server forwards the token as `X-Sign-In-With-X` on every call. Calls debit your prepaid x402 credit account. Top up beforehand via `POST /api/v1/x402/top-up` (use `venice_x402_top_up_info` to see requirements).

### Streamable HTTP (Cloud Run, self-host)

```bash
docker run -p 3333:3333 -e VENICE_API_KEY=vk_... ghcr.io/veniceai/venice-mcp-server:latest
# server at http://localhost:3333/mcp
```

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `VENICE_API_KEY` | _(none)_ | Standard API key. **Takes precedence** over `VENICE_SIWX_TOKEN`. |
| `VENICE_SIWX_TOKEN` | _(none)_ | Base64-encoded signed SIWE payload (`X-Sign-In-With-X` header value). Authenticates a wallet against its prepaid x402 credit account. Mutually compatible with `VENICE_API_KEY` but only used when the key is absent. |
| `VENICE_API_BASE_URL` | `https://api.venice.ai` | Override for self-hosted Venice |
| `VENICE_DEFAULT_CHAT_MODEL` | `venice-uncensored-1.1` | |
| `VENICE_DEFAULT_IMAGE_MODEL` | `flux-2-pro` | |
| `VENICE_DEFAULT_TTS_MODEL` | `venice-tts-1` | |
| `VENICE_DEFAULT_ASR_MODEL` | `venice-asr-1` | |
| `VENICE_DISABLE_NSFW` | `0` | Set to `1` to remove NSFW capability notes from tool descriptions |
| `VENICE_HTTP_TIMEOUT_MS` | `60000` | |
| `PORT` | `3333` | HTTP mode only |

> **What this server is NOT:** it is **not** an x402 payment client. It does not sign anything, hold a private key, or issue USDC transfers. The SIWX token + USDC top-up signing happen in your wallet (or in a separate one-time setup script using Venice's x402 SDK). This server is purely a request forwarder that adds the right header.

## Development

```bash
npm install
npm run build
npm test                # full suite (71 tests across 10 suites, ~3s)
npm run test:unit       # unit tests only — fast feedback during development
npm run test:integration # spawns dist/cli.js + a mock Venice over real stdio JSON-RPC
npm start               # stdio mode
npm run start:http      # http mode on :3333
```

### Test layout

```
test/
├── config.test.ts            # env parsing, defaults, header precedence
├── format.test.ts            # 402 formatter cases (insufficient balance, no auth, fallback)
├── venice-client.test.ts  # HTTP client + real mock Venice (Authorization vs SIWX, timeouts, 5xx)
├── tools.test.ts             # 31 tool registry + endpoint+method+body mappings + output shapes
├── integration.test.ts       # end-to-end JSON-RPC over stdio against a mock Venice
└── helpers/
    ├── stub-client.ts        # in-process VeniceClient stub
    └── mock-venice-server.ts # real http.Server fake of Venice for integration tests
```

The integration suite spawns the compiled CLI as a child process and speaks JSON-RPC on its stdin/stdout, so it covers `initialize` → `notifications/initialized` → `tools/list` → `tools/call` → `resources/list` → `resources/read` against a real HTTP mock Venice. Three scenarios are exercised: `VENICE_API_KEY` only, `VENICE_SIWX_TOKEN` only (verifies `X-Sign-In-With-X` is forwarded and not `Authorization`), and no auth at all (verifies the 402 → "Option A / Option B" formatting reaches the agent over the wire).

### End-to-end x402 testing (live Venice + Base mainnet)

`test/e2e/` provides a phased harness that exercises the full stack against the **real** Venice API and **real** Base mainnet — not a mock. It generates a throwaway wallet, signs SIWE + EIP-3009 payloads with `viem`, and drives the MCP server via JSON-RPC over stdio.

```
test/e2e/
├── wallet-helper.ts        # wallet gen, SIWE signing, EIP-3009 transferWithAuthorization
├── mcp-stdio-client.ts     # spawns dist/cli.js as child, speaks MCP JSON-RPC
├── run.ts                  # phase orchestrator
└── debug.ts                # direct-API debug helper (bypasses MCP)
```

The wallet is persisted at `mcp-server/.e2e-wallet.json` (chmod 600, gitignored). **Never commit this file** — it contains a live mainnet private key.

#### Phases

| Phase     | npm script              | Cost            | What it tests |
|-----------|-------------------------|-----------------|---------------|
| `create`  | `test:e2e:create`       | free            | Generate / reload wallet, print address + balance |
| `empty`   | `test:e2e:empty`        | free            | SIWX → MCP `venice_chat` → expect 402 with helpful diagnostics |
| `topup`   | `test:e2e:topup`        | $5 USDC + gas   | Sign EIP-3009 → POST `/api/v1/x402/top-up` → settle on-chain via CDP facilitator |
| `funded`  | `test:e2e:funded`       | ~$0.001 / call  | SIWX → MCP `venice_chat` → real LLM completion charged to prepaid balance |
| `balance` | `test:e2e:balance`      | free            | Read on-chain USDC + Venice prepaid via `venice_x402_balance` tool |
| `safe`    | `test:e2e:safe`         | free            | `create` + `empty` + `balance` (no money spent) |

#### Typical first-time run

```bash
# 1. Generate the wallet, get the address
npm run test:e2e:create
# → 0xFF3F... (record this)

# 2. Verify the empty-wallet path (no funding needed)
npm run test:e2e:empty
# → ✓ PASS: empty wallet correctly returned 402

# 3. Send $5+ USDC to the address on Base mainnet (chain 8453)
#    Native USDC contract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
#    No ETH needed — facilitator settles gaslessly via EIP-3009

# 4. Top up the Venice prepaid balance
npm run test:e2e:topup
# → ✓ Top-up settled

# 5. Real LLM call via x402
npm run test:e2e:funded
# → ✓ PASS: real completion returned

# 6. Verify the balance + see consumption
npm run test:e2e:balance
```

#### Known good output

```
PHASE 4: Funded-wallet test (expect real chat completion)
[e2e] calling venice_chat...
{
  "content": [{ "type": "text", "text": "Hello from x402" }],
  "structuredContent": {
    "usage": { "prompt_tokens": 1609, "completion_tokens": 7, "total_tokens": 1616 }
  }
}
[e2e] ✓ PASS: real completion returned
```

#### What this proves

The full critical path: `viem-signed SIWE` → `X-Sign-In-With-X header` → `MCP venice_chat tool` → `Venice client` → `api.venice.ai/api/v1/chat/completions` → `Venice auth layer` → `Coinbase CDP facilitator` (for top-ups) → `Venice prepaid credit account` → `LLM inference` → `JSON-RPC response back through stdio`. Every layer is exercised against live infra.

#### Override defaults

```bash
VENICE_API_URL=https://api.example.venice.ai npm run test:e2e:empty   # point at a custom base URL
BASE_RPC_URL=https://your-rpc/...                                     # custom Base RPC for balance reads
E2E_TOPUP_USD=10 npm run test:e2e:topup                               # top up $10 instead of $5
```

### Comprehensive tool e2e — all 31 tools × auth modes

`test/e2e/test-all-tools.ts` exercises **every tool** against the **live Venice API** in both API-key and x402 wallet modes, then prints a side-by-side table. Each tool's call hits the real backend (with cheap minimal arguments — small chats, low-step images, short videos queued only).

```bash
# Both modes (default)
VENICE_API_KEY=... npm run test:e2e:all-tools

# API key only
VENICE_API_KEY=... npm run test:e2e:all-tools:apikey

# x402 wallet only (uses persisted .e2e-wallet.json — needs prepaid balance)
npm run test:e2e:all-tools:x402
```

The harness produces output like:

```
─ API Key mode ─
  ✓ venice_list_models                    [resp]
  ✓ venice_chat                           Ok
  ✓ venice_image_generate                 [base64 png]
  ✓ venice_video_generate                 Queued: queue_id=...
  ⚠ venice_x402_balance                   expected to fail in apikey mode
  ...
  APIKEY mode: 27 pass, 4 expected-fail, 0 fail, 0 skip — 31/31 acceptable
```

A JSON report is written to `test/e2e/last-report.json` for CI / further analysis.

#### Auth-mode coverage notes

Some Venice endpoints don't accept both auth modes:

| Tool | API key | x402 | Notes |
|---|---|---|---|
| `venice_list_characters` | ✓ | ✗ | characters endpoint is API-key only |
| `venice_x402_balance` | ✗ | ✓ | SIWX-only by design — wallet-bound endpoint |
| `venice_x402_transactions` | ✗ | ✓ | Same — needs SIWX-authenticated wallet |
| `venice_x402_top_up_info` | ✓ | ✓ | Auth-free; both modes get the same 402 response with payment requirements |

The harness marks these as `expectIn: { apikey, x402 }` in the test plan, so a 402 in the mismatched mode counts as **expected-fail** rather than a real failure.

## Architecture

```
┌──────────────────────┐        stdio  OR        ┌─────────────────────┐
│  MCP host            │      Streamable HTTP    │  @veniceai/mcp-server      │
│  (Claude / Cursor /  ├────────────────────────▶│  - 31 tools         │
│   ChatGPT / etc.)    │                         │  - 3 resources      │
└──────────────────────┘                         │  - 3 prompts        │
                                                 │  - header forwarder │
                                                 └──────────┬──────────┘
                                                            │ HTTPS
                                                            │   Authorization: Bearer <key>
                                                            │   OR
                                                            │   X-Sign-In-With-X: <SIWX>
                                                            ▼
                                                 ┌─────────────────────┐
                                                 │  Venice API         │
                                                 │  api.venice.ai      │
                                                 └─────────────────────┘
```

### Wallet-mode call flow

```
Agent: tools/call venice_chat                            (1)
  │
  ▼
@veniceai/mcp-server ──► POST /v1/chat/completions              (2)
                    X-Sign-In-With-X: <SIWX from env>
  │
  ├─ Success → Venice debits credit account, returns response   (3a)
  │
  └─ 402 (insufficient balance) → server formats top-up         (3b)
        instructions; agent surfaces them to user.
        User runs venice_x402_top_up_info → signs USDC
        authorization in their wallet → POSTs to
        /api/v1/x402/top-up. Then retries the inference call.
```

## FAQ

**Q: Do I have to deal with crypto?**
No. The simple path is `VENICE_API_KEY` + a normal Venice account. x402 is the *option* for users who want a wallet-only flow.

**Q: Where does the wallet's private key live?**
Not in this server. You sign the SIWE message + USDC top-up authorizations in your own wallet (MetaMask, Coinbase Wallet, viem-script, etc.). The server only sees the resulting SIWX token and never sees a private key.

**Q: Can my agent self-rate-limit?**
Pass `X-Venice-Max-Cost: 0.05` (USDC) on requests via your client; Venice will 402 with a `cost_cap_exceeded` reason before running expensive jobs.

**Q: What's the Venice receiver wallet?**
`0x2670B922ef37C7Df47158725C0CC407b5382293F` on Base mainnet. Top-ups are USDC. (Check the live `topUpInstructions` in the 402 response — this is the source of truth.)

**Q: Minimum top-up?**
$5 USD (anti-dust). Minimum balance to call inference is $0.10. Default suggested top-up is $10.

**Q: Can I do per-call HTTP-402 like the x402.org demos?**
**No.** Venice rejects `X-402-Payment` on inference routes. The header is only accepted on `/api/v1/x402/top-up`. This is by design — Venice settles top-ups in batches via the Coinbase CDP facilitator, then debits a fast off-chain credit account on inference. If you need per-call settlement semantics, you'll need a separate proxy that pays the credit account on demand.

**Q: Privacy guarantees?**
No email, phone, or KYC if you go the SIWX path. The wallet-↔-credit-account mapping is the only identity link. The MCP server itself does not log prompts or responses. Combine with `X-Venice-TEE-Required: 1` (passed through by your client) to also run inference inside Intel TDX + NVIDIA NRAS confidential compute.

**Q: DIEM staking?**
If your wallet is linked to a Venice user with DIEM staked, calls consume from the staking balance instead of USDC credits — no top-up needed.

## License

MIT
