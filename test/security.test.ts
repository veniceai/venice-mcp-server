import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorizedBearerHeader, isLoopbackHost, isValidSessionId, validateHttpAuthConfig } from '../src/transports/http.js'
import { fetchUploadSource, validateRemoteUrl } from '../src/tools/remote-fetch.js'

const publicLookup = async () => ['93.184.216.34']
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('HTTP MCP bearer auth', () => {
  it('allows requests when no auth token is configured', () => {
    assert.equal(isAuthorizedBearerHeader(undefined, undefined), true)
    assert.equal(isAuthorizedBearerHeader(undefined, ''), true)
  })

  it('requires an exact bearer token when configured', () => {
    assert.equal(isAuthorizedBearerHeader(undefined, 'secret'), false)
    assert.equal(isAuthorizedBearerHeader('Basic secret', 'secret'), false)
    assert.equal(isAuthorizedBearerHeader('Bearer wrong', 'secret'), false)
    assert.equal(isAuthorizedBearerHeader('Bearer secret', 'secret'), true)
  })

  it('requires a strong token when HTTP mode is exposed beyond loopback', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('localhost'), true)
    assert.equal(isLoopbackHost('0.0.0.0'), false)

    assert.doesNotThrow(() => validateHttpAuthConfig('127.0.0.1', undefined, false))
    assert.throws(() => validateHttpAuthConfig('0.0.0.0', undefined, false), /VENICE_MCP_AUTH_TOKEN is required/)
    assert.throws(() => validateHttpAuthConfig('0.0.0.0', 'short', false), /at least 16 characters/)
    assert.doesNotThrow(() => validateHttpAuthConfig('0.0.0.0', '0123456789abcdef', false))
    assert.doesNotThrow(() => validateHttpAuthConfig('0.0.0.0', undefined, true))
  })

  it('accepts only server-generated UUID-shaped session ids', () => {
    assert.equal(isValidSessionId('550e8400-e29b-41d4-a716-446655440000'), true)
    assert.equal(isValidSessionId('caller-chosen-session'), false)
    assert.equal(isValidSessionId('../etc/passwd'), false)
  })
})

describe('remote upload fetch security', () => {
  it('rejects unsupported URL schemes', async () => {
    await assert.rejects(
      validateRemoteUrl(new URL('file:///etc/passwd'), publicLookup),
      /unsupported scheme/,
    )
  })

  it('rejects local hostnames and private resolved addresses', async () => {
    await assert.rejects(
      validateRemoteUrl(new URL('http://localhost/file.png'), publicLookup),
      /local hostname/,
    )
    await assert.rejects(
      validateRemoteUrl(new URL('https://metadata.example/file.png'), async () => ['169.254.169.254']),
      /private or local address/,
    )
    await assert.rejects(
      validateRemoteUrl(new URL('https://internal.example/file.png'), async () => ['10.0.0.5']),
      /private or local address/,
    )
  })

  it('revalidates redirect targets before following them', async () => {
    const fetchImpl = async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/private.png' },
      })

    await assert.rejects(
      fetchUploadSource('https://example.com/image.png', {
        label: 'image_url',
        fallbackContentType: 'image/png',
        fallbackFilename: 'image.png',
        timeoutMs: 1000,
        fetchImpl: fetchImpl as typeof fetch,
        lookupAddresses: publicLookup,
      }),
      /private or local address/,
    )
  })

  it('rejects responses larger than the configured byte limit', async () => {
    const fetchImpl = async () =>
      new Response('abcdef', {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '6' },
      })

    await assert.rejects(
      fetchUploadSource('https://example.com/image.png', {
        label: 'image_url',
        fallbackContentType: 'image/png',
        fallbackFilename: 'image.png',
        timeoutMs: 1000,
        maxBytes: 5,
        allowedContentTypes: ['image/'],
        fetchImpl: fetchImpl as typeof fetch,
        lookupAddresses: publicLookup,
      }),
      /larger than 5 bytes/,
    )
  })

  it('rejects unexpected content types when a tool constrains them', async () => {
    const fetchImpl = async () =>
      new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    await assert.rejects(
      fetchUploadSource('https://example.com/image.png', {
        label: 'image_url',
        fallbackContentType: 'image/png',
        fallbackFilename: 'image.png',
        timeoutMs: 1000,
        allowedContentTypes: ['image/'],
        fetchImpl: fetchImpl as typeof fetch,
        lookupAddresses: publicLookup,
      }),
      /unsupported content-type/,
    )
  })

  it('rejects generic octet-stream bodies that do not match allowed file signatures', async () => {
    const fetchImpl = async () =>
      new Response('not an image', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })

    await assert.rejects(
      fetchUploadSource('https://example.com/image.png', {
        label: 'image_url',
        fallbackContentType: 'image/png',
        fallbackFilename: 'image.png',
        timeoutMs: 1000,
        allowedContentTypes: ['image/'],
        fetchImpl: fetchImpl as typeof fetch,
        lookupAddresses: publicLookup,
      }),
      /unsupported content-type/,
    )
  })

  it('allows generic octet-stream only when magic bytes match an allowed family', async () => {
    const fetchImpl = async () =>
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })

    const source = await fetchUploadSource('https://example.com/image.png', {
      label: 'image_url',
      fallbackContentType: 'image/png',
      fallbackFilename: 'image.png',
      timeoutMs: 1000,
      allowedContentTypes: ['image/'],
      fetchImpl: fetchImpl as typeof fetch,
      lookupAddresses: publicLookup,
    })

    assert.equal(source.buffer.subarray(0, 4).equals(pngBytes.subarray(0, 4)), true)
  })

  it('uses a validated resolved address for the actual default request', async () => {
    const pinned: string[] = []
    const source = await fetchUploadSource('https://assets.example/image.png', {
      label: 'image_url',
      fallbackContentType: 'image/png',
      fallbackFilename: 'image.png',
      timeoutMs: 1000,
      allowedContentTypes: ['image/'],
      lookupAddresses: publicLookup,
      pinnedFetchImpl: async (url, address) => {
        pinned.push(`${url.hostname}:${address}`)
        return new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        })
      },
    })

    assert.deepEqual(pinned, ['assets.example:93.184.216.34'])
    assert.equal(source.filename, 'image.png')
  })
})
