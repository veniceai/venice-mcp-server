import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'
import { buildTools, type BuildToolsOptions, type ToolResult } from '../src/tools/index.js'
import { StubClient } from './helpers/stub-client.js'

const cfg = loadConfig({ VENICE_API_KEY: 'test-key' })
const audioUrl = 'https://93.184.216.34/audio.wav'

function setup(stub = new StubClient(), options: BuildToolsOptions = { stateless: true }) {
  const tools = buildTools(stub.asClient(), cfg, options)
  return (name: string) => {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool, `Missing tool: ${name}`)
    return tool
  }
}

function text(result: ToolResult): string {
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
}

describe('stateless ASR', () => {
  it('returns the complete bounded JSON in both representations without handles or retained timers', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      new Response('mock audio', { headers: { 'content-type': 'audio/wav' } }))
    const scheduled = t.mock.method(globalThis, 'setTimeout')
    const cleared = t.mock.method(globalThis, 'clearTimeout')
    const upstream = {
      text: 'A long transcript with "quotes", unicode café, and newlines.\n'.repeat(300),
      duration: 300,
      language: 'en',
      timestamps: {
        word: Array.from({ length: 260 }, (_, i) => ({ word: `word-${i}`, start: i, end: i + 1 })),
        segment: Array.from({ length: 220 }, (_, i) => ({ text: `segment-${i}`, start: i, end: i + 1 })),
        char: Array.from({ length: 9000 }, (_, i) => ({ char: 'a', start: i / 100, end: (i + 1) / 100 })),
        units: 'seconds',
      },
      metadata: { provider: 'stub', confidence: 0.9 },
    }
    const stub = new StubClient({ '/v1/audio/transcriptions': () => upstream })
    const result = await setup(stub)('venice_asr').handler({
      audio_url: audioUrl,
      timestamps: true,
      timestamp_offset: 0,
      text_offset: 0,
      timestamp_limit: 1,
    })

    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(text(result)), upstream)
    assert.deepEqual(result.structuredContent, upstream)
    assert.equal(stub.callsTo('/v1/audio/transcriptions').length, 1)
    assert.equal(stub.calls[0].maxBytes, 1024 * 1024)
    for (const call of scheduled.mock.calls) {
      assert.ok(cleared.mock.calls.some((clear) => clear.arguments[0] === call.result), 'Timer remains after ASR completes')
    }
  })

  it('preserves plain-text and alternate JSON transcription responses', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      new Response('mock audio', { headers: { 'content-type': 'audio/wav' } }))
    const transcript = 'a'.repeat(8000) + '\n"tail" café'
    const alternate = {
      transcription: transcript,
      timestamps: Array.from({ length: 501 }, (_, i) => ({ text: `word-${i}`, start: i, end: i + 1 })),
    }
    for (const upstream of [transcript, alternate]) {
      const stub = new StubClient({ '/v1/audio/transcriptions': () => upstream })
      const result = await setup(stub)('venice_asr').handler({
        audio_url: audioUrl, response_format: typeof upstream === 'string' ? 'text' : 'json',
      })
      const expected = typeof upstream === 'string' ? { text: upstream } : upstream
      assert.equal(result.isError, undefined)
      assert.deepEqual(result.structuredContent, expected)
      assert.deepEqual(JSON.parse(text(result)), expected)
    }
  })

  for (const continuation of [
    { result_handle: 'previous-result' },
    { result_handle: 'previous-result', audio_url: audioUrl },
    { timestamp_offset: 1 },
    { timestamp_offset: 200, audio_url: audioUrl },
    { text_offset: 8000 },
    { text_offset: 8000, audio_url: audioUrl },
  ]) {
    it(`rejects continuation before validation, download, or inference: ${JSON.stringify(continuation)}`, async (t) => {
      const download = t.mock.method(globalThis, 'fetch', async () => new Response('unexpected download'))
      let validations = 0
      const stub = new StubClient()
      const tool = setup(stub, {
        stateless: true,
        beforeUpload: async () => { validations += 1 },
      })('venice_asr')
      const result = await tool.handler(continuation)

      assert.equal(result.isError, true)
      assert.equal(result.structuredContent?.error, 'asr_pagination_unsupported')
      assert.match(text(result), /fresh, charged transcription/)
      assert.equal(validations, 0)
      assert.equal(download.mock.callCount(), 0)
      assert.deepEqual(stub.calls, [])
    })
  }
})

