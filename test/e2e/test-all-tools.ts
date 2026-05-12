#!/usr/bin/env tsx
/**
 * COMPREHENSIVE end-to-end test of all 31 MCP tools against live Venice API.
 *
 * Runs the same test plan twice — once with API key auth, once with x402 SIWX wallet auth —
 * and produces a side-by-side report showing which tools work in which mode.
 *
 * Usage:
 *   VENICE_API_KEY=xxx npx tsx test/e2e/test-all-tools.ts apikey
 *   npx tsx test/e2e/test-all-tools.ts x402     # uses persistent .e2e-wallet.json
 *   npx tsx test/e2e/test-all-tools.ts both     # default — runs both
 *
 * The script categorizes tools as:
 *   - SAFE_READ:  free / cheap reads (models, styles, balances, quotes)
 *   - CHEAP_GEN:  small generation calls (chat with max_tokens=8, embeddings, asr)
 *   - QUEUE_POLL: queue-based jobs (image, video, music) — kicked off + status checked once
 *   - SKIP:       tools that need real-world setup we can't fake (voice clone, x402 cleanup)
 */
import { spawnMcp, McpClient } from './mcp-stdio-client.js'
import { loadOrCreateWallet, buildSiwxHeader } from './wallet-helper.js'

const VENICE_API = process.env.VENICE_API_URL || 'https://api.venice.ai'
const BASE_URL = VENICE_API.replace(/\/?$/, '/api').replace(/\/api\/api$/, '/api')

type Status = 'pass' | 'fail' | 'skip' | 'expected-fail'
interface ToolResult {
  name: string
  status: Status
  detail: string
  duration_ms: number
}

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
}

function emoji(s: Status): string {
  return { pass: '✓', fail: '✗', skip: '⊘', 'expected-fail': '⚠' }[s]
}
function color(s: Status): string {
  return { pass: COLORS.green, fail: COLORS.red, skip: COLORS.dim, 'expected-fail': COLORS.yellow }[s]
}

interface CallSpec {
  name: string
  args: Record<string, unknown>
  /** Whether this tool is expected to work in the given auth mode. */
  expectIn?: { apikey?: boolean; x402?: boolean }
  /** A predicate to validate the response when expected to pass. */
  validate?: (result: any) => string | null // returns error string or null on pass
  /** Skip entirely with a reason. */
  skipReason?: string
}

