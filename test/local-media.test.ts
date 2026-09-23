import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTools, toolsetFor, type ToolDef, type ToolResult } from '../src/tools/index.js'
import { loadConfig, parseToolsets } from '../src/config.js'
import { MediaStore, extensionForMime } from '../src/media/store.js'
import { localPathFromInput, resolveMediaInput } from '../src/media/inputs.js'
import { StubClient } from './helpers/stub-client.js'

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

let tmp: string
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'venice-mcp-media-'))
})
after(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function setup(overrides: ConstructorParameters<typeof StubClient>[0] = {}, env: Record<string, string> = {}) {
  const mediaDir = join(tmp, `run-${Math.random().toString(36).slice(2)}`)
  const cfg = loadConfig({ VENICE_API_KEY: 'test-key', VENICE_MEDIA_DIR: mediaDir, ...env })
  const stub = new StubClient(overrides)
  const sleeps: number[] = []
  const tools = buildTools(stub.asClient(), cfg, { sleep: async (ms) => { sleeps.push(ms) } })
  const get = (name: string): ToolDef => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`tool not found: ${name}`)
    return t
  }
  return { cfg, stub, tools, get, mediaDir, sleeps }
}

function fileLink(r: ToolResult) {
  return r.content.find((c) => c.type === 'resource_link') as { uri: string; mimeType?: string } | undefined
}

function structured<T = Record<string, unknown>>(r: ToolResult): T {
  return r.structuredContent as T
}

async function readSidecar(r: ToolResult): Promise<Record<string, unknown>> {
  const { sidecar_path } = structured<{ sidecar_path: string }>(r)
  return JSON.parse(await readFile(sidecar_path, 'utf8'))
}

describe('MediaStore', () => {
  it('writes the file under <root>/<kind>/ with a mime-derived extension and a JSON sidecar', async () => {
    const store = new MediaStore(join(tmp, 'store'))
    const saved = await store.save({
      kind: 'video',
      buffer: Buffer.from('mp4'),
      mimeType: 'video/mp4',
      label: 'A Cat, Running!!',
      metadata: { model: 'm', prompt: 'A Cat, Running!!' },
    })
    assert.match(saved.path, /\/store\/video\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-a-cat-running\.mp4$/)
    assert.equal(saved.fileUrl, `file://${saved.path}`)
    assert.equal(saved.bytes, 3)
    assert.equal((await stat(saved.path)).size, 3)
    const sidecar = JSON.parse(await readFile(saved.sidecarPath, 'utf8'))
    assert.equal(sidecar.file, saved.path)
    assert.equal(sidecar.mime_type, 'video/mp4')
    assert.equal(sidecar.model, 'm')
    assert.equal(sidecar.generator, 'venice')
  })

  it('does not overwrite an existing file with the same timestamp and label', async () => {
    const store = new MediaStore(join(tmp, 'store-collide'))
    const a = await store.save({ kind: 'image', buffer: Buffer.from('a'), mimeType: 'image/png', label: 'same', metadata: {} })
    const b = await store.save({ kind: 'image', buffer: Buffer.from('b'), mimeType: 'image/png', label: 'same', metadata: {} })
    assert.notEqual(a.path, b.path)
    assert.equal(await readFile(a.path, 'utf8'), 'a')
    assert.equal(await readFile(b.path, 'utf8'), 'b')
  })

  it('maps mime types to editor-friendly extensions and falls back to bin', () => {
    assert.equal(extensionForMime('audio/mpeg'), 'mp3')
    assert.equal(extensionForMime('audio/wav; charset=binary'), 'wav')
    assert.equal(extensionForMime('image/jpeg'), 'jpg')
    assert.equal(extensionForMime('application/x-unknown'), 'bin')
  })

  it('expands ~ in the configured root', () => {
    const store = new MediaStore('~/venice-test-media')
    assert.ok(!store.rootDir.startsWith('~'))
    assert.ok(store.rootDir.endsWith('/venice-test-media'))
  })
})

