import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildTools, type ToolDef } from '../src/tools/index.js'
import { getSucceededWeb3Mint, resetWeb3MintAttemptStore } from '../src/tools/web3-key-mint.js'
import { loadConfig } from '../src/config.js'
import { VeniceClient } from '../src/venice-client.js'
import { VeniceUpstreamError } from '../src/types.js'
import { StubClient } from './helpers/stub-client.js'
import { startMockVenice } from './helpers/mock-venice-server.js'

const cfg = loadConfig({ VENICE_API_KEY: 'test-key' })
const mintCfg = loadConfig({ VENICE_API_KEY: 'test-key', VENICE_MCP_ENABLE_WEB3_MINT: '1' })

function setup(config = cfg) {
  const stub = new StubClient()
  const tools = buildTools(stub.asClient(), config)
  const get = (name: string): ToolDef => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`tool not found: ${name}`)
    return t
  }
  return { stub, tools, get }
}

describe('tools registry', () => {
  it('registers exactly the documented default set (39 tools)', () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    const expected = [
      'venice_asr',
      'venice_audio_quote',
      'venice_api_key_rate_limit_logs',
      'venice_api_key_rate_limits',
      'venice_billing_balance',
      'venice_billing_usage_analytics',
      'venice_billing_usage_history',
      'venice_chat',
      'venice_chat_with_character',
      'venice_crypto_rpc',
      'venice_embeddings',
      'venice_image_edit',
      'venice_image_generate',
      'venice_image_multi_edit',
      'venice_image_remove_bg',
      'venice_image_styles',
      'venice_image_upscale',
      'venice_get_api_key',
      'venice_list_api_keys',
      'venice_list_characters',
      'venice_list_models',
      'venice_music_complete',
      'venice_music_generate',
      'venice_music_status',
      'venice_responses',
      'venice_text_parser',
      'venice_tts',
      'venice_video_complete',
      'venice_video_generate',
      'venice_video_quote',
      'venice_video_status',
      'venice_video_transcriptions',
      'venice_voice_clone',
      'venice_web_scrape',
      'venice_web_search',
      'venice_web3_key_challenge',
      'venice_x402_balance',
      'venice_x402_top_up_info',
      'venice_x402_transactions',
    ].sort()
    assert.deepEqual(names, expected)
    assert.equal(tools.length, 39)
  })

  it('registers venice_web3_key_mint only when VENICE_MCP_ENABLE_WEB3_MINT=1', () => {
    const client = new StubClient().asClient()
    for (const value of [undefined, '0', 'true']) {
      const names = buildTools(client, loadConfig({ VENICE_MCP_ENABLE_WEB3_MINT: value })).map((t) => t.name)
      assert.equal(names.includes('venice_web3_key_mint'), false, `enabled by ${value}`)
    }
    const enabled = buildTools(client, mintCfg)
    assert.equal(enabled.length, 40)
    const mint = enabled.find((t) => t.name === 'venice_web3_key_mint')!
    assert.deepEqual(mint.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  it('every tool has a non-empty title and description', () => {
    const { tools } = setup()
    for (const t of tools) {
      assert.ok(t.title && t.title.length > 0, `title missing: ${t.name}`)
      assert.ok(t.description && t.description.length > 10, `description short: ${t.name}`)
    }
  })

  it('x402-eligible tools advertise wallet-auth support in their description', () => {
    const { get } = setup()
    const x402Tools = [
      'venice_chat',
      'venice_responses',
      'venice_embeddings',
      'venice_image_generate',
      'venice_image_edit',
      'venice_image_multi_edit',
      'venice_image_upscale',
      'venice_image_remove_bg',
      'venice_video_generate',
      'venice_video_status',
      'venice_video_complete',
      'venice_video_transcriptions',
      'venice_tts',
      'venice_asr',
      'venice_voice_clone',
      'venice_music_generate',
      'venice_music_status',
      'venice_music_complete',
      'venice_web_search',
      'venice_web_scrape',
      'venice_text_parser',
      'venice_crypto_rpc',
    ]
    for (const name of x402Tools) {
      const desc = get(name).description
      assert.match(desc, /x402/i, `${name} should mention x402 in description`)
    }
  })

  it('characters tools call out API-key-only requirement', () => {
    const { get } = setup()
    assert.match(get('venice_list_characters').description, /API key required/i)
    // chat_with_character notes the discovery limitation
    assert.match(get('venice_chat_with_character').description, /API[- ]key/i)
  })

  it('billing and operator API-key tools call out API-key-only requirements', () => {
    const { get } = setup()
    for (const name of [
      'venice_billing_balance',
      'venice_billing_usage_analytics',
      'venice_billing_usage_history',
      'venice_list_api_keys',
      'venice_get_api_key',
    ]) {
      assert.match(get(name).description, /ADMIN API key required/i, `${name} admin description`)
    }
    for (const name of ['venice_api_key_rate_limits', 'venice_api_key_rate_limit_logs']) {
      assert.match(get(name).description, /API key required/i, `${name} auth description`)
      assert.doesNotMatch(get(name).description, /ADMIN API key required/i, `${name} allows inference keys`)
    }
  })

  it('all API_KEY_ONLY discovery and read tools force explicit API-key auth', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['venice_list_characters', { limit: 3 }],
      ['venice_billing_balance', {}],
      ['venice_billing_usage_analytics', { lookback: '7d' }],
      ['venice_billing_usage_history', { page_size: 10 }],
      ['venice_list_api_keys', {}],
      ['venice_get_api_key', { id: 'key-1' }],
      ['venice_api_key_rate_limits', {}],
      ['venice_api_key_rate_limit_logs', {}],
    ]
    for (const [name, args] of cases) {
      const stub = new StubClient()
      const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === name)!
      await tool.handler(args as never)
      assert.equal(stub.calls.length, 1, `${name} request count`)
      assert.equal(stub.calls[0].auth, 'apiKey', `${name} auth mode`)
    }
  })
})

// ----------------------------------------------------------------------------
// Endpoint + method mapping per tool. Each row says: when invoked with these
// args, the tool must hit this exact path and method.
// ----------------------------------------------------------------------------

