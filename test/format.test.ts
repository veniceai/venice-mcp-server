import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ASR_TIMESTAMP_DEFAULT_LIMIT, boundAsrResult, formatToolError, truncate } from '../src/format.js'
import { VeniceUpstreamError } from '../src/types.js'

describe('formatToolError', () => {
  it('formats insufficient-balance 402 with current balance + top-up steps', () => {
    const err = new VeniceUpstreamError({
      message: 'Payment required',
      status: 402,
      body: {
        reason: 'insufficient_balance',
        currentBalanceUsd: 0.001,
        minimumBalanceUsd: 0.1,
        suggestedTopUpUsd: 10,
        topUpInstructions: {
          step1: 'POST /api/v1/x402/top-up',
          step2: 'Sign USDC authorization',
          step3: 'POST signed payment',
          receiverWallet: '0x2670B922ef37C7Df47158725C0CC407b5382293F',
          network: 'base',
        },
      },
    })
    const out = formatToolError(err)
    assert.match(out, /402 Payment Required/)
    assert.match(out, /Current balance: +\$0\.0010/)
    assert.match(out, /Minimum required: +\$0\.1000/)
    assert.match(out, /Suggested top-up: +\$10\.00/)
    assert.match(out, /To top up:/)
    assert.match(out, /Receiver: 0x2670B922/)
    assert.match(out, /Network: +base/)
  })

  it('formats discovery 402 (no auth) with both auth options', () => {
    const err = new VeniceUpstreamError({
      message: 'Payment required',
      status: 402,
      body: {
        authOptions: {
          apiKey: { getKey: 'https://venice.ai/settings/api', docs: 'https://docs.venice.ai/api-reference' },
          x402Wallet: { topUp: 'POST /api/v1/x402/top-up', docs: 'https://docs.venice.ai/x402' },
        },
      },
    })
    const out = formatToolError(err)
    assert.match(out, /Authentication required/)
    assert.match(out, /Option A — API key/)
    assert.match(out, /Option B — x402 wallet/)
    assert.match(out, /VENICE_API_KEY/)
    assert.match(out, /VENICE_SIWX_TOKEN/)
    assert.match(out, /https:\/\/venice\.ai\/settings\/api/)
  })

  it('does not echo raw JSON when 402 has unknown shape', () => {
    const err = new VeniceUpstreamError({ message: 'pay', status: 402, body: { weird: 'thing' } })
    const out = formatToolError(err)
    assert.match(out, /unrecognized payment response/)
    assert.doesNotMatch(out, /weird/)
  })

  it('formats non-402 upstream errors without echoing the body', () => {
    const err = new VeniceUpstreamError({
      message: '',
      status: 503,
      body: { error: 'upstream-down' },
    })
    const out = formatToolError(err)
    assert.match(out, /Venice API error 503/)
    assert.doesNotMatch(out, /upstream-down/)
  })

  it('formats native Error objects', () => {
    assert.match(formatToolError(new Error('boom')), /Error: boom/)
  })

  it('formats arbitrary thrown values', () => {
    assert.match(formatToolError('weird string'), /Error: weird string/)
  })
})

describe('truncate', () => {
  it('passes through short strings', () => {
    assert.equal(truncate('hello', 1000), 'hello')
  })
  it('cuts at the limit and appends a marker', () => {
    const s = 'x'.repeat(100)
    const out = truncate(s, 10)
    assert.equal(out.startsWith('xxxxxxxxxx'), true)
    assert.match(out, /truncated 90 chars/)
  })
})

describe('boundAsrResult', () => {
  it('keeps the transcript and a full small timestamp page', () => {
    const out = boundAsrResult({
      text: 'hello',
      duration: 1.5,
      timestamps: { word: [{ word: 'hello', start: 0, end: 1.5 }] },
    })
    assert.equal(out.text, 'hello')
    assert.deepEqual(out.structured, {
      text: 'hello',
      duration: 1.5,
      timestamps: { word: [{ word: 'hello', start: 0, end: 1.5 }] },
      timestamp_offset: 0,
      timestamp_limit: ASR_TIMESTAMP_DEFAULT_LIMIT,
      timestamp_total: { word: 1 },
      timestamps_truncated: false,
    })
  })

  it('slices each timestamp array and reports totals', () => {
    const words = Array.from({ length: 5 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 }))
    const out = boundAsrResult({
      text: 'many words',
      timestamps: { word: words, char: [{ char: 'm', start: 0, end: 0.1 }] },
    }, 1, 2)
    assert.equal(out.text, 'many words')
    assert.deepEqual(out.structured.timestamps, {
      word: words.slice(1, 3),
      char: [],
    })
    assert.deepEqual(out.structured.timestamp_total, { word: 5, char: 1 })
    assert.equal(out.structured.timestamps_truncated, true)
    assert.equal(out.structured.timestamp_offset, 1)
    assert.equal(out.structured.timestamp_limit, 2)
  })

  it('omits unrecognized timestamp objects instead of echoing them', () => {
    const huge = { custom: 'x'.repeat(100) }
    const out = boundAsrResult({ text: 'ok', timestamps: huge })
    assert.equal(out.text, 'ok')
    assert.equal(out.structured.timestamps, undefined)
    assert.equal(out.structured.timestamps_omitted, true)
    assert.equal(out.structured.timestamps_truncated, true)
  })
})