describe('local media inputs', () => {
  it('recognises absolute paths and file:// URLs but not http(s) or data: URLs', () => {
    assert.equal(localPathFromInput('/tmp/x.png'), '/tmp/x.png')
    assert.equal(localPathFromInput('file:///tmp/x.png'), '/tmp/x.png')
    assert.equal(localPathFromInput('https://example.com/x.png'), undefined)
    assert.equal(localPathFromInput('data:image/png;base64,AAAA'), undefined)
    assert.equal(localPathFromInput('relative/x.png'), undefined)
  })

  it('inlines a local file as a data: URL with a mime type from its extension', async () => {
    const p = join(tmp, 'in.png')
    await writeFile(p, PNG_1x1)
    const out = await resolveMediaInput(p, { label: 'image_url', maxBytes: 1024 })
    assert.equal(out, `data:image/png;base64,${PNG_1x1.toString('base64')}`)
  })

  it('passes remote URLs through untouched', async () => {
    const out = await resolveMediaInput('https://example.com/x.png', { label: 'image_url', maxBytes: 1 })
    assert.equal(out, 'https://example.com/x.png')
  })

  it('rejects missing files, oversized files, and unknown extensions with the parameter label', async () => {
    await assert.rejects(resolveMediaInput('/nonexistent/file.png', { label: 'image_url', maxBytes: 1024 }), /image_url: local file not found/)
    const big = join(tmp, 'big.png')
    await writeFile(big, Buffer.alloc(2048))
    await assert.rejects(resolveMediaInput(big, { label: 'image_url', maxBytes: 1024 }), /above the 1024-byte local input limit/)
    const odd = join(tmp, 'thing.xyz')
    await writeFile(odd, 'x')
    await assert.rejects(resolveMediaInput(odd, { label: 'video_url', maxBytes: 1024 }), /video_url: unsupported local file type ".xyz"/)
  })
})

