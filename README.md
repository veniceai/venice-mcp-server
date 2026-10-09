# @veniceai/mcp-server

> Model Context Protocol server for the **Venice API** - uncensored, private AI for any MCP host (Claude Desktop, Cursor, ChatGPT, LM Studio, Continue, LibreChat, Open WebUI, AnythingLLM, Jan, Le Chat).

[![npm](https://img.shields.io/npm/v/@veniceai/mcp-server.svg)](https://www.npmjs.com/package/@veniceai/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Plug Venice's chat, image, video, audio, music, and character models into any agent in 30 seconds, including billing and API-key operations. **45 tools across all modalities, one config block.**

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

That's it. Type a prompt — your agent now has chat, image, video, music, TTS, ASR, and 39 more Venice tools.


## What you get

**45 tools** spanning every Venice modality plus billing and API-key operations, **3 resources** (`venice://models`, `venice://styles`, `venice://voices`) and **3 prompt templates** (uncensored research, NSFW creative writing, image style explorer). The voices resource is built live from each TTS model's catalog metadata.

Every tool declares explicit `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` annotations, so hosts can run lookups without prompting and ask before anything destructive, like media cleanup or a crypto relay.

### 💬 Chat & embeddings

| Tool | Description |
|---|---|
| `venice_chat` | Chat completions with documented text/image/audio/video/file blocks, structured response formats, function tools, prompt caching, and reasoning controls. Calls are plaintext and non-streaming. |
| `venice_responses` | Alpha, stateless Responses API for text models. Supports text/image input and reasoning controls. E2EE-capable models are not supported, and this tool does not expose unreliable tool fields. |
| `venice_embeddings` | Compute embeddings for text input (OpenAI-compatible). |
| `venice_chat_with_character` | Chat with a Venice character by slug. |

### 🎨 Image

| Tool | Description |
|---|---|
| `venice_image_generate` | Generate an image. Supports model-specific width/height or free-string `aspect_ratio`/`resolution`, quality tiers, prompt enhancement, style references, web search, variants, and output format. |
| `venice_image_edit` | Edit an image with a prompt. Supports free-string sizing, output format, and prompt enhancement; returns a base64 image. |
| `venice_image_multi_edit` | Edit multiple images together with a single prompt (multi-image composition / outpainting), including free-string sizing, quality, output format, and prompt enhancement. |
| `venice_image_upscale` | Upscale an image (2–4× scale, with a `creativity` control). Returns base64 PNG. |
| `venice_image_remove_bg` | Remove image background; returns a transparent PNG. |
| `venice_image_styles` | List image style presets available for `venice_image_generate`. |

### 🎬 Video

| Tool | Description |
|---|---|
| `venice_video_generate` | Queue a video generation. Supports Sora 2, Veo 3.1, Kling, Wan, LTX 2, Seedance (incl. r2v video-to-video), Runway Gen-4, and others. Accepts image, video, audio, reference inputs, and the Seedance consent attestation flow where applicable. |
| `venice_video_status` | Check status of a queued video job. Returns JSON progress while `PROCESSING`, then either an embedded MP4 or a `download_url` resource link. Pass the queue-time `download_url` for VPS / Grok Imagine Private models. |
| `venice_video_complete` | Mark a completed video as downloaded. Reports server-side deletion only when Venice confirms success. |
| `venice_video_quote` | Get a price quote for a video generation BEFORE queuing. |

### 🔊 Audio (TTS / ASR)

| Tool | Description |
|---|---|
| `venice_tts` | Convert text to speech. Supports cloned voices, temperature, and Venice's streaming flag; MCP returns the completed audio as one buffered result. |
| `venice_asr` | Transcribe audio from a URL as JSON or text, with optional word and character timestamps. |
| `venice_voice_clone` | Discover live model-scoped voice metadata, or clone a voice from a sample audio URL for `tts-chatterbox-hd` (default) or `tts-minimax-speech-02-hd`. Cloned voices are returned as a `vv_<id>` handle to pass as the `venice_tts` voice. |
| `venice_audio_quote` | Get a price quote for music generation BEFORE queuing. |

### 🎵 Music

| Tool | Description |
|---|---|
| `venice_music_generate` | Queue music generation. Uses the live QueueAudioRequest fields: `force_instrumental`, `lyrics_prompt`, `lyrics_optimizer`, `loop`, `voice`, `language_code`, `speed`, and model-specific `duration_seconds`. Deprecated `instrumental` / `lyrics` are still accepted as aliases. |
| `venice_music_status` | Check status of a queued music job. |
| `venice_music_complete` | Mark a completed music job as downloaded. |

### 🌐 Web augment

| Tool | Description |
|---|---|
| `venice_web_search` | Search with Brave (default, Zero Data Retention) or Google (proxied/anonymized by Venice). Returns the parsed `{ query, results }` as structured content. |
| `venice_web_scrape` | Scrape one URL into markdown text. |
| `venice_text_parser` | Extract text from a document URL (PDF, DOCX, EPUB, PPTX, XLSX, …). |

### 📚 Catalog

| Tool | Description |
|---|---|
| `venice_list_models` | Page through the live model catalog, every type by default, with server-side filtering for `asr`, `decision`, `embedding`, `image`, `music`, `text`, `tts`, `upscale`, `inpaint`, `video`, `all`, `code`, or any newer catalog type. Returns compact summaries (50 per page by default, up to 200) with `total`, `next_offset`, and every matching model id; set `verbose` for full model objects. |
| `venice_model_details` | Get one exact model's full catalog row, including `model_spec` constraints, capabilities, and pricing. |
| `venice_model_traits` | Get the live trait-name to model-id mapping for a model type. |
| `venice_model_compatibility_mapping` | Get compatible model-name to Venice model-id mappings. |
| `venice_list_characters` | List public Venice characters with search, tag/category/model, content, capability, sort, and pagination filters. API key only. |
| `venice_get_character` | Get a public character by slug. API key only. |
| `venice_character_reviews` | List paginated public reviews for a character. API key only. |

### 🔐 TEE attestation

| Tool | Description |
|---|---|
| `venice_tee_attestation` | Fetch Intel TDX attestation evidence, optional NVIDIA evidence, and the model signing key using a caller-generated 32-byte nonce. |
| `venice_tee_signature` | Fetch the enclave response-signature payload for a chat completion request ID. |

Both routes are currently live without authentication. They only apply to text models advertising `supportsTeeAttestation`. These tools expose evidence; they do not verify it, and this server does not encrypt chat. `venice_chat` rejects `enable_e2ee`.

### Media API behavior

- Image `aspect_ratio` and `resolution` values remain free strings because supported values vary by model. Venice validates them. When `enhance_prompt` is applied, image generate/edit/multi-edit results include the URL-decoded `enhanced_prompt` returned in `x-venice-enhanced-prompt`. Image responses are capped at `VENICE_MAX_IMAGE_RESPONSE_BYTES` (default 32 MiB). Unlike an oversized video, an oversized image result cannot be retried for free, so request fewer variants, a lower resolution, or jpeg/webp output for large batches.
- Current public Seedance models may reject media containing detectable persons outright. Defensive support remains for compatible or legacy `needs_consent` responses: the tool returns Venice's policy text, affected media roles, and next step. The three `consents.seedance` flags are legal attestations and must only be set to `true` after the user explicitly confirms all three statements. Consent is never a content-policy bypass.
- Completed videos may arrive as `video/mp4` or as JSON with a `download_url`. Binary completions are returned as an embedded MCP resource (`blob`, `mimeType: "video/mp4"`, synthetic `venice://video/...` URI), streamed into a bounded buffer that defaults to 25 MiB (`VENICE_MAX_VIDEO_RESPONSE_BYTES`). Oversized binary results remain queued and can be retried with the same queue ID after changing the limit. JSON completions return the `download_url` as an MCP resource link instead of fetching that URL. Because that link stops working once the stored media is removed, `delete_media_on_completion` is not applied to `download_url` results: download the file first, then call `venice_video_complete` (and optionally send an HTTP `DELETE` to the link to revoke it). For VPS / Grok Imagine Private models, `download_url` is returned only on queue; pass that URL into `venice_video_status` so a `COMPLETED` retrieve without an inline URL still yields a resource link.

### ⛓️ Crypto

| Tool | Description |
|---|---|
| `venice_crypto_networks` | List the live network slugs supported by the crypto RPC proxy. No authentication required. |
| `venice_crypto_rpc` | Proxy one JSON-RPC request or a batch of up to 100 requests. Returns compact JSON (max 64 KiB) plus Venice's credit, cost, and idempotent-replay headers. Transaction broadcasts must be sent as single requests with `idempotency_key`. |

### 💰 Billing (ADMIN API key only)

| Tool | Description |
|---|---|
| `venice_billing_balance` | Get current USD, DIEM, and bundled-credit availability. |
| `venice_billing_usage_analytics` | Get beta aggregate usage by date, model, and API key using a lookback or custom date range. |
| `venice_billing_usage_history` | Walk detailed usage with cursor pagination, first-page filters, and JSON or CSV output. |

Usage-history first pages default to 10 rows. JSON and CSV pages are returned whole, never truncated. A page exceeding 64 KiB returns an error without partial rows or a continuation cursor; restart with the original filters and a smaller `page_size` (minimum 10), or a narrower timestamp range. Retrying the same cursor cannot reduce the page size encoded in it.

Usage-history continuation calls must send `cursor` without the original filters. CSV pages return a `csv:`-prefixed `nextCursor` so a cursor-only follow-up stays on `text/csv`. The deprecated `/billing/usage` route is not wrapped. Billing tools require an ADMIN `VENICE_API_KEY` and fail locally instead of falling back to SIWX. Inference keys cannot call these endpoints.

### 🔑 API keys

| Tool | Description |
|---|---|
| `venice_list_api_keys` | List active key metadata without full key secrets. ADMIN API key only. |
| `venice_get_api_key` | Get one key's metadata, usage, balances, and rate limits. ADMIN API key only. |
| `venice_api_key_rate_limits` | Get current balances, access status, tier, and model limits. API key only. |
| `venice_api_key_rate_limit_logs` | Get the last 50 exceeded rate-limit events. ADMIN API key only; experimental upstream. |

List, get, and rate-limit logs require an ADMIN `VENICE_API_KEY`. `venice_api_key_rate_limits` accepts an INFERENCE or ADMIN key. These tools never forward `SIGN-IN-WITH-X`. Web3 challenge and mint are not registered here.

### 💳 x402 wallet helpers

> Optional — only needed if you authenticate with a wallet via **x402** instead of an API key. See [**x402** — pay with a wallet](#x402--pay-with-a-wallet-no-account-required).

| Tool | Description |
|---|---|
| `venice_x402_balance` | Check the prepaid x402 credit balance for a wallet address. |
| `venice_x402_top_up_info` | Fetch the top-up payment requirements: the accepted Base and Solana USDC options, each with network, asset, receiver wallet, and minimum amount. Takes no arguments. |
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
| `VENICE_MAX_VIDEO_RESPONSE_BYTES` | `26214400` (25 MiB) | Maximum completed MP4 bytes buffered and base64-embedded by `venice_video_status`. |
| `VENICE_MAX_IMAGE_RESPONSE_BYTES` | `33554432` (32 MiB) | Maximum response bytes buffered by `venice_image_generate`, `venice_image_edit`, `venice_image_multi_edit`, `venice_image_upscale`, and `venice_image_remove_bg`. Larger results are discarded with an error. |
| `VENICE_MAX_AUDIO_RESPONSE_BYTES` | `33554432` (32 MiB) | Maximum audio bytes buffered and base64-embedded by `venice_tts`. Larger results are discarded with an error. |
| `VENICE_SIWX_TOKEN` | _(none)_ | **x402** wallet-mode auth token — see [**x402** — pay with a wallet](#x402--pay-with-a-wallet-no-account-required). |
| `PORT` | `3333` | HTTP-mode listener. |
| `VENICE_MCP_HOST` | `127.0.0.1` | HTTP-mode bind address. Set to `0.0.0.0` for LAN/container exposure. |
| `VENICE_MCP_AUTH` | `token` | HTTP-mode auth. `token`: one shared `VENICE_MCP_AUTH_TOKEN` and the server's own Venice credentials. `user-key`: every caller sends their own Venice API key (or `SIGN-IN-WITH-X` proof); stateless, and the server's credentials are never used. |
| `VENICE_MCP_AUTH_TOKEN` | _(none)_ | Bearer token required by `/mcp` whenever HTTP mode binds outside loopback. Use a long random value. |
| `VENICE_MCP_ALLOWED_ORIGINS` | _(none)_ | Comma-separated browser origins allowed to call `/mcp`. Requests without an `Origin` header (MCP clients) always pass; with no list set, a loopback-bound server only accepts loopback origins. |
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

### One server, many users (`VENICE_MCP_AUTH=user-key`)

For a shared or hosted deployment where each caller should spend their own Venice account, run in `user-key` mode. The server needs no Venice credentials of its own:

```bash
docker run -p 3333:3333 \
  -e VENICE_MCP_HOST=0.0.0.0 \
  -e VENICE_MCP_AUTH=user-key \
  ghcr.io/veniceai/venice-mcp-server:latest
```

Each request must send `Authorization: Bearer <the caller's Venice API key>` (or a `SIGN-IN-WITH-X` wallet proof). The key is only forwarded to the Venice API for that request. The server is stateless: no `mcp-session-id`, a fresh server per request, so it scales horizontally. This works with clients that let you set a static bearer token, such as the xAI API remote MCP tool and Composio.

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
| `venice_list_characters` | ✓ | ✗ | Character discovery endpoint is API-key only |
| `venice_get_character` | ✓ | ✗ | Character discovery endpoint is API-key only |
| `venice_character_reviews` | ✓ | ✗ | Character discovery endpoint is API-key only |
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
│  (Claude / Cursor /  ├────────────────────────▶│  - 45 tools            │
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
| `venice_tts` | `POST /v1/audio/speech` |
| `venice_asr` | `POST /v1/audio/transcriptions` |
| `venice_voice_clone` (`create`) | `POST /v1/audio/voices` |
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
| `venice_list_models` | `GET /v1/models?type=…` (`type=all` when omitted) |
| `venice_model_details` | `GET /v1/models?type=:type` (exact ID match in the filtered catalog) |
| `venice_model_traits` | `GET /v1/models/traits` |
| `venice_model_compatibility_mapping` | `GET /v1/models/compatibility_mapping` |
| `venice_voice_clone` (`list`) / `venice://voices` | `GET /v1/models?type=tts` |
| `venice_image_styles` | `GET /v1/image/styles` |
| `venice_audio_quote` | `POST /v1/audio/quote` |
| `venice_video_quote` | `POST /v1/video/quote` |
| `venice_crypto_networks` | `GET /v1/crypto/rpc/networks` |
| `venice_tee_attestation` | `GET /v1/tee/attestation?model=:model&nonce=:64_hex_chars` |
| `venice_tee_signature` | `GET /v1/tee/signature?model=:model&request_id=:completion_id` |

### Characters (API key only)

| Tool | Endpoint |
|---|---|
| `venice_list_characters` | `GET /v1/characters` |
| `venice_get_character` | `GET /v1/characters/:slug` |
| `venice_character_reviews` | `GET /v1/characters/:slug/reviews` |
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
| `venice_api_key_rate_limit_logs` | `GET /v1/api_keys/rate_limits/log` (ADMIN) |

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
npm run build             # generate dist/ locally
npm test                  # build, then run the full test suite
npm run test:unit         # unit tests only
npm run test:integration  # build, then spawn dist/cli.js + a mock Venice over real stdio JSON-RPC
npm start                 # stdio mode
npm run start:http        # http mode on :3333
```

`dist/` is generated by `npm run build` and is intentionally ignored by git rather than committed. Published npm packages still include `dist/`; the `prepublishOnly` script rebuilds it before publication.

### Test layout

```
test/
├── config.test.ts             # env parsing, defaults, header precedence
├── format.test.ts             # 402 formatter cases
├── venice-client.test.ts      # HTTP client + real mock Venice
├── tools.test.ts              # tool registry (45 tools) + endpoint/method/body mappings
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
# Comprehensive — all 45 tools × both auth modes, side-by-side report (mint is always skipped)
env VENICE_API_KEY=<your-venice-api-key> npm run test:e2e:all-tools
```

## FAQ

**Do I have to deal with crypto?**
No. The simple path is `VENICE_API_KEY` + a normal Venice account. x402 is an *option* for users who want a wallet-only flow.

**Where does the wallet's private key live?**
Not in this server. You sign the EVM SIWE or Solana SIWX message and any USDC top-up payment in your own wallet. The server only sees signed payloads and never accepts a private key.


**Minimum top-up?**
$5 USD (anti-dust). Minimum balance to call inference is $0.10. Default suggested top-up is $10.

**Privacy guarantees?**
No email, phone, or KYC is required on the SIWX path. `venice_tee_attestation` and `venice_tee_signature` return hardware evidence for the caller to verify. This server does not encrypt chat.

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