/** Build the tool call plan. Each entry exercises one MCP tool. */
function buildPlan(walletAddr: string): CallSpec[] {
  return [
    // ============ SAFE READS — should work in BOTH modes ============
    {
      name: 'venice_list_models',
      args: { type: 'text' },
      validate: r => (r?.structuredContent?.count > 0 ? null : 'expected count > 0'),
    },
    {
      name: 'venice_image_styles',
      args: {},
      validate: r => (typeof r?.content?.[0]?.text === 'string' ? null : 'no text content'),
    },
    {
      name: 'venice_audio_quote',
      args: { model: 'elevenlabs-music', duration_seconds: 30 },
      validate: r => (typeof r?.content?.[0]?.text === 'string' ? null : 'no text content'),
    },
    {
      name: 'venice_video_quote',
      args: { model: 'veo3.1-fast-text-to-video', duration: '4s' },
      validate: r => (typeof r?.content?.[0]?.text === 'string' ? null : 'no text content'),
    },

    // ============ CHEAP GENERATION — both modes ============
    {
      name: 'venice_chat',
      args: {
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        model: 'venice-uncensored',
        max_tokens: 8,
        temperature: 0,
      },
      validate: r => {
        const t = r?.content?.[0]?.text
        if (typeof t !== 'string' || t.length === 0) return 'no text in response'
        if (r?.isError) return `tool reported error: ${t.slice(0, 200)}`
        return null
      },
    },
    {
      name: 'venice_responses',
      args: { input: 'Reply with: ok', model: 'venice-uncensored', max_output_tokens: 8 },
      validate: r => {
        if (r?.isError) return `error: ${String(r?.content?.[0]?.text).slice(0, 200)}`
        return r?.content?.[0]?.text ? null : 'no text'
      },
    },
    {
      name: 'venice_embeddings',
      args: { input: ['hello world'], model: 'text-embedding-bge-m3' },
      validate: r => {
        if (r?.isError) return `error: ${String(r?.content?.[0]?.text).slice(0, 200)}`
        return r?.structuredContent?.dimensions ? null : 'no dimensions in structured response'
      },
    },

    // ============ AUGMENT (search / scrape / parse) ============
    {
      name: 'venice_web_search',
      args: { query: 'venice ai uncensored llm', limit: 3 },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_web_scrape',
      args: { url: 'https://example.com', format: 'markdown' },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_text_parser',
      // Use a tiny, reliable PDF
      args: { url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },

    // ============ CRYPTO RPC ============
    {
      name: 'venice_crypto_rpc',
      args: { network: 'base-mainnet', rpc_method: 'eth_blockNumber', rpc_params: [] },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },

    // ============ IMAGE — generate (synchronous, returns base64) ============
    {
      name: 'venice_image_generate',
      args: {
        prompt: 'a small red apple on a white background, simple, photo',
        model: 'flux-2-pro',
        width: 512,
        height: 512,
        steps: 4,
      },
      validate: r => {
        if (r?.isError) return `error: ${String(r?.content?.[0]?.text).slice(0, 200)}`
        // Default Venice response is base64 image
        const c = r?.content?.[0]
        if (c?.type === 'image' && typeof c.data === 'string' && c.data.length > 100) return null
        if (c?.type === 'resource_link' && c.uri) return null
        return 'no image data returned'
      },
    },
    // image edit / upscale / multi-edit / remove_bg need a real input URL — derived after image_generate
    {
      name: 'venice_image_remove_bg',
      // Stable, public test image
      args: { image_url: 'https://placehold.co/256x256/png' },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_image_upscale',
      args: { image_url: 'https://placehold.co/256x256/png', scale: 2 },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_image_edit',
      args: {
        image_url: 'https://placehold.co/512x512/png',
        prompt: 'add a smiley face',
      },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_image_multi_edit',
      args: {
        image_urls: ['https://placehold.co/512x512/png', 'https://placehold.co/512x512/png'],
        prompt: 'combine these',
      },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },

    // ============ VIDEO (queue → poll once → no wait) ============
    {
      name: 'venice_video_generate',
      args: {
        prompt: 'a still red apple on a table',
        model: 'veo3.1-fast-text-to-video',
        duration: '4s',
        aspect_ratio: '16:9',
      },
      validate: r => {
        if (r?.isError) return `error: ${String(r?.content?.[0]?.text).slice(0, 200)}`
        return r?.structuredContent?.queue_id ? null : 'no queue_id'
      },
    },
    {
      name: 'venice_video_status',
      args: { queue_id: '__placeholder__', model: 'veo3.1-fast-text-to-video' },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_video_complete',
      // Use placeholder queue_id; expected to error (job hasn't completed yet).
      // Test verifies the call reaches Venice with correct shape, not that it succeeds.
      args: { queue_id: '00000000-0000-0000-0000-000000000000', model: 'veo3.1-fast-text-to-video' },
      expectIn: { apikey: false, x402: false }, // expected to fail (invalid queue_id)
      validate: () => null,
    },
    {
      name: 'venice_video_transcriptions',
      args: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      validate: () => null,
    },

    // ============ AUDIO TTS / ASR ============
    {
      name: 'venice_tts',
      args: { input: 'Hello from Venice', voice: 'af_heart', model: 'tts-kokoro' },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_asr',
      // Use a stable, small WAV from W3 sample resources
      args: { audio_url: 'https://www.kozco.com/tech/piano2.wav' },
      validate: () => null, // any non-throwing result OK
    },
    {
      name: 'venice_voice_clone',
      args: { action: 'list' },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },

    // ============ MUSIC ============
    {
      name: 'venice_music_generate',
      args: { prompt: 'soft acoustic guitar, peaceful', model: 'elevenlabs-music', duration_seconds: 10 },
      validate: r => {
        if (r?.isError) return `error: ${String(r?.content?.[0]?.text).slice(0, 200)}`
        return r?.structuredContent?.queue_id ? null : 'no queue_id'
      },
    },
    {
      name: 'venice_music_status',
      args: { queue_id: '__placeholder__', model: 'elevenlabs-music' },
      validate: () => null,
    },
    {
      name: 'venice_music_complete',
      args: { queue_id: '00000000-0000-0000-0000-000000000000', model: 'elevenlabs-music' },
      expectIn: { apikey: false, x402: false }, // expected to fail (invalid queue_id)
      validate: () => null,
    },

    {
      name: 'venice_list_characters',
      args: { limit: 3 },
      expectIn: { apikey: true, x402: false }, // characters endpoint is API-key only
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_chat_with_character',
      args: {
        character_slug: 'venice',
        messages: [{ role: 'user', content: 'Say ok' }],
        max_tokens: 8,
      },
      // chat/completions itself supports x402, but the character_slug feature
      // requires the character lookup which is API-key only. Accept either path.
      validate: () => null,
    },

    // ============ x402 wallet helpers — SIWX-ONLY (will 402 on API key mode) ============
    {
      name: 'venice_x402_balance',
      args: { wallet_address: walletAddr },
      expectIn: { apikey: false, x402: true },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
    {
      name: 'venice_x402_top_up_info',
      args: { wallet_address: walletAddr },
      validate: () => null, // 402 expected (this is the no-payment-header response)
    },
    {
      name: 'venice_x402_transactions',
      args: { wallet_address: walletAddr, limit: 5 },
      expectIn: { apikey: false, x402: true },
      validate: r => (r?.isError ? `error: ${String(r?.content?.[0]?.text).slice(0, 200)}` : null),
    },
  ]
}

async function runMode(mode: 'apikey' | 'x402', walletAddr: string): Promise<ToolResult[]> {
  const env: Record<string, string> = {
    VENICE_TEST_BASE_URL: BASE_URL,
    VENICE_LOG_LEVEL: 'error',
  }
  if (mode === 'apikey') {
    if (!process.env.VENICE_API_KEY) throw new Error('VENICE_API_KEY not set')
    env.VENICE_API_KEY = process.env.VENICE_API_KEY
  } else {
    const wallet = loadOrCreateWallet()
    env.VENICE_SIWX_TOKEN = await buildSiwxHeader(wallet)
  }

  const mcp = spawnMcp(env)
  const results: ToolResult[] = []
  let videoQueueId: string | null = null
  let videoQueueModel: string | null = null
  let musicQueueId: string | null = null
  let musicQueueModel: string | null = null

  try {
    await mcp.initialize()
    const plan = buildPlan(walletAddr)

    for (const spec of plan) {
      // Stitch real queue_ids from queue calls into the status calls
      let args = { ...spec.args }
      if (spec.name === 'venice_video_status' && videoQueueId) {
        args = { queue_id: videoQueueId, model: videoQueueModel || 'veo-3.1-fast' }
      } else if (spec.name === 'venice_music_status' && musicQueueId) {
        args = { queue_id: musicQueueId, model: musicQueueModel || 'venice-music-1' }
      }

      const expectPass = spec.expectIn?.[mode] !== false

      if (spec.skipReason) {
        results.push({ name: spec.name, status: 'skip', detail: spec.skipReason, duration_ms: 0 })
        continue
      }

      const t0 = Date.now()
      let result: any
      try {
        result = await mcp.callTool(spec.name, args as Record<string, unknown>)
      } catch (err) {
        const t1 = Date.now()
        const detail = err instanceof Error ? err.message : String(err)
        results.push({
          name: spec.name,
          status: expectPass ? 'fail' : 'expected-fail',
          detail: `protocol error: ${detail.slice(0, 200)}`,
          duration_ms: t1 - t0,
        })
        continue
      }
      const t1 = Date.now()

      // Capture queue ids for follow-up tests
      if (spec.name === 'venice_video_generate' && result?.structuredContent?.queue_id) {
        videoQueueId = String(result.structuredContent.queue_id)
        videoQueueModel = String(result.structuredContent.model)
      }
      if (spec.name === 'venice_music_generate' && result?.structuredContent?.queue_id) {
        musicQueueId = String(result.structuredContent.queue_id)
        musicQueueModel = String(result.structuredContent.model)
      }

      const validateErr = spec.validate?.(result) ?? null
      const isError = result?.isError === true

      let status: Status
      let detail: string
      if (!expectPass) {
        // We expected this to fail (e.g. characters on x402)
        if (isError) {
          status = 'expected-fail'
          detail = `expected to fail in ${mode} mode (got: ${String(result?.content?.[0]?.text).slice(0, 80)})`
        } else {
          status = 'pass'
          detail = 'passed unexpectedly'
        }
      } else if (validateErr) {
        status = 'fail'
        detail = validateErr
      } else if (isError) {
        status = 'fail'
        detail = `tool returned isError: ${String(result?.content?.[0]?.text).slice(0, 200)}`
      } else {
        status = 'pass'
        const t = String(result?.content?.[0]?.text ?? '').slice(0, 80).replace(/\n/g, ' ')
        detail = t
      }

      results.push({ name: spec.name, status, detail, duration_ms: t1 - t0 })
      const c = color(status)
      console.log(
        `  ${c}${emoji(status)}${COLORS.reset} ${spec.name.padEnd(32)} ${COLORS.dim}${(t1 - t0).toString().padStart(5)}ms${COLORS.reset}  ${detail.slice(0, 100)}`,
      )
    }
  } finally {
    await mcp.close()
  }

  return results
}

function summary(mode: string, results: ToolResult[]) {
  const counts = { pass: 0, fail: 0, skip: 0, 'expected-fail': 0 } as Record<Status, number>
  for (const r of results) counts[r.status]++
  const total = results.length
  const ok = counts.pass + counts['expected-fail']
  console.log(
    `\n  ${mode.toUpperCase()} mode: ${COLORS.green}${counts.pass} pass${COLORS.reset}, ${COLORS.yellow}${counts['expected-fail']} expected-fail${COLORS.reset}, ${COLORS.red}${counts.fail} fail${COLORS.reset}, ${counts.skip} skip — ${ok}/${total} acceptable\n`,
  )
}

async function main() {
  const arg = process.argv[2] || 'both'
  const wallet = loadOrCreateWallet()
  console.log(`\n${COLORS.cyan}═══ Comprehensive MCP tool e2e — all 31 tools × auth modes ═══${COLORS.reset}`)
  console.log(`Venice base:   ${BASE_URL}`)
  console.log(`Test wallet:   ${wallet.address}\n`)

  const allResults: Record<string, ToolResult[]> = {}

  if (arg === 'apikey' || arg === 'both') {
    console.log(`${COLORS.cyan}── API Key mode ──${COLORS.reset}`)
    allResults.apikey = await runMode('apikey', wallet.address)
    summary('apikey', allResults.apikey)
  }

  if (arg === 'x402' || arg === 'both') {
    console.log(`${COLORS.cyan}── x402 wallet mode ──${COLORS.reset}`)
    allResults.x402 = await runMode('x402', wallet.address)
    summary('x402', allResults.x402)
  }

  // Side-by-side report
  if (arg === 'both') {
    console.log(`${COLORS.cyan}── Side-by-side ──${COLORS.reset}`)
    console.log(`${'tool'.padEnd(33)} apikey  x402`)
    const allTools = new Set([...allResults.apikey.map(r => r.name), ...allResults.x402.map(r => r.name)])
    const byMode: Record<string, Record<string, ToolResult>> = { apikey: {}, x402: {} }
    for (const r of allResults.apikey) byMode.apikey[r.name] = r
    for (const r of allResults.x402) byMode.x402[r.name] = r
    let bothPass = 0, apikeyOnly = 0, x402Only = 0, neither = 0
    for (const name of allTools) {
      const a = byMode.apikey[name]
      const x = byMode.x402[name]
      const aOk = a && (a.status === 'pass' || a.status === 'expected-fail')
      const xOk = x && (x.status === 'pass' || x.status === 'expected-fail')
      const ac = aOk ? COLORS.green + emoji(a.status) : COLORS.red + emoji(a.status)
      const xc = xOk ? COLORS.green + emoji(x.status) : COLORS.red + emoji(x.status)
      console.log(`${name.padEnd(33)}   ${ac}    ${xc}${COLORS.reset}`)
      if (aOk && xOk) bothPass++
      else if (aOk) apikeyOnly++
      else if (xOk) x402Only++
      else neither++
    }
    console.log(
      `\nTotals: ${COLORS.green}${bothPass} both${COLORS.reset}, ${COLORS.cyan}${apikeyOnly} apikey-only${COLORS.reset}, ${COLORS.cyan}${x402Only} x402-only${COLORS.reset}, ${COLORS.red}${neither} neither${COLORS.reset}\n`,
    )
  }

  // Write JSON report
  const fs = await import('node:fs')
  const path = await import('node:path')
  const outFile = path.resolve(process.cwd(), 'test/e2e/last-report.json')
  fs.writeFileSync(outFile, JSON.stringify(allResults, null, 2))
  console.log(`Full JSON report: ${outFile}`)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