describe('stateless video', () => {
  const downloadUrl = 'https://private-share.venice.ai/v1/share/read/stateless-video'
  const model = 'grok-imagine-text-to-video-private'

  it('does not retain queue URLs even within a stateless tool build or share them with another build', async () => {
    const stub = new StubClient({
      '/v1/video/queue': () => ({ model, queue_id: 'stateless-video', download_url: downloadUrl }),
      '/v1/video/retrieve': () => ({ status: 'COMPLETED' }),
    })
    const get = setup(stub)
    await get('venice_video_generate').handler({ prompt: 'A waterfall', model, duration: '6s' })
    for (const tools of [get, setup(stub), setup(stub, {})]) {
      const result = await tools('venice_video_status').handler({ queue_id: 'stateless-video', model })
      assert.equal(result.isError, true)
      assert.ok(!JSON.stringify(result).includes(downloadUrl))
    }
  })
})

describe('upload admission callback', () => {
  const uploads = [
    { name: 'venice_image_upscale', args: { image_url: 'https://93.184.216.34/image.png' }, contentType: 'image/png', path: '/v1/image/upscale' },
    { name: 'venice_asr', args: { audio_url: audioUrl }, contentType: 'audio/wav', path: '/v1/audio/transcriptions' },
    { name: 'venice_voice_clone', args: { action: 'create', sample_url: audioUrl }, contentType: 'audio/wav', path: '/v1/audio/voices' },
    { name: 'venice_text_parser', args: { url: 'https://93.184.216.34/document.pdf' }, contentType: 'application/pdf', path: '/v1/augment/text-parser' },
  ]

  for (const upload of uploads) {
    it(`awaits admission before ${upload.name} downloads or uploads`, async (t) => {
      const events: string[] = []
      t.mock.method(globalThis, 'fetch', async () => {
        events.push('download')
        return new Response('mock source', { headers: { 'content-type': upload.contentType } })
      })
      const stub = new StubClient({ [upload.path]: () => { events.push('upload'); return { text: 'stub' } } })
      let release!: () => void
      const admission = new Promise<void>((resolve) => { release = resolve })
      t.after(() => release())
      const tool = setup(stub, {
        stateless: true,
        beforeUpload: async () => { events.push('validate'); await admission },
      })(upload.name)
      const pending = tool.handler(upload.args)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(events, ['validate'])
      release()
      const result = await pending
      assert.equal(result.isError, undefined, text(result))
      assert.deepEqual(events, ['validate', 'download', 'upload'])
    })
  }

  it('skips admission for missing upload arguments and voice listing', async (t) => {
    const download = t.mock.method(globalThis, 'fetch', async () => new Response('unexpected download'))
    const stub = new StubClient()
    const admission = t.mock.fn(async () => { throw new Error('Unexpected admission') })
    const get = setup(stub, { stateless: true, beforeUpload: admission })
    assert.equal((await get('venice_asr').handler({})).isError, true)
    assert.equal((await get('venice_voice_clone').handler({ action: 'create' })).isError, true)
    assert.equal((await get('venice_voice_clone').handler({ action: 'list' })).isError, undefined)
    assert.equal(admission.mock.callCount(), 0)
    assert.equal(download.mock.callCount(), 0)
    assert.deepEqual(stub.calls.map((call) => call.path), ['/v1/models?type=tts'])
  })

  it('keeps sessionful ASR paging and skips admission for retained or unknown handles', async (t) => {
    const download = t.mock.method(globalThis, 'fetch', async () =>
      new Response('mock audio', { headers: { 'content-type': 'audio/wav' } }))
    let validations = 0
    const stub = new StubClient({ '/v1/audio/transcriptions': () => ({ text: 'a'.repeat(8000) + 'tail' }) })
    const tool = setup(stub, { beforeUpload: async () => { validations += 1 } })('venice_asr')
    const initial = await tool.handler({ audio_url: audioUrl })
    const handle = initial.structuredContent?.result_handle
    assert.equal(typeof handle, 'string')
    assert.equal(initial.structuredContent?.text, 'a'.repeat(8000))
    const next = await tool.handler({ result_handle: handle, text_offset: 8000 })
    assert.equal(next.isError, undefined)
    assert.equal(next.structuredContent?.text, 'tail')
    const missing = await tool.handler({ result_handle: 'unknown', audio_url: audioUrl })
    assert.equal(missing.structuredContent?.error, 'asr_result_expired')
    assert.equal(validations, 1)
    assert.equal(download.mock.callCount(), 1)
    assert.equal(stub.callsTo('/v1/audio/transcriptions').length, 1)
  })
})
