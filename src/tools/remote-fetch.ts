import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { RequestOptions } from 'node:http'

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_REDIRECTS = 5
const DEFAULT_FETCH = fetch

type FetchImpl = typeof fetch
type LookupAddresses = (hostname: string) => Promise<string[]>
type PinnedFetchImpl = (url: URL, address: string, signal: AbortSignal) => Promise<Response>

export interface FetchUploadSourceOptions {
  label: string
  fallbackContentType: string
  fallbackFilename: string
  timeoutMs: number
  maxBytes?: number
  allowedContentTypes?: string[]
  fetchImpl?: FetchImpl
  pinnedFetchImpl?: PinnedFetchImpl
  lookupAddresses?: LookupAddresses
}

export interface UploadSource {
  buffer: Buffer
  contentType: string
  filename: string
}

export async function fetchUploadSource(url: string, opts: FetchUploadSourceOptions): Promise<UploadSource> {
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), opts.timeoutMs)
  const fetchImpl = opts.fetchImpl ?? fetch
  const useInjectedFetch = opts.fetchImpl !== undefined || fetchImpl !== DEFAULT_FETCH
  const lookupAddresses = opts.lookupAddresses ?? lookupHostname
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES

  try {
    let currentUrl = new URL(url)
    let res: Response | undefined

    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      res = await fetchRemoteUrl(currentUrl, ac.signal, lookupAddresses, useInjectedFetch ? fetchImpl : undefined, opts.pinnedFetchImpl)

      if (!isRedirect(res.status)) break

      const location = res.headers.get('location')
      if (!location) throw new Error(`Could not fetch ${opts.label}: redirect missing Location header`)
      currentUrl = new URL(location, currentUrl)
      res = undefined
    }

    if (!res) throw new Error(`Could not fetch ${opts.label}: too many redirects`)
    if (isRedirect(res.status)) throw new Error(`Could not fetch ${opts.label}: too many redirects`)
    if (!res.ok) throw new Error(`Could not fetch ${opts.label}: HTTP ${res.status}`)

    const headerContentType = res.headers.get('content-type')
    const contentType = headerContentType ?? opts.fallbackContentType
    const buffer = await readBoundedBuffer(res, maxBytes, opts.label)
    assertAllowedContentType(contentType, opts.allowedContentTypes, opts.label, buffer, headerContentType === null)

    return {
      buffer,
      contentType,
      filename: filenameFromUrl(currentUrl, opts.fallbackFilename),
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Timed out fetching ${opts.label} after ${opts.timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function validateRemoteUrl(url: URL, lookupAddresses: LookupAddresses = lookupHostname): Promise<void> {
  await resolveValidRemoteAddresses(url, lookupAddresses)
}

async function resolveValidRemoteAddresses(url: URL, lookupAddresses: LookupAddresses = lookupHostname): Promise<string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing to fetch URL with unsupported scheme: ${url.protocol}`)
  }

  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch local hostname: ${url.hostname}`)
  }

  const addresses = isIP(hostname) ? [hostname] : await lookupAddresses(hostname)
  if (addresses.length === 0) throw new Error(`Could not resolve hostname: ${url.hostname}`)

  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`Refusing to fetch private or local address: ${address}`)
    }
  }
  return addresses
}

async function fetchRemoteUrl(
  url: URL,
  signal: AbortSignal,
  lookupAddresses: LookupAddresses,
  injectedFetch?: FetchImpl,
  pinnedFetchImpl?: PinnedFetchImpl,
): Promise<Response> {
  if (injectedFetch) {
    await validateRemoteUrl(url, lookupAddresses)
    return injectedFetch(url, { signal, redirect: 'manual' })
  }

  return fetchPinnedRemoteUrl(url, signal, lookupAddresses, pinnedFetchImpl)
}

