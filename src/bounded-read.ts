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
      void res.body?.cancel().catch(() => {})
      throw new ResponseTooLargeError(label, maxBytes)
    }
  }

  if (!res.body) return Buffer.alloc(0)

  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new ResponseTooLargeError(label, maxBytes)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch (err) {
    // Start cleanup without waiting for an untrusted source's cancel promise.
    void reader.cancel().catch(() => {})
    throw err
  } finally {
    reader.releaseLock()
  }
}
