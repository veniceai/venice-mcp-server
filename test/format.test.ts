import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolError, truncate } from '../src/format.js'
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