async function fetchPinnedRemoteUrl(
  url: URL,
  signal: AbortSignal,
  lookupAddresses: LookupAddresses,
  pinnedFetchImpl: PinnedFetchImpl = requestPinnedAddress,
): Promise<Response> {
  const addresses = await resolveValidRemoteAddresses(url, lookupAddresses)
  let lastError: unknown

  for (const address of addresses) {
    try {
      return await pinnedFetchImpl(url, address, signal)
    } catch (err) {
      if (signal.aborted) throw err
      lastError = err
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Could not fetch ${url.hostname}`)
}

async function requestPinnedAddress(url: URL, address: string, signal: AbortSignal): Promise<Response> {
  const client = url.protocol === 'https:' ? https : http
  const family = isIP(address)
  if (family !== 4 && family !== 6) throw new Error(`Refusing to fetch invalid resolved address: ${address}`)

  const options: RequestOptions & { servername?: string } = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { Host: url.host },
    signal,
    lookup: ((_hostname, options, callback) => {
      // Node ≥22 passes { all: true } to custom lookup functions; the callback
      // then expects an array of { address, family } objects rather than the
      // legacy (address, family) positional form.
      if ((options as { all?: boolean }).all) {
        ;(callback as unknown as (err: null, addrs: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address, family }],
        )
      } else {
        callback(null, address, family)
      }
    }) as RequestOptions['lookup'],
  }
  if (url.protocol === 'https:') options.servername = url.hostname

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item)
        } else if (value !== undefined) {
          headers.set(key, value)
        }
      }

      resolve(new Response(Readable.toWeb(res) as unknown as ConstructorParameters<typeof Response>[0], {
        status: res.statusCode ?? 500,
        statusText: res.statusMessage,
        headers,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function lookupHostname(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function assertAllowedContentType(
  contentType: string,
  allowed: string[] | undefined,
  label: string,
  buffer: Buffer,
  usedFallbackContentType: boolean,
): void {
  if (!allowed || allowed.length === 0) return
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase()
  if (normalized === 'application/octet-stream' && allowed.some((entry) => entry.toLowerCase() === 'application/octet-stream')) return
  if ((!normalized || normalized === 'application/octet-stream' || usedFallbackContentType) && isAllowedByMagicBytes(buffer, allowed)) return

  const ok = allowed.some((entry) => {
    const allowedType = entry.toLowerCase()
    return normalized.startsWith(allowedType)
  })
  if (!ok) throw new Error(`Could not fetch ${label}: unsupported content-type ${contentType}`)
  if (usedFallbackContentType) throw new Error(`Could not fetch ${label}: missing content-type did not match allowed file signatures`)
  if (normalized === 'application/octet-stream') throw new Error(`Could not fetch ${label}: unsupported content-type ${contentType}`)
}

async function readBoundedBuffer(res: Response, maxBytes: number, label: string): Promise<Buffer> {
  const contentLength = res.headers.get('content-length')
  if (contentLength !== null) {
    const size = Number(contentLength)
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`Could not fetch ${label}: response is larger than ${maxBytes} bytes`)
    }
  }

  if (!res.body) return Buffer.alloc(0)

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new Error(`Could not fetch ${label}: response is larger than ${maxBytes} bytes`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}

function filenameFromUrl(url: URL, fallback: string): string {
  const last = url.pathname.split('/').filter(Boolean).pop()
  if (!last) return fallback
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function isAllowedByMagicBytes(buffer: Buffer, allowed: string[]): boolean {
  return allowed.some((entry) => {
    const allowedType = entry.toLowerCase()
    if (allowedType.startsWith('image/')) return isImage(buffer)
    if (allowedType.startsWith('audio/')) return isAudio(buffer)
    if (allowedType.startsWith('video/')) return isVideo(buffer)
    if (allowedType === 'application/pdf') return startsWithAscii(buffer, '%PDF-')
    if (allowedType === 'application/epub+zip') return isZip(buffer)
    if (allowedType.startsWith('application/vnd.openxmlformats-officedocument.')) return isZip(buffer)
    if (allowedType.startsWith('application/vnd.ms-') || allowedType === 'application/msword') return isOle(buffer)
    return false
  })
}

function isImage(buffer: Buffer): boolean {
  return (
    buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
    buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) ||
    startsWithAscii(buffer, 'GIF8') ||
    (startsWithAscii(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP')
  )
}

function isAudio(buffer: Buffer): boolean {
  return (
    startsWithAscii(buffer, 'ID3') ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) ||
    (startsWithAscii(buffer, 'RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WAVE') ||
    startsWithAscii(buffer, 'OggS') ||
    startsWithAscii(buffer, 'fLaC') ||
    isMp4Family(buffer)
  )
}

function isVideo(buffer: Buffer): boolean {
  return isMp4Family(buffer) || buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
}

function isMp4Family(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
}

function isZip(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
}

function isOle(buffer: Buffer): boolean {
  return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
}

function startsWithAscii(buffer: Buffer, value: string): boolean {
  return buffer.subarray(0, value.length).toString('ascii') === value
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isBlockedIpv4(address)
  if (version === 6) return isBlockedIpv6(address)
  return true
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  const mappedIpv4 = normalized.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (mappedIpv4 && isBlockedIpv4(mappedIpv4)) return true

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  )
}