interface Mapping {
  tool: string
  args: Record<string, unknown>
  expectMethod: 'GET' | 'POST'
  expectPath: string
  /** Optional: assert specific request body fields. */
  expectBodyContains?: Record<string, unknown>
}

const MAPPINGS: Mapping[] = [
  // chat / text
  {
    tool: 'venice_chat',
    args: { messages: [{ role: 'user', content: 'hi' }] },
    expectMethod: 'POST',
    expectPath: '/v1/chat/completions',
    expectBodyContains: { stream: false },
  },
  {
    tool: 'venice_responses',
    args: { input: 'hello' },
    expectMethod: 'POST',
    expectPath: '/v1/responses',
  },
  {
    tool: 'venice_embeddings',
    args: {
      input: 'foo',
      model: 'text-embedding-bge-m3',
    },
    expectMethod: 'POST',
    expectPath: '/v1/embeddings',
    expectBodyContains: {
      model: 'text-embedding-bge-m3',
    },
  },
  // image
  {
    tool: 'venice_image_generate',
    args: { prompt: 'a cat' },
    expectMethod: 'POST',
    expectPath: '/v1/image/generate',
  },
  {
    tool: 'venice_image_edit',
    args: { image_url: 'https://x/img.png', prompt: 'add hat' },
    expectMethod: 'POST',
    expectPath: '/v1/image/edit',
    // Real endpoint returns binary; tool uses postBinary. Body uses `image` (not `image_url`).
    expectBodyContains: { image: 'https://x/img.png', prompt: 'add hat' },
  },
  {
    tool: 'venice_image_multi_edit',
    args: { image_urls: ['https://x/a.png', 'https://x/b.png'], prompt: 'merge' },
    expectMethod: 'POST',
    expectPath: '/v1/image/multi-edit',
    // Tool sends `images` (plural array), not `image_urls`.
    expectBodyContains: { images: ['https://x/a.png', 'https://x/b.png'] },
  },
  {
    tool: 'venice_image_upscale',
    // upscale uses multipart upload (fetches URL → uploads bytes)
    args: { image_url: 'https://93.184.216.34/image.png', scale: 4 },
    expectMethod: 'POST',
    expectPath: '/v1/image/upscale',
  },
  {
    tool: 'venice_image_remove_bg',
    args: { image_url: 'https://x/img.png' },
    expectMethod: 'POST',
    expectPath: '/v1/image/background-remove',
  },
  {
    tool: 'venice_image_styles',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/image/styles',
  },

  // video
  {
    tool: 'venice_video_generate',
    args: {
      prompt: 'a sunset',
      model: 'veo3.1-fast-text-to-video',
      duration: '8s',
    },
    expectMethod: 'POST',
    expectPath: '/v1/video/queue',
    expectBodyContains: {
      model: 'veo3.1-fast-text-to-video',
      duration: '8s',
    },
  },
  {
    tool: 'venice_video_status',
    args: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
    expectMethod: 'POST', // ← critical: NOT GET
    expectPath: '/v1/video/retrieve',
    expectBodyContains: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
  },
  {
    tool: 'venice_video_complete',
    args: { queue_id: 'vid-123', model: 'veo3.1-fast-text-to-video' },
    expectMethod: 'POST',
    expectPath: '/v1/video/complete',
  },
  {
    tool: 'venice_video_transcriptions',
    args: { url: 'https://www.youtube.com/watch?v=xxx' },
    expectMethod: 'POST',
    expectPath: '/v1/video/transcriptions',
  },
  {
    tool: 'venice_video_quote',
    args: { model: 'veo3.1-fast-text-to-video', duration: '8s' },
    // Real Venice endpoint is POST not GET
    expectMethod: 'POST',
    expectPath: '/v1/video/quote',
    expectBodyContains: { model: 'veo3.1-fast-text-to-video', duration: '8s' },
  },

  // audio (TTS / ASR / voices)
  {
    tool: 'venice_tts',
    args: { input: 'hello' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/speech',
    expectBodyContains: { input: 'hello' },
  },
  {
    tool: 'venice_asr',
    // ASR fetches audio_url and uploads multipart.
    args: { audio_url: 'https://93.184.216.34/audio.wav' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/transcriptions',
  },
  {
    tool: 'venice_voice_clone',
    args: { action: 'list' },
    // Action 'list' returns static catalog without hitting API
    expectMethod: 'GET',
    expectPath: '__no_api_call__',
  },

  // music (audio/queue + audio/retrieve + audio/complete)
  {
    tool: 'venice_music_generate',
    args: { prompt: 'jazz' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/queue',
  },
  {
    tool: 'venice_music_status',
    args: { queue_id: 'mus-123', model: 'venice-music-1' },
    expectMethod: 'POST', // ← critical
    expectPath: '/v1/audio/retrieve',
    expectBodyContains: { queue_id: 'mus-123', model: 'venice-music-1' },
  },
  {
    tool: 'venice_music_complete',
    args: { queue_id: 'mus-123', model: 'venice-music-1' },
    expectMethod: 'POST',
    expectPath: '/v1/audio/complete',
  },
  {
    tool: 'venice_audio_quote',
    args: { model: 'elevenlabs-music', duration_seconds: 60 },
    // Real Venice endpoint is POST not GET
    expectMethod: 'POST',
    expectPath: '/v1/audio/quote',
    expectBodyContains: { model: 'elevenlabs-music', duration_seconds: 60 },
  },

  // augment
  {
    tool: 'venice_web_search',
    args: { query: 'venice ai' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/search',
  },
  {
    tool: 'venice_web_scrape',
    args: { url: 'https://example.com' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/scrape',
  },
  {
    tool: 'venice_text_parser',
    // text_parser fetches the URL and uploads as multipart.
    args: { url: 'https://93.184.216.34/document.pdf' },
    expectMethod: 'POST',
    expectPath: '/v1/augment/text-parser',
  },

  // crypto rpc
  {
    tool: 'venice_crypto_rpc',
    args: { network: 'base', rpc_method: 'eth_blockNumber' },
    expectMethod: 'POST',
    expectPath: '/v1/crypto/rpc/base',
    expectBodyContains: { jsonrpc: '2.0', method: 'eth_blockNumber' },
  },

  // catalog
  { tool: 'venice_list_models', args: {}, expectMethod: 'GET', expectPath: '/v1/models' },

  // characters
  { tool: 'venice_list_characters', args: {}, expectMethod: 'GET', expectPath: '/v1/characters' },
  {
    tool: 'venice_chat_with_character',
    args: { character_slug: 'alice', messages: [{ role: 'user', content: 'hi' }] },
    expectMethod: 'POST',
    expectPath: '/v1/chat/completions',
    // character_slug now wraps inside venice_parameters (Venice schema requirement)
    expectBodyContains: { venice_parameters: { character_slug: 'alice' } },
  },

  // billing
  { tool: 'venice_billing_balance', args: {}, expectMethod: 'GET', expectPath: '/v1/billing/balance' },
  {
    tool: 'venice_billing_usage_analytics',
    args: { start_date: '2026-08-01', end_date: '2026-08-10' },
    expectMethod: 'GET',
    expectPath: '/v1/billing/usage-analytics?startDate=2026-08-01&endDate=2026-08-10',
  },
  {
    tool: 'venice_billing_usage_history',
    args: {
      currency: 'DIEM',
      start_timestamp: '2026-08-01T00:00:00.000Z',
      page_size: 100,
    },
    expectMethod: 'GET',
    expectPath: '/v1/billing/usage-history?currency=DIEM&startTimestamp=2026-08-01T00%3A00%3A00.000Z&pageSize=100',
  },

  // API keys
  { tool: 'venice_list_api_keys', args: {}, expectMethod: 'GET', expectPath: '/v1/api_keys' },
  {
    tool: 'venice_get_api_key',
    args: { id: 'key/id' },
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/key%2Fid',
  },
  {
    tool: 'venice_api_key_rate_limits',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/rate_limits',
  },
  {
    tool: 'venice_api_key_rate_limit_logs',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/rate_limits/log',
  },
  {
    tool: 'venice_web3_key_challenge',
    args: {},
    expectMethod: 'GET',
    expectPath: '/v1/api_keys/generate_web3_key',
  },
  {
    tool: 'venice_web3_key_mint',
    args: {
      address: `0x${'a'.repeat(40)}`,
      signature: '0xsigned',
      token: 'challenge',
      api_key_type: 'INFERENCE',
      consumption_limit: { usd: 50, diem: 10 },
      limit_period: 'MONTH',
    },
    expectMethod: 'POST',
    expectPath: '/v1/api_keys/generate_web3_key',
    expectBodyContains: {
      apiKeyType: 'INFERENCE',
      consumptionLimit: { usd: 50, diem: 10 },
      limitPeriod: 'MONTH',
    },
  },

  // x402 helpers
  {
    tool: 'venice_x402_balance',
    args: { wallet_address: '0x' + 'a'.repeat(40) },
    expectMethod: 'GET',
    expectPath: `/v1/x402/balance/0x${'a'.repeat(40)}`,
  },
  {
    tool: 'venice_x402_top_up_info',
    args: {},
    expectMethod: 'POST',
    expectPath: '/v1/x402/top-up',
    expectBodyContains: {},
  },
  {
    tool: 'venice_x402_transactions',
    args: { wallet_address: '0x' + 'b'.repeat(40), limit: 5 },
    expectMethod: 'GET',
    expectPath: `/v1/x402/transactions/0x${'b'.repeat(40)}?limit=5`,
  },
]

describe('tools endpoint + method mapping', () => {
  for (const m of MAPPINGS) {
    it(`${m.tool} → ${m.expectMethod} ${m.expectPath}`, async () => {
      const stub = new StubClient()
      const tools = buildTools(stub.asClient(), mintCfg)
      const t = tools.find((x) => x.name === m.tool)
      if (!t) throw new Error(`tool missing: ${m.tool}`)
      const originalFetch = globalThis.fetch
      const uploadContentTypes: Record<string, string> = {
        venice_image_upscale: 'image/png',
        venice_asr: 'audio/wav',
        venice_text_parser: 'application/pdf',
      }
      resetWeb3MintAttemptStore()
      try {
        if (uploadContentTypes[m.tool]) {
          globalThis.fetch = (async () =>
            new Response('mock upload bytes', {
              status: 200,
              headers: { 'content-type': uploadContentTypes[m.tool] },
            })) as typeof fetch
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await t.handler(m.args as any)
      } finally {
        globalThis.fetch = originalFetch
      }
      // Some tools (e.g. voice_clone action=list, returns static catalog) make no API call.
      if (m.expectPath === '__no_api_call__') {
        assert.equal(stub.calls.length, 0, `${m.tool} should not hit the API for this args`)
        return
      }
      assert.ok(stub.calls.length >= 1, `${m.tool} should hit the API at least once (got ${stub.calls.length})`)
      // Find the matching call (some tools fetch a remote URL first then call Venice)
      const call = stub.calls.find((c) => c.path === m.expectPath) || stub.calls[stub.calls.length - 1]
      assert.equal(call.method, m.expectMethod, `${m.tool} method`)
      assert.equal(call.path, m.expectPath, `${m.tool} path`)
      if (m.expectBodyContains) {
        const body = call.body as Record<string, unknown>
        for (const [k, v] of Object.entries(m.expectBodyContains)) {
          assert.deepEqual(body[k], v, `${m.tool} body.${k}`)
        }
      }
    })
  }
})

describe('billing input validation and output size', () => {
  it('rejects impossible calendar dates and timestamps', () => {
    const { get } = setup()
    const analytics = z.object(get('venice_billing_usage_analytics').inputSchema)
    for (const date of ['2026-13-45', '2026-02-30', '2026-00-10', '2025-02-29']) {
      assert.equal(analytics.safeParse({ start_date: date, end_date: '2026-12-31' }).success, false, date)
    }
    assert.equal(analytics.safeParse({ start_date: '2028-02-29', end_date: '2028-03-01' }).success, true)

    const history = z.object(get('venice_billing_usage_history').inputSchema)
    for (const ts of ['2026-02-30T00:00:00Z', '2026-01-01T25:00:00Z', '2026-13-01T00:00:00Z']) {
      assert.equal(history.safeParse({ start_timestamp: ts }).success, false, ts)
    }
  })

  it('rejects an analytics start_date later than end_date', async () => {
    const { get, stub } = setup()
    const analytics = get('venice_billing_usage_analytics')
    const reversed = await analytics.handler({ start_date: '2026-08-02', end_date: '2026-08-01' } as never)
    assert.equal(reversed.isError, true)
    assert.match((reversed.content[0] as { text: string }).text, /start_date cannot be later than end_date/)
    assert.equal(stub.calls.length, 0)
    const sameDay = await analytics.handler({ start_date: '2026-08-01', end_date: '2026-08-01' } as never)
    assert.equal(sameDay.isError, undefined)
  })

  it('caps plain cursors at 512 characters and allows the csv: prefix on top', () => {
    const { get } = setup()
    const schema = z.object(get('venice_billing_usage_history').inputSchema)
    assert.equal(schema.safeParse({ cursor: 'a'.repeat(512) }).success, true)
    assert.equal(schema.safeParse({ cursor: 'a'.repeat(513) }).success, false)
    assert.equal(schema.safeParse({ cursor: 'a'.repeat(516) }).success, false)
    assert.equal(schema.safeParse({ cursor: `csv:${'a'.repeat(512)}` }).success, true)
    assert.equal(schema.safeParse({ cursor: `csv:${'a'.repeat(513)}` }).success, false)
    assert.equal(schema.safeParse({ cursor: 'csv:' }).success, false)
    assert.equal(schema.safeParse({ cursor: '' }).success, false)
  })

  it('truncates oversized usage-history pages and flags them', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ timestamp: `2026-08-01T00:00:${i}Z`, amount: -0.1, sku: 'x'.repeat(40) }))
    const jsonStub = new StubClient({ '/v1/billing/usage-history': () => ({ data: rows, nextCursor: 'next' }) })
    const jsonTool = buildTools(jsonStub.asClient(), cfg).find((t) => t.name === 'venice_billing_usage_history')!
    const json = await jsonTool.handler({ page_size: 1000 } as never)
    const jsonText = (json.content[0] as { text: string }).text
    assert.ok(jsonText.length < 8500, `json text length ${jsonText.length}`)
    assert.match(jsonText, /truncated/)
    assert.match(jsonText, /smaller page_size/)
    assert.deepEqual(json.structuredContent, { format: 'json', count: 1000, nextCursor: 'next', truncated: true })

    const csvBody = `timestamp,amount\n${rows.map((r) => `${r.timestamp},${r.amount}`).join('\n')}`.repeat(2)
    const csvStub = new StubClient({ '/v1/billing/usage-history': () => csvBody })
    const csvTool = buildTools(csvStub.asClient(), cfg).find((t) => t.name === 'venice_billing_usage_history')!
    const csv = await csvTool.handler({ format: 'csv', page_size: 1000 } as never)
    const csvText = (csv.content[0] as { text: string }).text
    assert.ok(csvText.length < 8500, `csv text length ${csvText.length}`)
    assert.equal(csv.structuredContent?.truncated, true)

    const smallStub = new StubClient({ '/v1/billing/usage-history': () => 'timestamp,amount\n1,2' })
    const smallTool = buildTools(smallStub.asClient(), cfg).find((t) => t.name === 'venice_billing_usage_history')!
    const untruncated = await smallTool.handler({ format: 'csv' } as never)
    assert.equal(untruncated.structuredContent?.truncated, false)
    assert.equal((untruncated.content[0] as { text: string }).text, 'timestamp,amount\n1,2')
  })
})

describe('tool output shaping', () => {
  it('venice_image_generate returns base64 image content + structuredContent.id', async () => {
    const { get } = setup()
    const r = await get('venice_image_generate').handler({ prompt: 'a cat' } as never)
    assert.equal(r.isError, undefined)
    // Default Venice response is { id, images: [base64] } → tool returns image content
    const img = r.content.find((c) => c.type === 'image') as { type: string; data: string } | undefined
    assert.ok(img, 'expected image content')
    assert.ok(img.data.length > 0, 'base64 data should be non-empty')
    assert.equal((r.structuredContent as { id: string }).id, 'stub-img-id')
  })

  it('venice_video_status returns COMPLETED + URL when ready', async () => {
    const { get } = setup()
    const r = await get('venice_video_status').handler({ queue_id: 'x', model: 'm' } as never)
    assert.equal((r.structuredContent as { status: string }).status, 'COMPLETED')
    assert.equal((r.structuredContent as { url: string }).url, 'https://stub/v.mp4')
  })

  it('venice_video_status returns PROCESSING progress when not ready', async () => {
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({ status: 'PROCESSING', average_execution_time: 60_000, execution_duration: 12_000 }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({
      queue_id: 'x',
      model: 'm',
    } as never)
    assert.equal((r.structuredContent as { status: string }).status, 'PROCESSING')
    assert.match((r.content[0] as { text: string }).text, /PROCESSING/)
  })

  it('venice_chat surfaces error string when API throws 402', async () => {
    const stub = new StubClient({
      '/v1/chat/completions': async () => {
        const { VeniceUpstreamError } = await import('../src/types.js')
        throw new VeniceUpstreamError({
          message: 'pay',
          status: 402,
          body: { reason: 'insufficient_balance', currentBalanceUsd: 0, minimumBalanceUsd: 0.1 },
        })
      },
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_chat')!.handler({
      messages: [{ role: 'user', content: 'hi' }],
    } as never)
    assert.equal(r.isError, true)
    assert.match((r.content[0] as { text: string }).text, /402 Payment Required/)
  })

  it('venice_list_models filters by capability type', async () => {
    const { get } = setup()
    const r = await get('venice_list_models').handler({ type: 'image' } as never)
    assert.equal((r.structuredContent as { count: number; total: number }).total, 3)
    assert.equal((r.structuredContent as { count: number }).count, 1)
  })

  it('x402 wallet helper tools request SIWX auth override', async () => {
    const stub = new StubClient()
    const tools = buildTools(stub.asClient(), cfg)

    await tools.find((t) => t.name === 'venice_x402_balance')!.handler({
      wallet_address: `0x${'a'.repeat(40)}`,
    } as never)
    assert.equal(stub.calls.at(-1)?.auth, 'siwx')

    await tools.find((t) => t.name === 'venice_x402_transactions')!.handler({
      wallet_address: `0x${'b'.repeat(40)}`,
      limit: 5,
    } as never)
    assert.equal(stub.calls.at(-1)?.auth, 'siwx')
  })

  it('accepts EVM and Solana addresses on all x402 helpers and preserves Solana case', async () => {
    const { get } = setup()
    const evm = `0x${'A'.repeat(40)}`
    const solana = 'So11111111111111111111111111111111111111112'
    for (const name of ['venice_x402_balance', 'venice_x402_transactions']) {
      const schema = z.object(get(name).inputSchema)
      assert.equal(schema.safeParse({ wallet_address: evm }).success, true, `${name} EVM`)
      assert.equal(schema.safeParse({ wallet_address: solana }).success, true, `${name} Solana`)
      assert.equal(schema.safeParse({ wallet_address: 'not-a-wallet' }).success, false, `${name} invalid`)
    }

    const stub = new StubClient()
    const tool = buildTools(stub.asClient(), cfg).find((t) => t.name === 'venice_x402_balance')!
    await tool.handler({ wallet_address: solana } as never)
    assert.equal(stub.calls.at(-1)?.path, `/v1/x402/balance/${solana}`)
  })

  it('uses cursor-only continuation and exposes JSON and CSV next cursors', async () => {
    const { get, stub } = setup()
    const history = get('venice_billing_usage_history')

    const invalid = await history.handler({ cursor: 'cursor_1', currency: 'USD' } as never)
    assert.equal(invalid.isError, true)
    assert.equal(stub.calls.length, 0)

    const json = await history.handler({ cursor: 'cursor_1' } as never)
    assert.equal(stub.calls.at(-1)?.path, '/v1/billing/usage-history?cursor=cursor_1')
    assert.equal(json.structuredContent?.nextCursor, 'stub-next-cursor')

    const csvStub = new StubClient({
      '/v1/billing/usage-history': () => 'timestamp,amount\n2026-08-01T00:00:00.000Z,-0.1',
    })
    const csvTool = buildTools(csvStub.asClient(), cfg).find(
      (tool) => tool.name === 'venice_billing_usage_history',
    )!
    const csv = await csvTool.handler({ format: 'csv', page_size: 50 } as never)
    assert.equal(csvStub.calls.at(-1)?.headers?.Accept, 'text/csv')
    assert.equal(csv.structuredContent?.nextCursor, 'csv:stub-next-cursor')
    assert.match((csv.content[0] as { text: string }).text, /timestamp,amount/)

    const continued = await csvTool.handler({ cursor: csv.structuredContent?.nextCursor as string } as never)
    assert.equal(csvStub.calls.at(-1)?.headers?.Accept, 'text/csv')
    assert.equal(csvStub.calls.at(-1)?.path, '/v1/billing/usage-history?cursor=stub-next-cursor')
    assert.equal(continued.structuredContent?.format, 'csv')
  })

  it('validates analytics filter combinations before making a request', async () => {
    const { get, stub } = setup()
    const analytics = get('venice_billing_usage_analytics')
    assert.equal(
      (await analytics.handler({ lookback: '7d', start_date: '2026-08-01', end_date: '2026-08-02' } as never)).isError,
      true,
    )
    assert.equal((await analytics.handler({ lookback: '91d' } as never)).isError, true)
    assert.equal((await analytics.handler({ start_date: '2026-08-01' } as never)).isError, true)
    assert.equal(stub.calls.length, 0)
  })

  it('uses unauthenticated Web3 challenge/mint calls without accepting a private-key field', async () => {
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) =>
        method === 'POST'
          ? { success: true, data: { apiKey: 'vk_new_secret', apiKeyType: 'INFERENCE', id: 'key-1' } }
          : { success: true, data: { token: 'challenge-token' } },
    })
    const tools = buildTools(stub.asClient(), mintCfg)
    const challenge = tools.find((tool) => tool.name === 'venice_web3_key_challenge')!
    const mint = tools.find((tool) => tool.name === 'venice_web3_key_mint')!
    assert.equal('private_key' in mint.inputSchema, false)
    assert.equal('privateKey' in mint.inputSchema, false)

    await challenge.handler({} as never)
    assert.equal(stub.calls.at(-1)?.auth, 'none')

    resetWeb3MintAttemptStore()
    const result = await mint.handler({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(stub.calls.at(-1)?.auth, 'none')
    assert.equal((stub.calls.at(-1)?.body as { apiKeyType?: string }).apiKeyType, 'INFERENCE')
    assert.equal((stub.calls.at(-1)?.body as { limitPeriod?: string }).limitPeriod, 'LIFETIME')
    assert.match((result.content[0] as { text: string }).text, /vk_new_secret/)
    assert.equal(result.structuredContent, undefined)

    const schema = z.object(mint.inputSchema)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      api_key_type: 'ADMIN',
      consumption_limit: { usd: 25 },
    }).success, false)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
    }).success, false)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      consumption_limit: { usd: 0, diem: null },
    }).success, false)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      description: 'x'.repeat(64),
      consumption_limit: { usd: 25 },
    }).success, true)
    assert.equal(schema.safeParse({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
      description: 'x'.repeat(65),
      consumption_limit: { usd: 25 },
    }).success, false)
  })

  it('rejects retired VCU consumption limits and requires a positive usd cap within the ceiling', () => {
    const { get } = setup(mintCfg)
    const mint = get('venice_web3_key_mint')
    const schema = z.object(mint.inputSchema)
    const base = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'challenge-token',
    }
    const messagesOf = (result: ReturnType<typeof schema.safeParse>): string =>
      result.success ? '' : result.error.issues.map((issue) => issue.message).join(' | ')

    const vcuOnly = schema.safeParse({ ...base, consumption_limit: { vcu: 1 } })
    assert.equal(vcuOnly.success, false)
    assert.match(messagesOf(vcuOnly), /VCU consumption limits are retired/)

    // A vcu value is rejected even when it rides along with a valid usd cap,
    // so the caller never believes a retired currency was accepted.
    const vcuWithUsd = schema.safeParse({ ...base, consumption_limit: { usd: 25, vcu: 1 } })
    assert.equal(vcuWithUsd.success, false)
    assert.match(messagesOf(vcuWithUsd), /VCU consumption limits are retired/)

    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 25 } }).success, true)
    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 50, diem: 50 } }).success, true)
    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 25, diem: null } }).success, true)

    for (const uncappedUsd of [{ diem: 10 }, { usd: null, diem: 10 }, { usd: 0, diem: null }]) {
      const result = schema.safeParse({ ...base, consumption_limit: uncappedUsd })
      assert.equal(result.success, false, JSON.stringify(uncappedUsd))
      assert.match(messagesOf(result), /A positive usd consumption limit is required/)
    }
    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 25, diem: 0 } }).success, false)

    const overUsd = schema.safeParse({ ...base, consumption_limit: { usd: 50.01 } })
    assert.equal(overUsd.success, false)
    assert.match(messagesOf(overUsd), /VENICE_MCP_MAX_MINT_USD/)
    const overDiem = schema.safeParse({ ...base, consumption_limit: { usd: 25, diem: 51 } })
    assert.equal(overDiem.success, false)
    assert.match(messagesOf(overDiem), /VENICE_MCP_MAX_MINT_DIEM/)

    assert.match(mint.description, /positive usd consumption_limit of at most 50 is always required/)
    assert.match(mint.description, /VCU limits are rejected/)
  })

  it('applies configured mint ceilings to the schema', () => {
    const raised = loadConfig({
      VENICE_MCP_ENABLE_WEB3_MINT: '1',
      VENICE_MCP_MAX_MINT_USD: '200',
      VENICE_MCP_MAX_MINT_DIEM: '5',
    })
    const mint = buildTools(new StubClient().asClient(), raised).find((t) => t.name === 'venice_web3_key_mint')!
    const schema = z.object(mint.inputSchema)
    const base = { address: `0x${'a'.repeat(40)}`, signature: 'signed-value', token: 'challenge-token' }
    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 200 } }).success, true)
    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 201 } }).success, false)
    assert.equal(schema.safeParse({ ...base, consumption_limit: { usd: 25, diem: 6 } }).success, false)
  })

  it('withholds the secret when the minted key does not match the requested restrictions', async () => {
    const mismatches = [
      { apiKeyType: 'ADMIN', consumptionLimit: { usd: 25, diem: null }, limitPeriod: 'LIFETIME' },
      { apiKeyType: 'INFERENCE', consumptionLimit: { usd: null, diem: null }, limitPeriod: 'LIFETIME' },
      { apiKeyType: 'INFERENCE', consumptionLimit: { usd: 25, diem: 3 }, limitPeriod: 'LIFETIME' },
      { apiKeyType: 'INFERENCE', consumptionLimit: { usd: 25, diem: null }, limitPeriod: 'EPOCH' },
      { consumptionLimit: { usd: 25 }, limitPeriod: 'LIFETIME' },
    ]
    for (const [index, fields] of mismatches.entries()) {
      resetWeb3MintAttemptStore()
      let posts = 0
      const stub = new StubClient({
        '/v1/api_keys/generate_web3_key': () => {
          posts += 1
          return { success: true, data: { apiKey: 'vk_wrong_key_secret', id: `key-wrong-${index}`, ...fields } }
        },
      })
      const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
      const args = {
        address: `0x${'a'.repeat(40)}`,
        signature: 'signed-value',
        token: `mismatch-token-${index}`,
        consumption_limit: { usd: 25 },
      } as never

      const result = await mint.handler(args)
      const text = (result.content[0] as { text: string }).text
      assert.equal(result.isError, true, JSON.stringify(fields))
      assert.doesNotMatch(text, /vk_wrong_key_secret/)
      assert.match(text, new RegExp(`key-wrong-${index}`))
      assert.match(text, /Revoke/)

      const retry = await mint.handler(args)
      assert.equal(retry.isError, true)
      assert.doesNotMatch((retry.content[0] as { text: string }).text, /vk_wrong_key_secret/)
      assert.equal(posts, 1)
    }
  })

  it('accepts a minted key whose returned restrictions match the request', async () => {
    resetWeb3MintAttemptStore()
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': () => ({
        success: true,
        data: {
          apiKey: 'vk_matching_secret',
          apiKeyType: 'INFERENCE',
          id: 'key-match',
          consumptionLimit: { usd: 25, diem: 10, vcu: null },
          limitPeriod: 'MONTH',
        },
      }),
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const result = await mint.handler({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'matching-token',
      consumption_limit: { usd: 25, diem: 10 },
      limit_period: 'MONTH',
    } as never)
    assert.equal(result.isError, undefined)
    assert.match((result.content[0] as { text: string }).text, /vk_matching_secret/)
  })

  it('marks a mint that never settles as an unknown outcome instead of unlocking it', async (t) => {
    resetWeb3MintAttemptStore()
    t.mock.timers.enable({ apis: ['Date'], now: 0 })
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': () => {
        posts += 1
        return new Promise(() => {})
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const address = `0x${'a'.repeat(40)}`
    void mint.handler({ address, signature: 'signed-value', token: 'hung-token', consumption_limit: { usd: 25 } } as never)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(posts, 1)

    t.mock.timers.setTime(16 * 60 * 1000)
    const retry = await mint.handler({
      address,
      signature: 'signed-value',
      token: 'hung-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(retry.isError, true)
    assert.match((retry.content[0] as { text: string }).text, /Mint outcome is unknown/)
    const fresh = await mint.handler({
      address,
      signature: 'signed-value',
      token: 'new-challenge-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(fresh.isError, true)
    assert.match((fresh.content[0] as { text: string }).text, /new challenge will not mint/)
    assert.equal(posts, 1)
  })

  it('replays a successful web3 mint for the same challenge token without creating another key', async () => {
    resetWeb3MintAttemptStore()
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) =>
        method === 'POST' ? { success: true, data: { apiKey: 'vk_replay_secret', apiKeyType: 'INFERENCE', id: 'key-replay' } } : {},
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'replay-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 1)
    assert.match((first.content[0] as { text: string }).text, /vk_replay_secret/)
    assert.match((second.content[0] as { text: string }).text, /vk_replay_secret/)

    const otherSigner = await mint.handler({
      ...args,
      address: `0x${'b'.repeat(40)}`,
    } as never)
    assert.equal(otherSigner.isError, true)
    assert.match((otherSigner.content[0] as { text: string }).text, /different wallet or signature/)
    assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 1)
  })

  it('refuses to retry a web3 mint after an unknown outcome', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'timeout',
          status: 504,
          body: { error: 'timeout' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'unknown-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((first.content[0] as { text: string }).text, /Mint outcome is unknown/)
    assert.match((second.content[0] as { text: string }).text, /Do not retry/)
    assert.match((second.content[0] as { text: string }).text, /venice_list_api_keys/)
  })

  it('refuses to retry a web3 mint after a 429', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'rate limited',
          status: 429,
          body: { error: 'rate limited' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'rate-limited-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((second.content[0] as { text: string }).text, /Do not retry/)
  })

  it('refuses a new challenge token for a wallet with an unknown mint outcome', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'timeout',
          status: 504,
          body: { error: 'timeout' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const address = `0x${'a'.repeat(40)}`
    const first = await mint.handler({
      address,
      signature: 'signed-value',
      token: 'lost-token',
      consumption_limit: { usd: 25 },
    } as never)
    const second = await mint.handler({
      address,
      signature: 'signed-value',
      token: 'fresh-challenge-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((second.content[0] as { text: string }).text, /new challenge will not mint/)
  })

  it('refuses a re-cased wallet address after an unknown mint outcome', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        throw new VeniceUpstreamError({
          message: 'timeout',
          status: 504,
          body: { error: 'timeout' },
        })
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const first = await mint.handler({
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'lost-token',
      consumption_limit: { usd: 25 },
    } as never)
    const second = await mint.handler({
      address: `0x${'A'.repeat(40)}`,
      signature: 'signed-value',
      token: 'fresh-challenge-token',
      consumption_limit: { usd: 25 },
    } as never)
    assert.equal(first.isError, true)
    assert.equal(second.isError, true)
    assert.equal(posts, 1)
    assert.match((second.content[0] as { text: string }).text, /new challenge will not mint/)
  })

  it('allows a corrected web3 mint after a definitive 4xx', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        if (posts === 1) {
          throw new VeniceUpstreamError({
            message: 'bad token',
            status: 400,
            body: { error: 'invalid token' },
          })
        }
        return { success: true, data: { apiKey: 'vk_after_400', apiKeyType: 'INFERENCE', id: 'key-400' } }
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const args = {
      address: `0x${'a'.repeat(40)}`,
      signature: 'signed-value',
      token: 'retryable-token',
      consumption_limit: { usd: 25 },
      expires_at: '2026-08-01T12:00:00.123456Z',
    } as never

    const first = await mint.handler(args)
    const second = await mint.handler(args)
    assert.equal(first.isError, true)
    assert.equal(second.isError, undefined)
    assert.equal(posts, 2)
    assert.equal((stub.calls.at(-1)?.body as { expiresAt?: string }).expiresAt, '2026-08-01T12:00:00.123Z')
    assert.match((second.content[0] as { text: string }).text, /vk_after_400/)
  })

  it('treats a mint response without a readable API key as an unknown outcome', async () => {
    resetWeb3MintAttemptStore()
    let posts = 0
    const stub = new StubClient({
      '/v1/api_keys/generate_web3_key': ({ method }) => {
        if (method !== 'POST') return {}
        posts += 1
        return { success: true, data: {} }
      },
    })
    const mint = buildTools(stub.asClient(), mintCfg).find((tool) => tool.name === 'venice_web3_key_mint')!
    const address = `0x${'a'.repeat(40)}`
    const args = {
      address,
      signature: 'signed-value',
      token: 'empty-envelope-token',
      consumption_limit: { usd: 25 },
    } as never

    const first = await mint.handler(args)
    const firstText = (first.content[0] as { text: string }).text
    assert.equal(first.isError, true)
    assert.match(firstText, /Mint outcome is unknown/)
    assert.match(firstText, /no readable API key/)
    assert.doesNotMatch(firstText, /Store the newly minted API key/)
    assert.equal(getSucceededWeb3Mint('empty-envelope-token', address, 'signed-value'), undefined)

    // The wallet is not released for another mint: the key may exist upstream.
    const retry = await mint.handler(args)
    assert.equal(retry.isError, true)
    assert.equal(posts, 1)
  })

  it('enters the unknown-outcome path when the HTTP client reads a truncated mint response', async () => {
    resetWeb3MintAttemptStore()
    const server = await startMockVenice([
      {
        match: 'GET /v1/api_keys/generate_web3_key',
        reply: { success: true, data: { token: 'fresh-challenge-token' } },
      },
      {
        match: 'POST /v1/api_keys/generate_web3_key',
        reply: {
          __status: 200,
          __headers: { 'content-type': 'application/json' },
          // Truncated JSON: the shared client parses this into {}.
          __rawBody: '{"success":true,"data":{"apiKey":"vk_truncated',
        },
      },
    ])
    try {
      const httpCfg = { ...loadConfig({ VENICE_MCP_ENABLE_WEB3_MINT: '1' }), baseUrl: server.url }
      const tools = buildTools(new VeniceClient(httpCfg), httpCfg)
      const mint = tools.find((tool) => tool.name === 'venice_web3_key_mint')!
      const challenge = tools.find((tool) => tool.name === 'venice_web3_key_challenge')!
      const address = `0x${'c'.repeat(40)}`
      const mintPosts = () => server.calls.filter((call) => call.method === 'POST').length

      const first = await mint.handler({
        address,
        signature: 'signed-value',
        token: 'truncated-token',
        consumption_limit: { usd: 25 },
      } as never)
      const firstText = (first.content[0] as { text: string }).text
      assert.equal(first.isError, true)
      assert.match(firstText, /Mint outcome is unknown/)
      assert.match(firstText, /no readable API key/)
      assert.doesNotMatch(firstText, /Store the newly minted API key/)
      assert.doesNotMatch(firstText, /\{\}/)
      assert.equal(getSucceededWeb3Mint('truncated-token', address, 'signed-value'), undefined)
      assert.equal(mintPosts(), 1)

      const retry = await mint.handler({
        address,
        signature: 'signed-value',
        token: 'truncated-token',
        consumption_limit: { usd: 25 },
      } as never)
      assert.equal(retry.isError, true)
      assert.doesNotMatch((retry.content[0] as { text: string }).text, /Store the newly minted API key/)
      assert.equal(mintPosts(), 1)

      // A new challenge for the same wallet must not issue another mint POST.
      const fresh = await challenge.handler({} as never)
      assert.equal(fresh.isError, undefined)
      const afterNewChallenge = await mint.handler({
        address,
        signature: 'signed-value',
        token: 'fresh-challenge-token',
        consumption_limit: { usd: 25 },
      } as never)
      assert.equal(afterNewChallenge.isError, true)
      assert.match((afterNewChallenge.content[0] as { text: string }).text, /new challenge will not mint/)
      assert.equal(mintPosts(), 1)
    } finally {
      await server.close()
    }
  })

  it('accepts high-precision RFC3339 timestamps on usage-history filters', async () => {
    const { get, stub } = setup()
    const history = get('venice_billing_usage_history')
    const schema = z.object(history.inputSchema)
    assert.equal(schema.safeParse({ start_timestamp: '2026-08-01T00:00:00.123456Z' }).success, true)
    assert.equal(schema.safeParse({ start_timestamp: '2026-08-01T00:00:00.1Z' }).success, true)
    assert.equal(schema.safeParse({ start_timestamp: '2026-08-01T00:00:00.123456789Z' }).success, true)

    const result = await history.handler({
      start_timestamp: '2026-08-01T00:00:00.123456Z',
      end_timestamp: '2026-08-02T00:00:00.1Z',
    } as never)
    assert.equal(result.isError, undefined)
    assert.equal(
      stub.calls.at(-1)?.path,
      '/v1/billing/usage-history?startTimestamp=2026-08-01T00%3A00%3A00.123456Z&endTimestamp=2026-08-02T00%3A00%3A00.1Z',
    )
  })

  it('redacts unexpected secret fields from operator API-key reads', async () => {
    const secret = 'vk_should_not_escape'
    const stub = new StubClient({
      '/v1/api_keys': () => ({
        object: 'list',
        data: [{ id: 'key-1', last6Chars: 'escape', apiKey: secret, token: 'token-secret' }],
      }),
    })
    const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === 'venice_list_api_keys')!
    const result = await tool.handler({} as never)
    const text = (result.content[0] as { text: string }).text
    assert.doesNotMatch(text, new RegExp(secret))
    assert.doesNotMatch(text, /token-secret/)
    assert.match(text, /\[REDACTED\]/)
  })

  it('venice_asr reports timeout when fetching audio_url stalls', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = ((_: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const rejectAbort = () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          }
          if (init?.signal?.aborted) rejectAbort()
          else init?.signal?.addEventListener('abort', rejectAbort, { once: true })
        })) as typeof fetch

      const timeoutCfg = loadConfig({ VENICE_API_KEY: 'test-key', VENICE_HTTP_TIMEOUT_MS: '5' })
      const tools = buildTools(new StubClient().asClient(), timeoutCfg)
      const r = await tools.find((t) => t.name === 'venice_asr')!.handler({
        audio_url: 'https://93.184.216.34/slow.wav',
      } as never)

      assert.equal(r.isError, true)
      assert.match((r.content[0] as { text: string }).text, /Timed out fetching audio_url after 5ms/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('requires model for venice_embeddings', () => {
    const { get } = setup()
    const tool = get('venice_embeddings')

    const modelSchema = tool.inputSchema.model

    assert.equal(
      modelSchema.isOptional(),
      false,
      'venice_embeddings.model should be required'
    )
  })
})

