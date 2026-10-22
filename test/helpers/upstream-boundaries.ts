import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../../src/config.js'
import { VeniceUpstreamError } from '../../src/types.js'
import { VeniceClient } from '../../src/venice-client.js'

export const MiB = 1024 * 1024
export const REQUEST_MARKER = 'private-request-body-fixture'
export const SIWX = 'test-only-siwx-fixture'
export const API_KEY = 'test-only-api-key-fixture'

export function config(baseUrl: string) {
  return { ...loadConfig({}), baseUrl, timeoutMs: 5_000 }
}

export function form(): FormData {
  const body = new FormData()
  body.set('file', new Blob([REQUEST_MARKER]), 'fixture.txt')
  return body
}

type Options = { maxBytes?: number; timeoutMs?: number }
type Call = {
  name: string
  invoke: (client: VeniceClient, path: string, opts?: Options) => Promise<unknown>
  hasBody?: boolean
}

export const calls: Call[] = [
  { name: 'GET', invoke: (c, p, o) => c.get(p, undefined, o) },
  { name: 'JSON POST', hasBody: true, invoke: (c, p, o) => c.post(p, { prompt: REQUEST_MARKER }, undefined, o) },
  { name: 'request metadata', hasBody: true, invoke: (c, p, o) => c.requestWithMetadata(p, { method: 'PUT', json: { prompt: REQUEST_MARKER }, ...o }) },
  { name: 'POST metadata', hasBody: true, invoke: (c, p, o) => c.postWithMetadata(p, { prompt: REQUEST_MARKER }, undefined, o) },
  { name: 'POST headers', hasBody: true, invoke: (c, p, o) => c.postWithHeaders(p, { prompt: REQUEST_MARKER }, undefined, o) },
  { name: 'multipart', hasBody: true, invoke: (c, p, o) => c.postMultipart(p, form(), o) },
  { name: 'binary JSON', hasBody: true, invoke: (c, p, o) => c.postBinary(p, { json: { prompt: REQUEST_MARKER } }, o) },
  { name: 'binary multipart', hasBody: true, invoke: (c, p, o) => c.postBinary(p, { form: form() }, o) },
  { name: 'mixed', hasBody: true, invoke: (c, p, o) => c.postMixed(p, { prompt: REQUEST_MARKER }, o) },
]
export const readCalls = calls.filter(({ name }) => ['JSON POST', 'multipart', 'binary JSON', 'binary multipart'].includes(name))

export async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export async function close(server: http.Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

export function isUpstreamError(status: number, expectedBody?: unknown) {
  return (err: unknown) => {
    assert.ok(err instanceof VeniceUpstreamError)
    assert.equal(err.status, status)
    assert.equal(err.isPaymentRequired, status === 402)
    assert.equal(err.headers['x-request-id'], 'boundary-fixture')
    if (expectedBody !== undefined) assert.deepEqual(err.body, expectedBody)
    assert.doesNotMatch(err.message, /timed out|destination-secret/)
    return true
  }
}
