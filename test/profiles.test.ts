import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, parseToolProfile } from '../src/config.js'
import { applyProfile, HOSTED_TOOLS, type ProfileRuntime } from '../src/profiles.js'
import { buildTools, type ToolDef, type ToolResult } from '../src/tools/index.js'
import { StubClient } from './helpers/stub-client.js'

function fakeRuntime(): ProfileRuntime & { slept: number[] } {
  let clock = 0
  const slept: number[] = []
  return {
    slept,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
    },
  }
}

function tool(name: string, results: ToolResult[], inputSchema: ToolDef['inputSchema'] = {}): ToolDef & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    name,
    title: name,
    description: `${name} test tool`,
    inputSchema,
    calls,
    handler: async (args) => {
      calls.push(args)
      return results[Math.min(calls.length - 1, results.length - 1)]
    },
  }
}

const status = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }], structuredContent: { status: value } })

describe('profile configuration', () => {
  it('defaults to the full profile with no waiting or inline limit', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.profile, 'full')
    assert.equal(cfg.statusWaitMs, 0)
    assert.equal(cfg.maxInlineMediaChars, 0)
    assert.equal(cfg.enableNsfw, true)
  })

  it('hosted turns on waiting, the inline limit and safe-by-default descriptions', () => {
    const cfg = loadConfig({ VENICE_MCP_PROFILE: 'hosted' })
    assert.equal(cfg.profile, 'hosted')
    assert.equal(cfg.statusWaitMs, 45_000)
    assert.equal(cfg.maxInlineMediaChars, 100_000)
    assert.equal(cfg.enableNsfw, false)
  })

  it('caps the status wait below the ~60 s host limit and rejects unknown profiles', () => {
    assert.equal(loadConfig({ VENICE_MCP_STATUS_WAIT_MS: '120000' }).statusWaitMs, 55_000)
    assert.equal(loadConfig({ VENICE_MCP_PROFILE: 'hosted', VENICE_MCP_STATUS_WAIT_MS: '0' }).statusWaitMs, 0)
    assert.throws(() => parseToolProfile('public'), /Unknown VENICE_MCP_PROFILE/)
  })
})

describe('hosted tool set', () => {
  it('keeps only the curated media tools that exist in this build', () => {
    const cfg = loadConfig({ VENICE_API_KEY: 'k', VENICE_MCP_PROFILE: 'hosted' })
    const all = buildTools(new StubClient().asClient(), cfg)
    const names = applyProfile(all, cfg).map((t) => t.name)
    assert.ok(names.length > 10)
    assert.ok(names.every((n) => HOSTED_TOOLS.has(n)))
    for (const excluded of ['venice_chat', 'venice_crypto_rpc', 'venice_x402_balance', 'venice_web_scrape']) {
      assert.equal(names.includes(excluded), false, `${excluded} should not be hosted`)
    }
    assert.equal(all.some((t) => / NSFW/.test(t.description)), false)
  })

  it('leaves the full profile untouched', () => {
    const cfg = loadConfig({ VENICE_API_KEY: 'k' })
    const all = buildTools(new StubClient().asClient(), cfg)
    const profiled = applyProfile(all, cfg)
    assert.equal(profiled.length, all.length)
    profiled.forEach((t, i) => assert.equal(t, all[i]))
  })

  it('forces safe_mode on image generation even when the caller turns it off', async () => {
    const cfg = loadConfig({ VENICE_MCP_PROFILE: 'hosted' })
    const generate = tool('venice_image_generate', [{ content: [{ type: 'text', text: 'ok' }] }], { safe_mode: {} as never })
    const [wrapped] = applyProfile([generate], cfg)
    await wrapped.handler({ prompt: 'x', safe_mode: false } as never)
    assert.equal((generate.calls[0] as { safe_mode: boolean }).safe_mode, true)
  })
})

describe('status waiting', () => {
  const cfg = { ...loadConfig({}), statusWaitMs: 45_000 }

  it('polls until the job completes', async () => {
    const runtime = fakeRuntime()
    const statusTool = tool('venice_video_status', [status('PROCESSING'), status('PROCESSING'), status('COMPLETED')])
    const [wrapped] = applyProfile([statusTool], cfg, runtime)
    const result = await wrapped.handler({ queue_id: 'q', model: 'm' } as never)
    assert.equal(result.structuredContent?.status, 'COMPLETED')
    assert.equal(statusTool.calls.length, 3)
    assert.deepEqual(runtime.slept, [5_000, 5_000])
  })

  it('returns PROCESSING once the wait budget is spent', async () => {
    const runtime = fakeRuntime()
    const statusTool = tool('venice_music_status', [status('PROCESSING')])
    const [wrapped] = applyProfile([statusTool], cfg, runtime)
    const result = await wrapped.handler({ queue_id: 'q', model: 'm' } as never)
    assert.equal(result.structuredContent?.status, 'PROCESSING')
    assert.ok(runtime.now() <= 45_000)
    assert.equal(statusTool.calls.length, 1 + runtime.slept.length)
  })

  it('does not retry errors or other tools', async () => {
    const runtime = fakeRuntime()
    const failing = tool('venice_video_status', [{ content: [{ type: 'text', text: 'boom' }], isError: true }])
    const other = tool('venice_video_generate', [status('PROCESSING')])
    const [w1, w2] = applyProfile([failing, other], cfg, runtime)
    await w1.handler({} as never)
    await w2.handler({} as never)
    assert.equal(failing.calls.length, 1)
    assert.equal(other.calls.length, 1)
    assert.deepEqual(runtime.slept, [])
  })
})

describe('inline media limit', () => {
  const cfg = { ...loadConfig({}), maxInlineMediaChars: 1_000 }

  it('replaces oversized inline media with an explanation and keeps links and small media', async () => {
    const big = 'A'.repeat(4_000)
    const media = tool('venice_image_generate', [
      {
        content: [
          { type: 'image', data: big, mimeType: 'image/png' },
          { type: 'image', data: 'AAAA', mimeType: 'image/webp' },
          { type: 'resource_link', uri: 'https://private-share.venice.ai/x', name: 'video', mimeType: 'video/mp4' },
        ],
      },
    ])
    const [wrapped] = applyProfile([media], cfg)
    const result = await wrapped.handler({} as never)
    assert.equal(result.content[0].type, 'text')
    assert.match((result.content[0] as { text: string }).text, /too large to return inline/)
    assert.equal(result.content[1].type, 'image')
    assert.equal(result.content[2].type, 'resource_link')
    assert.deepEqual(result.structuredContent?.omitted_inline_media, [
      { type: 'image', mime_type: 'image/png', base64_chars: 4_000 },
    ])
  })
})
