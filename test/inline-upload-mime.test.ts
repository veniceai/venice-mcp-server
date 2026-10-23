import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../src/tools/index.js'
import { loadConfig } from '../src/config.js'
import { StubClient } from './helpers/stub-client.js'

const cfg = loadConfig({ VENICE_API_KEY: 'test-key' })
const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// Genuine fixtures copied from outputs/mcp-pr94-pr95-review-20261023:
// parser-repro/sample.pdf (589 bytes) and sample.docx (838 bytes).
const pdf = Buffer.from(
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg' +
  'L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg' +
  'UiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAw' +
  'IFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+' +
  'CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDUgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3MiA3MjAgVGQgKFJldmlldyBmaXh0dXJl' +
  'KSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAow' +
  'MDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4g' +
  'CnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA2CiUlRU9GCg==',
  'base64',
)
const docx = Buffer.from(
  'UEsDBBQAAAAIAAptV13mdcR+0gAAAIsBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvVLDMAzHX8XnlasVGBh6SToAKzD0BXSOkvjw' +
  '11luad++Sls6cIVR+n/8ZLebQ/BqT4Vdip1+NI3e9O32mImVKJE7Pdea1wBsZwrIJmWKooypBKwylgky2i+cCJ6a5hlsipViXdWlQ/ft' +
  'K42481W9HWR9oRTyrNXLxbiwOo05e2exig77OPyirK4EI8mzh2eX+UEMGu4SFuVvwDX3Ic8ubiD1iaW+YxAXfKcywJDsLkjS/F9z5840' +
  'js7SLb+05ZIsMbs4BW9uSkAXf+6H83f3J1BLAwQUAAAACAAKbVddXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+' +
  'QJ0yMKCmXVi6Ii4QJW5T0TzkhNftycBAEQOjf//6LHfDw6/iRpyXGBS0jYSh70606lKD7JaURW2ErMCVkg6I2TjyOjcxUaibKbLXpY48' +
  'Y9LmomfCnZR75E8DtqYYrQIebQvi/Ez0jx2naTF0jObqKZQfJ74aVdY8U1Fwj2zRvuOmsoB9h5sX+xdQSwMEFAAAAAgACm1XXQPjGtyH' +
  'AAAAtQAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEXOUQ6DIAwG4KsYDmDdHvZAUO+wGyhUJRFKCoq7/cA97OVr2j9tqsbL7c2JHC35Xjza' +
  'ToyDytKQPhz61JTYR5l7saUUJEDUG7opthTQl2whdlMqLa+QiU1g0hij9avb4dl1L3CT9aKenMl8ag0VrqThjafF3Cz2Sgejgjqr8m24' +
  '/e3B/6fhC1BLAQIUAxQAAAAIAAptV13mdcR+0gAAAIsBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAA' +
  'AAgACm1XXV8zlVKVAAAABwEAAAsAAAAAAAAAAAAAAIABAwEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgACm1XXQPjGtyHAAAAtQAAABEAAAAA' +
  'AAAAAAAAAIABwQEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAHcCAAAAAA==',
  'base64',
)

// Signature-only synthetic inputs exercise MIME/filename/byte transport, not
// file validity, decoding, or acceptance by an upstream media provider.
const jpeg = Buffer.from('ffd8ffe000104a4649460000ff80', 'hex')
const wav = Buffer.from('5249464610000000574156450080ff', 'hex')
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex')
const id3 = Buffer.from('4944330400000000000000ff80', 'hex')

interface Caller {
  tool: string
  input: string
  path: string
  field: string
  method: 'postMultipart' | 'postBinary'
  args?: Record<string, unknown>
}

const parser: Caller = {
  tool: 'venice_text_parser', input: 'url', path: '/v1/augment/text-parser', field: 'file', method: 'postMultipart',
}
const upscale: Caller = {
  tool: 'venice_image_upscale', input: 'image_url', path: '/v1/image/upscale', field: 'image', method: 'postBinary',
}
const asr: Caller = {
  tool: 'venice_asr', input: 'audio_url', path: '/v1/audio/transcriptions', field: 'file', method: 'postMultipart',
}
const clone: Caller = {
  tool: 'venice_voice_clone', input: 'sample_url', path: '/v1/audio/voices', field: 'file', method: 'postMultipart',
  args: { action: 'create' },
}

async function invoke(t: TestContext, caller: Caller, bytes: Buffer, mediaType: string) {
  const stub = new StubClient()
  const multipart = t.mock.method(stub, 'postMultipart')
  const binary = t.mock.method(stub, 'postBinary')
  const tool = buildTools(stub.asClient(), cfg).find((item) => item.name === caller.tool)
  assert.ok(tool, `tool not found: ${caller.tool}`)
  const result = await tool.handler({
    ...caller.args,
    [caller.input]: `data:${mediaType};base64,${bytes.toString('base64')}`,
  } as never)
  return { result, stub, multipart, binary }
}

