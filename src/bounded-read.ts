export class ResponseTooLargeError extends Error {
  constructor(label: string, readonly maxBytes: number) {
    super(`Could not fetch ${label}: response is larger than ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

export async function readBoundedBuffer(res: Response, maxBytes: number, label: string): Promise<Buffer> {
  const contentLength = res.headers.get('content-length')
  if (contentLength !== null) {
    const size = Number(contentLength)
    if (Number.isFinite(size) && size > maxBytes) {
      throw new ResponseTooLargeError(label, maxBytes)
    }
  }

  if (!res.body) return Buffer.alloc(0)

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) {
      throw new ResponseTooLargeError(label, maxBytes)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks, total)
}
