import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runHttp } from '../src/transports/http.js'

describe('runHttp', () => {
  it('rejects an invalid configuration before it starts listening', { timeout: 10_000 }, async () => {
    const saved = process.env.VENICE_TOOLSETS
    process.env.VENICE_TOOLSETS = 'nope'
    try {
      await assert.rejects(runHttp({ port: 0, host: '127.0.0.1' }), /Unknown VENICE_TOOLSETS entry "nope"/)
    } finally {
      if (saved === undefined) delete process.env.VENICE_TOOLSETS
      else process.env.VENICE_TOOLSETS = saved
    }
  })
})