describe('x402 top-up discovery auth', () => {
  it('posts an empty unauthenticated body so a configured API key is not forwarded', async () => {
    const stub = new StubClient()
    const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === 'venice_x402_top_up_info')!
    assert.deepEqual(Object.keys(tool.inputSchema), [])
    assert.doesNotMatch(tool.description, /validated locally/)
    await tool.handler({} as never)
    const call = stub.calls.at(-1)
    assert.equal(call?.path, '/v1/x402/top-up')
    assert.deepEqual(call?.body, {})
    assert.equal(call?.auth, 'none')
  })

  it('returns the documented Base and Solana payment options from the 402 body', async () => {
    const base = {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '5000000',
      asset: '0xUSDC',
      payTo: '0xRECEIVER',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    }
    const solana = { ...base, network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'MINT', payTo: 'SOLRECEIVER' }
    const stub = new StubClient({
      '/v1/x402/top-up': () => {
        throw new VeniceUpstreamError({
          message: 'pay',
          status: 402,
          body: { x402Version: 2, accepts: [{ ...base, internal: 'drop-me' }, solana], debug: 'drop-me' },
        })
      },
    })
    const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === 'venice_x402_top_up_info')!
    const result = await tool.handler({} as never)
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.structuredContent, { x402Version: 2, accepts: [base, solana] })
    const text = (result.content[0] as { text: string }).text
    assert.match(text, /eip155:8453/)
    assert.match(text, /solana:/)
    assert.doesNotMatch(text, /drop-me/)
  })
})

describe('video tool schemas', () => {
  it('venice_video_generate requires duration', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_generate').inputSchema)

    const result = schema.safeParse({
      prompt: 'a sunset',
      model: 'veo3.1-fast-text-to-video',
    })

    assert.equal(result.success, false)
  })

  it('venice_video_quote requires duration', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_quote').inputSchema)

    const result = schema.safeParse({
      model: 'veo3.1-fast-text-to-video',
    })

    assert.equal(result.success, false)
  })

  it('accepts duration for venice_video_generate', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_generate').inputSchema)

    const result = schema.safeParse({
      prompt: 'a sunset',
      model: 'veo3.1-fast-text-to-video',
      duration: '8s',
    })

    assert.equal(result.success, true)
  })

  it('accepts duration for venice_video_quote', () => {
    const { get } = setup()
    const schema = z.object(get('venice_video_quote').inputSchema)

    const result = schema.safeParse({
      model: 'veo3.1-fast-text-to-video',
      duration: '8s',
    })

    assert.equal(result.success, true)
  })
})
