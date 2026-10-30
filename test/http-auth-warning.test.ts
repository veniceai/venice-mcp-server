import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { httpAuthWarning } from '../src/transports/http.js'

describe('HTTP auth startup warning', () => {
  it('warns when a loopback bind has no token', () => {
    const warning = httpAuthWarning('127.0.0.1', undefined)
    assert.match(warning ?? '', /no VENICE_MCP_AUTH_TOKEN/)
    assert.match(warning ?? '', /local process/)
  })

  it('stays quiet when a loopback bind is token-guarded', () => {
    assert.equal(httpAuthWarning('127.0.0.1', '0123456789abcdef'), undefined)
  })

  it('warns about reachability when exposed with a token', () => {
    assert.match(httpAuthWarning('0.0.0.0', '0123456789abcdef') ?? '', /reachable beyond loopback/)
  })

  it('names both exposures when bound outward with no token', () => {
    const warning = httpAuthWarning('0.0.0.0', undefined) ?? ''
    assert.match(warning, /no VENICE_MCP_AUTH_TOKEN/)
    assert.match(warning, /beyond loopback/)
  })

  it('treats a blank token as absent', () => {
    assert.match(httpAuthWarning('127.0.0.1', '   ') ?? '', /no VENICE_MCP_AUTH_TOKEN/)
  })
})