async function assertUpload(
  t: TestContext, caller: Caller, bytes: Buffer, declaredType: string, expectedType: string, filename: string,
) {
  const { result, stub, multipart, binary } = await invoke(t, caller, bytes, declaredType)
  assert.equal(result.isError, undefined, JSON.stringify(result.content))
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].path, caller.path)
  assert.equal(multipart.mock.callCount(), caller.method === 'postMultipart' ? 1 : 0)
  assert.equal(binary.mock.callCount(), caller.method === 'postBinary' ? 1 : 0)
  const form = caller.method === 'postMultipart'
    ? multipart.mock.calls[0].arguments[1]
    : binary.mock.calls[0].arguments[1].form
  assert.ok(form instanceof FormData)
  const file = form.get(caller.field)
  assert.ok(file && typeof file !== 'string', `missing file field: ${caller.field}`)
  assert.equal(file.type, expectedType)
  assert.equal(file.name, filename)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
}

const inferredCases = [
  { name: 'PDF', caller: parser, bytes: pdf, type: 'application/pdf', filename: 'document.pdf' },
  { name: 'JPEG', caller: upscale, bytes: jpeg, type: 'image/jpeg', filename: 'image.jpg' },
  { name: 'PNG', caller: upscale, bytes: Buffer.from('89504e470d0a1a0a00ff80', 'hex'), type: 'image/png', filename: 'image.png' },
  { name: 'GIF87a', caller: upscale, bytes: Buffer.from('47494638376100ff80', 'hex'), type: 'image/gif', filename: 'image.gif' },
  { name: 'GIF89a', caller: upscale, bytes: Buffer.from('47494638396100ff80', 'hex'), type: 'image/gif', filename: 'image.gif' },
  { name: 'WebP', caller: upscale, bytes: Buffer.from('52494646100000005745425000ff80', 'hex'), type: 'image/webp', filename: 'image.webp' },
  { name: 'WAV ASR', caller: asr, bytes: wav, type: 'audio/wav', filename: 'audio.wav' },
  { name: 'WAV voice clone', caller: clone, bytes: wav, type: 'audio/wav', filename: 'sample.wav' },
  { name: 'FLAC', caller: asr, bytes: Buffer.from('664c614300ff80', 'hex'), type: 'audio/flac', filename: 'audio.flac' },
]

describe('inline upload MIME inference through buildTools handlers', () => {
  for (const declaredType of ['', 'application/octet-stream']) {
    for (const { name, caller, bytes, type, filename } of inferredCases) {
      it(`${name} with ${declaredType || 'omitted MIME'} uploads inferred MIME, filename, and unchanged bytes`, async (t) => {
        await assertUpload(t, caller, bytes, declaredType, type, filename)
      })
    }
  }
})

const ambiguousCases = [
  { name: 'valid DOCX/ZIP', caller: parser, bytes: docx },
  { name: 'OLE container', caller: parser, bytes: Buffer.from('d0cf11e0a1b11ae100ff80', 'hex') },
  { name: 'MP4 container', caller: asr, bytes: mp4 },
  { name: 'Ogg container', caller: asr, bytes: Buffer.from('4f67675300ff80', 'hex') },
  { name: 'ID3 tag', caller: asr, bytes: id3 },
  { name: 'audio frame sync', caller: asr, bytes: Buffer.from('fffb906400ff80', 'hex') },
  { name: 'four-byte PNG prefix', caller: upscale, bytes: Buffer.from('89504e47', 'hex') },
  { name: 'two-byte JPEG prefix', caller: upscale, bytes: Buffer.from('ffd8', 'hex') },
  { name: 'incomplete GIF signature', caller: upscale, bytes: Buffer.from('GIF8') },
]

describe('inline uploads requiring a concrete MIME declaration', () => {
  for (const declaredType of ['', 'application/octet-stream']) {
    for (const { name, caller, bytes } of ambiguousCases) {
      it(`${name} with ${declaredType || 'omitted MIME'} requests a concrete MIME without uploading`, async (t) => {
        const { result, stub, multipart, binary } = await invoke(t, caller, bytes, declaredType)
        assert.equal(multipart.mock.callCount(), 0)
        assert.equal(binary.mock.callCount(), 0)
        assert.equal(stub.calls.length, 0)
        assert.equal(result.isError, true)
        const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
        assert.match(text, /specify (?:a )?concrete (?:MIME|media) type/i)
      })
    }
  }
})

describe('explicit inline MIME declarations preserve existing upload metadata', () => {
  const cases = [
    { name: 'PDF', caller: parser, bytes: pdf, type: 'application/pdf', filename: 'document' },
    { name: 'DOCX', caller: parser, bytes: docx, type: docxType, filename: 'document' },
    { name: 'JPEG', caller: upscale, bytes: jpeg, type: 'image/jpeg', filename: 'image.png' },
    { name: 'WAV ASR', caller: asr, bytes: wav, type: 'audio/wav', filename: 'audio' },
    { name: 'WAV voice clone', caller: clone, bytes: wav, type: 'audio/wav', filename: 'sample' },
    { name: 'MP4 container', caller: asr, bytes: mp4, type: 'audio/mp4', filename: 'audio' },
    { name: 'ID3 with declared MPEG audio', caller: clone, bytes: id3, type: 'audio/mpeg', filename: 'sample' },
    { name: 'JPEG bytes with an authoritative WebP declaration', caller: upscale, bytes: jpeg, type: 'image/webp', filename: 'image.png' },
  ]
  for (const { name, caller, bytes, type, filename } of cases) {
    it(`${name} retains its declared MIME, existing filename, and bytes`, async (t) => {
      await assertUpload(t, caller, bytes, type, type, filename)
    })
  }
})