describe('image tools with VENICE_MEDIA_DIR', () => {
  it('venice_image_generate saves each variant, returns file links with previews, and records params in the sidecar', async () => {
    const b64 = PNG_1x1.toString('base64')
    const { get, mediaDir } = setup({
      '/v1/image/generate': () => ({ id: 'img-1', images: [b64, b64] }),
    })
    const r = await get('venice_image_generate').handler({ prompt: 'Neon skyline', model: 'flux-2-pro', width: 512 } as never)
    assert.equal(r.isError, undefined)
    const links = r.content.filter((c) => c.type === 'resource_link') as Array<{ uri: string; mimeType?: string }>
    assert.equal(links.length, 2)
    assert.ok(links[0].uri.startsWith(`file://${mediaDir}/image/`))
    assert.equal(links[0].mimeType, 'image/png')
    assert.equal(r.content.filter((c) => c.type === 'image').length, 2, 'inline previews accompany file links')
    const s = structured<{ representation: string; files: Array<{ path: string; sidecar_path: string }> }>(r)
    assert.equal(s.representation, 'local file')
    assert.equal(s.files.length, 2)
    assert.deepEqual(await readFile(s.files[0].path), PNG_1x1)
    const sidecar = JSON.parse(await readFile(s.files[0].sidecar_path, 'utf8'))
    assert.equal(sidecar.tool, 'venice_image_generate')
    assert.equal(sidecar.model, 'flux-2-pro')
    assert.equal(sidecar.request_id, 'img-1')
    assert.equal(sidecar.params.prompt, 'Neon skyline')
    assert.equal(sidecar.params.width, 512)
  })

  it('venice_image_generate keeps inline base64 output when no media dir is configured', async () => {
    const cfg = loadConfig({ VENICE_API_KEY: 'k' })
    const tools = buildTools(new StubClient().asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_image_generate')!.handler({ prompt: 'x' } as never)
    assert.equal(r.content[0].type, 'image')
    assert.equal(fileLink(r), undefined)
  })

  it('venice_image_edit inlines a local source path as a data URL, saves the edited result, and keeps the original path in the sidecar', async () => {
    const src = join(tmp, 'edit-src.png')
    await writeFile(src, PNG_1x1)
    const { get, stub } = setup({
      '/v1/image/edit': () => ({ buffer: PNG_1x1, contentType: 'image/png' }),
    })
    const r = await get('venice_image_edit').handler({ image_url: src, prompt: 'make it blue' } as never)
    assert.equal(r.isError, undefined)
    const body = stub.callsTo('/v1/image/edit')[0].body as { image: string }
    assert.ok(body.image.startsWith('data:image/png;base64,'))
    assert.ok(fileLink(r)?.uri.includes('/image/'))
    const sidecar = await readSidecar(r)
    assert.equal(sidecar.tool, 'venice_image_edit')
    assert.deepEqual(sidecar.params, { image_url: src, prompt: 'make it blue' })
  })

  it('venice_image_upscale uploads a local file directly as multipart without fetching', async () => {
    const src = join(tmp, 'up-src.jpg')
    await writeFile(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const { get, stub } = setup({
      '/v1/image/upscale': () => ({ buffer: PNG_1x1, contentType: 'image/png' }),
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('fetch must not be called for a local path') }) as typeof fetch
    try {
      const r = await get('venice_image_upscale').handler({ image_url: src, scale: 2 } as never)
      assert.equal(r.isError, undefined, JSON.stringify(r.content))
      assert.equal(stub.callsTo('/v1/image/upscale')[0].multipart, true)
      assert.ok(fileLink(r))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_image_remove_bg returns a tool error naming the parameter when the local path does not exist', async () => {
    const { get } = setup()
    const r = await get('venice_image_remove_bg').handler({ image_url: '/definitely/missing.png' } as never)
    assert.equal(r.isError, true)
    assert.match((r.content[0] as { text: string }).text, /image_url: local file not found/)
  })
})

describe('venice_tts with VENICE_MEDIA_DIR', () => {
  it('saves speech under speech/ with the model and request params in the sidecar', async () => {
    const { get } = setup({
      '/v1/audio/speech': () => ({ buffer: Buffer.from('mp3-bytes'), contentType: 'audio/mpeg' }),
    })
    const r = await get('venice_tts').handler({ input: 'Hello there, general', voice: 'af_sky' } as never)
    assert.equal(r.isError, undefined)
    assert.match(fileLink(r)!.uri, /\/speech\/.*-hello-there-general\.mp3$/)
    const sidecar = await readSidecar(r)
    assert.equal(sidecar.tool, 'venice_tts')
    assert.equal(sidecar.model, 'tts-kokoro')
    assert.deepEqual(sidecar.params, { input: 'Hello there, general', voice: 'af_sky' })
  })
})

describe('video flow with VENICE_MEDIA_DIR', () => {
  it('venice_video_generate quotes first, reports estimated_cost_usd, and inlines local reference media', async () => {
    const frame = join(tmp, 'frame.png')
    await writeFile(frame, PNG_1x1)
    const { get, stub } = setup()
    const r = await get('venice_video_generate').handler({
      prompt: 'pan across the city', model: 'veo3.1-fast-image-to-video', duration: '4s', image_url: frame,
    } as never)
    assert.equal(r.isError, undefined, JSON.stringify(r.content))
    const s = structured<{ queue_id: string; estimated_cost_usd: number }>(r)
    assert.equal(s.queue_id, 'vid-123')
    assert.equal(s.estimated_cost_usd, 0.5)
    assert.match((r.content[0] as { text: string }).text, /Estimated cost: \$0\.5000 USD/)
    const quote = stub.callsTo('/v1/video/quote')[0]
    assert.deepEqual(quote.body, { model: 'veo3.1-fast-image-to-video', duration: '4s' })
    const queue = stub.callsTo('/v1/video/queue')[0].body as { image_url: string }
    assert.ok(queue.image_url.startsWith('data:image/png;base64,'))
    assert.ok(stub.calls.findIndex((c) => c.path === '/v1/video/quote') < stub.calls.findIndex((c) => c.path === '/v1/video/queue'))
  })

  it('venice_video_generate still queues when the quote endpoint fails', async () => {
    const { get } = setup({ '/v1/video/quote': () => { throw new Error('quote down') } })
    const r = await get('venice_video_generate').handler({ prompt: 'p', model: 'm', duration: '4s' } as never)
    assert.equal(r.isError, undefined)
    assert.equal(structured<{ estimated_cost_usd?: number }>(r).estimated_cost_usd, undefined)
  })

  it('venice_video_status writes a streamed MP4 to video/ with the queue-time prompt, params, and cost in the sidecar, then runs cleanup', async () => {
    const mp4 = Buffer.from('mock-mp4-bytes')
    const { get, stub } = setup({
      '/v1/video/retrieve': () => ({ kind: 'binary', buffer: mp4, contentType: 'video/mp4' }),
    })
    await get('venice_video_generate').handler({ prompt: 'Slow dolly in', model: 'm', duration: '4s', aspect_ratio: '16:9' } as never)
    const r = await get('venice_video_status').handler({ queue_id: 'vid-123', model: 'm', delete_media_on_completion: true } as never)
    assert.equal(r.isError, undefined, JSON.stringify(r.content))
    const s = structured<{ status: string; path: string; representation: string; server_media_deleted: boolean; estimated_cost_usd: number }>(r)
    assert.equal(s.status, 'COMPLETED')
    assert.equal(s.representation, 'local file')
    assert.match(s.path, /\/video\/.*-slow-dolly-in\.mp4$/)
    assert.deepEqual(await readFile(s.path), mp4)
    assert.equal(s.server_media_deleted, true)
    assert.equal(s.estimated_cost_usd, 0.5)
    assert.equal(r.content.some((c) => c.type === 'resource'), false, 'no embedded blob when saved to disk')
    const sidecar = await readSidecar(r)
    assert.equal(sidecar.prompt, 'Slow dolly in')
    assert.equal(sidecar.queue_id, 'vid-123')
    assert.equal(sidecar.delivery, 'stream')
    assert.deepEqual(sidecar.params, { prompt: 'Slow dolly in', model: 'm', duration: '4s', aspect_ratio: '16:9' })
    const order = stub.calls.map((c) => c.path)
    assert.ok(order.indexOf('/v1/video/retrieve') < order.indexOf('/v1/video/complete'))
  })

  it('venice_video_status downloads a COMPLETED download_url to disk instead of returning the link', async () => {
    const mp4 = Buffer.from('downloaded-mp4')
    const { get } = setup({
      '/v1/video/retrieve': () => ({ status: 'COMPLETED', download_url: 'https://media.venice.ai/v.mp4' }),
    })
    const originalFetch = globalThis.fetch
    let fetched: string | undefined
    globalThis.fetch = (async (url: string | URL | Request) => {
      fetched = String(url)
      return new Response(mp4, { status: 200, headers: { 'content-type': 'video/mp4' } })
    }) as typeof fetch
    try {
      const r = await get('venice_video_status').handler({ queue_id: 'q', model: 'm' } as never)
      assert.equal(r.isError, undefined, JSON.stringify(r.content))
      assert.equal(fetched, 'https://media.venice.ai/v.mp4')
      const s = structured<{ path: string; url: string }>(r)
      assert.deepEqual(await readFile(s.path), mp4)
      assert.equal(s.url, 'https://media.venice.ai/v.mp4')
      assert.equal((await readSidecar(r)).delivery, 'download_url')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('venice_video_status keeps the embedded-blob shape and cleanup ordering when no media dir is set', async () => {
    const cfg = loadConfig({ VENICE_API_KEY: 'k' })
    const stub = new StubClient({
      '/v1/video/retrieve': () => ({ kind: 'binary', buffer: Buffer.from('x'), contentType: 'video/mp4' }),
    })
    const tools = buildTools(stub.asClient(), cfg)
    const r = await tools.find((t) => t.name === 'venice_video_status')!.handler({ queue_id: 'q', model: 'm', delete_media_on_completion: true } as never)
    assert.equal(r.content[0].type, 'resource')
    const s = structured<{ server_media_deleted: boolean; representation: string }>(r)
    assert.equal(s.server_media_deleted, true)
    assert.equal(s.representation, 'MCP embedded blob resource')
  })

  it('venice_video_wait polls with growing backoff until COMPLETED and returns the status result', async () => {
    let calls = 0
    const { get, sleeps } = setup({
      '/v1/video/retrieve': () => {
        calls += 1
        if (calls < 4) return { status: 'PROCESSING', average_execution_time: 60_000 }
        return { kind: 'binary', buffer: Buffer.from('done'), contentType: 'video/mp4' }
      },
    })
    const r = await get('venice_video_wait').handler({ queue_id: 'q', model: 'm' } as never)
    assert.equal(structured<{ status: string }>(r).status, 'COMPLETED')
    assert.ok(fileLink(r))
    assert.equal(calls, 4)
    assert.deepEqual(sleeps, [5000, 7500, 11250])
  })

  it('venice_video_wait returns PROCESSING with timed_out and the queue_id when the deadline passes', async () => {
    const { get, sleeps } = setup({
      '/v1/video/retrieve': () => ({ status: 'PROCESSING' }),
    })
    const r = await get('venice_video_wait').handler({ queue_id: 'q', model: 'm', timeout_seconds: 12 } as never)
    assert.equal(r.isError, undefined)
    const s = structured<{ status: string; timed_out: boolean; queue_id: string; model: string }>(r)
    assert.equal(s.status, 'PROCESSING')
    assert.equal(s.timed_out, true)
    assert.equal(s.queue_id, 'q')
    assert.equal(s.model, 'm')
    assert.match((r.content[0] as { text: string }).text, /call venice_video_wait or venice_video_status again/)
    assert.deepEqual(sleeps, [5000])
  })

  it('venice_video_wait surfaces a status error immediately without further polling', async () => {
    let calls = 0
    const { get, sleeps } = setup({
      '/v1/video/retrieve': () => { calls += 1; throw new Error('boom') },
    })
    const r = await get('venice_video_wait').handler({ queue_id: 'q', model: 'm' } as never)
    assert.equal(r.isError, true)
    assert.equal(calls, 1)
    assert.deepEqual(sleeps, [])
  })
})

describe('music flow with VENICE_MEDIA_DIR', () => {
  it('venice_music_generate quotes with duration and lyric length and reports estimated_cost_usd', async () => {
    const { get, stub } = setup()
    const r = await get('venice_music_generate').handler({
      prompt: 'lofi beat', model: 'elevenlabs-music', duration_seconds: '30', lyrics_prompt: 'la la la',
    } as never)
    assert.equal(structured<{ estimated_cost_usd: number }>(r).estimated_cost_usd, 0.1)
    assert.deepEqual(stub.callsTo('/v1/audio/quote')[0].body, { model: 'elevenlabs-music', duration_seconds: 30, character_count: 8 })
  })

  it('venice_music_status writes completed audio under music/ using the Venice audio headers and the queued prompt', async () => {
    const wav = Buffer.from('RIFF-wav-bytes')
    const { get } = setup({
      '/v1/audio/retrieve': () => ({
        kind: 'binary', buffer: wav, contentType: 'audio/wav',
        headers: { 'x-venice-audio-format': 'wav', 'x-venice-audio-duration': '30.5' },
      }),
    })
    await get('venice_music_generate').handler({ prompt: 'Rainy Lofi', model: 'elevenlabs-music' } as never)
    const r = await get('venice_music_status').handler({ queue_id: 'mus-123', model: 'elevenlabs-music' } as never)
    assert.equal(r.isError, undefined, JSON.stringify(r.content))
    const s = structured<{ path: string; duration_seconds: number; representation: string }>(r)
    assert.match(s.path, /\/music\/.*-rainy-lofi\.wav$/)
    assert.equal(s.duration_seconds, 30.5)
    assert.equal(s.representation, 'local file')
    assert.deepEqual(await readFile(s.path), wav)
    const sidecar = await readSidecar(r)
    assert.equal(sidecar.prompt, 'Rainy Lofi')
    assert.equal(sidecar.audio_format, 'wav')
    assert.equal(sidecar.duration_seconds, 30.5)
  })

  it('venice_music_wait returns the saved file once the job completes', async () => {
    let calls = 0
    const { get } = setup({
      '/v1/audio/retrieve': () => {
        calls += 1
        return calls < 2
          ? { status: 'PROCESSING' }
          : { kind: 'binary', buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' }
      },
    })
    const r = await get('venice_music_wait').handler({ queue_id: 'q', model: 'm' } as never)
    assert.equal(structured<{ status: string }>(r).status, 'COMPLETED')
    assert.match(fileLink(r)!.uri, /\.mp3$/)
  })
})

describe('VENICE_TOOLSETS', () => {
  it('parses named sets, the media alias, and rejects unknown entries', () => {
    assert.equal(parseToolsets(undefined), undefined)
    assert.equal(parseToolsets('all'), undefined)
    assert.deepEqual([...parseToolsets('image, video')!].sort(), ['image', 'video'])
    assert.deepEqual([...parseToolsets('media')!].sort(), ['audio', 'catalog', 'image', 'music', 'video'])
    assert.throws(() => parseToolsets('nope'), /Unknown VENICE_TOOLSETS entry "nope"/)
  })

  it('every registered tool maps to a toolset', () => {
    const cfg = loadConfig({ VENICE_API_KEY: 'k' })
    for (const t of buildTools(new StubClient().asClient(), cfg)) {
      assert.ok(toolsetFor(t.name), t.name)
    }
  })

  it('media exposes only image, video, audio, music, and catalog tools', () => {
    const { tools } = setup({}, { VENICE_TOOLSETS: 'media' })
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('venice_image_generate'))
    assert.ok(names.includes('venice_video_generate'))
    assert.ok(names.includes('venice_video_wait'))
    assert.ok(names.includes('venice_music_wait'))
    assert.ok(names.includes('venice_tts'))
    assert.ok(names.includes('venice_list_models'))
    assert.ok(names.includes('venice_video_quote'))
    assert.ok(names.includes('venice_audio_quote'))
    assert.ok(!names.includes('venice_chat'))
    assert.ok(!names.includes('venice_crypto_rpc'))
    assert.ok(!names.includes('venice_x402_balance'))
    assert.ok(!names.includes('venice_web_search'))
    assert.ok(!names.includes('venice_video_transcriptions'))
  })

  it('leaves the media dir empty when no media tool has run', async () => {
    const { mediaDir } = setup({}, { VENICE_TOOLSETS: 'media' })
    await assert.rejects(readdir(mediaDir))
  })
})
