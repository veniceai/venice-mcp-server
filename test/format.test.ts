import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ASR_TEXT_PAGE_CHARS, ASR_TIMESTAMP_DEFAULT_LIMIT, boundAsrResult, fitJson, fitJsonList, formatToolError, truncate } from '../src/format.js'
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

  it('formats x402 v2 402 with a single accepts[] payment requirement', () => {
    const err = new VeniceUpstreamError({
      message: 'Payment required',
      status: 402,
      body: {
        x402Version: 2,
        error: 'PAYMENT-SIGNATURE header is required',
        resource: {
          url: 'https://api.venice.ai/api/v1/x402/top-up',
          description: 'Venice x402 wallet top-up',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '5000000',
            asset: '0x8335894CDEdB182688e1A3Ea5cbb9C5cF2c96e6f',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            maxTimeoutSeconds: 60,
            extra: { name: 'USDC', version: '2' },
          },
        ],
      },
    })
    const out = formatToolError(err)
    assert.match(out, /402 Payment Required/)
    assert.match(out, /x402 protocol v2/)
    assert.match(out, /PAYMENT-SIGNATURE header is required/)
    assert.match(out, /Resource: https:\/\/api\.venice\.ai\/api\/v1\/x402\/top-up/)
    assert.match(out, /scheme=exact, network=eip155:8453/)
    // 5000000 base units == $5.000000 at USDC 6-decimal precision
    assert.match(out, /Amount: +\$5\.000000 USD \(5000000 base units\)/)
    assert.match(out, /Asset: +0x8335894CDEdB182688e1A3Ea5cbb9C5cF2c96e6f \(USDC v2\)/)
    assert.match(out, /Pay to: +0x209693Bc6afc0C5328bA36FaF03C514EF312287C/)
    assert.match(out, /Timeout: +60s/)
    assert.match(out, /PAYMENT-SIGNATURE/)
    // Must NOT fall through to the generic unrecognized text.
    assert.doesNotMatch(out, /unrecognized payment response/)
  })

  it('formats x402 v2 402 with multiple accepts[] entries and numbers them', () => {
    const err = new VeniceUpstreamError({
      message: 'Payment required',
      status: 402,
      body: {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            amount: '5000000',
            asset: '0x8335894CDEdB182688e1A3Ea5cbb9C5cF2c96e6f',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            maxTimeoutSeconds: 60,
            extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' },
          },
          {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: '2500000',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
            maxTimeoutSeconds: 120,
            extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' },
          },
        ],
      },
    })
    const out = formatToolError(err)
    assert.match(out, /Accepted payment methods \(2\):/)
    assert.match(out, /Payment \[1\] — scheme=exact, network=eip155:8453/)
    assert.match(out, /Payment \[2\] — scheme=exact, network=eip155:84532/)
    assert.match(out, /\$5\.000000 USD \(5000000 base units\)/)
    assert.match(out, /\$2\.500000 USD \(2500000 base units\)/)
    assert.match(out, /Transfer: eip3009/)
    assert.match(out, /Transfer: permit2/)
    assert.doesNotMatch(out, /unrecognized payment response/)
  })

  it('handles x402 v2 402 with an empty accepts array gracefully', () => {
    const err = new VeniceUpstreamError({
      message: 'Payment required',
      status: 402,
      body: { x402Version: 2, accepts: [] },
    })
    const out = formatToolError(err)
    assert.match(out, /x402 protocol v2/)
    assert.match(out, /no acceptable payment methods/)
    assert.doesNotMatch(out, /unrecognized payment response/)
  })

  it('does not treat a non-v2 body with an accepts field as x402 v2', () => {
    // x402Version must be exactly 2; missing or wrong version falls through.
    const err = new VeniceUpstreamError({
      message: 'pay',
      status: 402,
      body: { accepts: [{ scheme: 'exact' }] },
    })
    const out = formatToolError(err)
    assert.match(out, /unrecognized payment response/)
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

describe('fitJson', () => {
  it('returns untouched JSON when it fits', () => {
    assert.deepEqual(fitJson({ a: 'b' }, 100), { text: JSON.stringify({ a: 'b' }, null, 2), truncated: false })
  })
  it('keeps escaped and non-ASCII strings valid and within the limit', () => {
    const { text, truncated } = fitJson({ description: '"\\\n'.repeat(200), text: '🙂'.repeat(200) }, 300)
    assert.equal(truncated, true)
    assert.ok(text.length <= 300)
    assert.equal((JSON.parse(text) as { truncated: boolean }).truncated, true)
  })
  it('shortens prose inside an array root without adding a marker key', () => {
    const { text, truncated } = fitJson([{ description: 'x'.repeat(1000) }], 200)
    assert.equal(truncated, true)
    assert.match((JSON.parse(text) as Array<{ description: string }>)[0].description, /^x+…\[truncated\]$/)
  })
  it('shortens an oversized character review message instead of dropping the review', () => {
    const value = {
      data: [{
        characterId: '2f460055-7595-4640-9cb6-c442c4c869b0',
        createdAt: '2025-02-09T03:23:53.708Z',
        id: '1e38fb78-043f-4ce2-b3bc-966089c25467',
        isOwner: false,
        locale: 'en',
        message: 'Thoughtful and practical. '.repeat(400),
        rating: 5,
        userAvatarUrl: null,
        username: 'product_user_42',
      }],
      object: 'list',
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      summary: { averageRating: 5, totalReviews: 1 },
    }
    const original = JSON.stringify(value)
    const { text, truncated } = fitJson(value)
    const parsed = JSON.parse(text) as typeof value & { truncated: boolean }
    assert.equal(truncated, true)
    assert.ok(text.length <= 8000)
    assert.equal(parsed.data.length, 1)
    assert.ok(parsed.data[0].message.length < value.data[0].message.length)
    assert.ok(parsed.data[0].message.endsWith('…[truncated]'))
    assert.ok(value.data[0].message.startsWith(parsed.data[0].message.slice(0, -'…[truncated]'.length)))
    assert.deepEqual(parsed, {
      ...value,
      data: [{ ...value.data[0], message: parsed.data[0].message }],
      truncated: true,
    })
    assert.equal(JSON.stringify(value), original)
  })
  it('shortens only prose fields and leaves identifiers untouched', () => {
    const value = {
      id: 'i'.repeat(400),
      slug: 's'.repeat(400),
      shareUrl: `https://venice.ai/c/${'u'.repeat(400)}`,
      address: `0x${'a'.repeat(400)}`,
      description: 'd'.repeat(3000),
    }
    const { text, truncated } = fitJson(value, 2000)
    const parsed = JSON.parse(text) as typeof value & { truncated: boolean }
    assert.equal(truncated, true)
    assert.ok(text.length <= 2000)
    assert.equal(parsed.id, value.id)
    assert.equal(parsed.slug, value.slug)
    assert.equal(parsed.shareUrl, value.shareUrl)
    assert.equal(parsed.address, value.address)
    assert.match(parsed.description, /^d+…\[truncated\]$/)
  })
  it('drops array items instead of cutting identifiers when prose is not enough', () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}/${'u'.repeat(100)}`)
    const { text, truncated } = fitJson({ urls }, 1000)
    const parsed = JSON.parse(text) as { urls: string[] }
    assert.equal(truncated, true)
    assert.ok(text.length <= 1000)
    assert.ok(parsed.urls.length > 0 && parsed.urls.length < 20)
    assert.deepEqual(parsed.urls, urls.slice(0, parsed.urls.length))
  })
  it('drops from the largest serialized array before arrays with more small items', () => {
    const value = {
      small: Array.from({ length: 20 }, (_, i) => i),
      large: ['a'.repeat(1000), 'b'.repeat(1000)],
    }
    const { text, truncated } = fitJson(value, 1500)
    const parsed = JSON.parse(text) as typeof value
    assert.equal(truncated, true)
    assert.ok(text.length <= 1500)
    assert.deepEqual(parsed.small, value.small)
    assert.deepEqual(parsed.large, value.large.slice(0, 1))
    assert.equal(value.large.length, 2)
  })
  it('returns the error notice rather than cutting a lone oversized identifier', () => {
    const { text, truncated } = fitJson({ url: `https://example.com/${'u'.repeat(1000)}` }, 200)
    assert.equal(truncated, true)
    assert.match((JSON.parse(text) as { error: string }).error, /exceeds 200 characters/)
  })
  it('falls back to a valid notice when nothing can be shortened or dropped', () => {
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key${i}`, i]))
    const { text, truncated } = fitJson(value, 200)
    assert.equal(truncated, true)
    assert.equal((JSON.parse(text) as { truncated: boolean }).truncated, true)
  })
})

describe('fitJsonList', () => {
  it('drops whole trailing items until the list fits', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'p'.repeat(50) }))
    const { text, returned, truncated } = fitJsonList(items, 1000)
    const parsed = JSON.parse(text) as { truncated: boolean; returned: number; total: number; data: unknown[] }
    assert.equal(truncated, true)
    assert.ok(text.length <= 1000)
    assert.deepEqual(parsed.data, items.slice(0, returned))
    assert.equal(parsed.returned, returned)
    assert.equal(parsed.total, 50)
  })
  it('shortens the prose of an oversized first item so it is still returned', () => {
    const items = [
      { slug: 'alan-watts', shareUrl: 'https://venice.ai/c/alan-watts', description: 'd'.repeat(5000) },
      { slug: 'second', description: 'short' },
    ]
    const { text, returned, truncated } = fitJsonList(items, 1000)
    const parsed = JSON.parse(text) as { returned: number; total: number; data: Array<{ slug: string; shareUrl: string; description: string }> }
    assert.equal(truncated, true)
    assert.equal(returned, 1)
    assert.ok(text.length <= 1000)
    assert.equal(parsed.returned, 1)
    assert.equal(parsed.total, 2)
    assert.equal(parsed.data[0].slug, 'alan-watts')
    assert.equal(parsed.data[0].shareUrl, 'https://venice.ai/c/alan-watts')
    assert.match(parsed.data[0].description, /^d+…\[truncated\]$/)
    assert.equal(items[0].description.length, 5000)
  })
  it('returns no items when even a shortened first item cannot fit', () => {
    const items = [{ slug: 's'.repeat(2000), description: 'd'.repeat(2000) }]
    const { text, returned, truncated } = fitJsonList(items, 1000)
    assert.equal(truncated, true)
    assert.equal(returned, 0)
    assert.deepEqual((JSON.parse(text) as { data: unknown[] }).data, [])
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
      next_timestamp_offset: null,
    })
    assert.equal(out.paged, true)
  })

  it('reports no further page on the last timestamp page', () => {
    const words = Array.from({ length: 5 }, (_, i) => ({ word: `w${i}`, start: i, end: i + 1 }))
    const out = boundAsrResult({ text: 'x', timestamps: { word: words } }, 3, 2)
    assert.deepEqual(out.structured.timestamps, { word: words.slice(3, 5) })
    assert.equal(out.structured.timestamps_truncated, false)
    assert.equal(out.structured.next_timestamp_offset, null)
  })

  it('pages a long transcript by character offset', () => {
    const transcript = 'a'.repeat(ASR_TEXT_PAGE_CHARS) + 'b'.repeat(10)
    const first = boundAsrResult({ text: transcript })
    assert.equal(first.paged, true)
    assert.equal(first.structured.text, 'a'.repeat(ASR_TEXT_PAGE_CHARS))
    assert.equal(first.structured.text_total, transcript.length)
    assert.equal(first.structured.next_text_offset, ASR_TEXT_PAGE_CHARS)
    const last = boundAsrResult({ text: transcript }, 0, ASR_TIMESTAMP_DEFAULT_LIMIT, ASR_TEXT_PAGE_CHARS)
    assert.equal(last.structured.text, 'b'.repeat(10))
    assert.equal(last.structured.next_text_offset, null)
  })

  it('leaves a short plain transcript unpaged', () => {
    const out = boundAsrResult({ text: 'short' })
    assert.equal(out.paged, false)
    assert.deepEqual(out.structured, { text: 'short' })
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
    assert.equal(out.structured.next_timestamp_offset, 3)
    assert.equal(out.structured.timestamp_offset, 1)
    assert.equal(out.structured.timestamp_limit, 2)
  })

  for (const timestamps of [null, 'unexpected', 42, true]) {
    it(`returns a null continuation for omitted scalar timestamps (${timestamps})`, () => {
      const out = boundAsrResult({ text: 'ok', timestamps })
      assert.deepEqual(out.structured, {
        text: 'ok',
        timestamp_offset: 0,
        timestamp_limit: ASR_TIMESTAMP_DEFAULT_LIMIT,
        timestamps_omitted: true,
        timestamps_truncated: true,
        next_timestamp_offset: null,
      })
    })
  }

  it('omits unrecognized timestamp objects instead of echoing them', () => {
    const huge = { custom: 'x'.repeat(100) }
    const out = boundAsrResult({ text: 'ok', timestamps: huge })
    assert.equal(out.text, 'ok')
    assert.equal(out.structured.timestamps, undefined)
    assert.equal(out.structured.timestamps_omitted, true)
    assert.equal(out.structured.timestamps_truncated, true)
    assert.equal(out.structured.next_timestamp_offset, null)
  })
})
