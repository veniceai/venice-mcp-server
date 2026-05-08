import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthorizedBearerHeader } from '../src/transports/http.js'
import { fetchUploadSource, validateRemoteUrl } from '../src/tools/remote-fetch.js'

const publicLookup = async () => ['93.184.216.34']

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
})
