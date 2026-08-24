import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidEncryptedHex,
  modelSupportsE2ee,
  validateE2eeChatRequest,
  validateE2eeSseContent,
} from '../src/e2ee.js'

const ciphertext = 'ab'.repeat(93)

describe('E2EE contract helpers', () => {
  it('accepts Venice-sized hex ciphertext and rejects plaintext', () => {
    assert.equal(isValidEncryptedHex(ciphertext), true)
    assert.equal(isValidEncryptedHex('deadbeef'), false)
    assert.equal(isValidEncryptedHex('hello'), false)
    assert.equal(isValidEncryptedHex('ab'.repeat(92)), false)
  })

  it('requires catalog supportsE2EE and rejects the default chat model', () => {
    const catalog = {
      data: [
        { id: 'deepseek-v4-flash-0731', type: 'text' },
        { id: 'e2ee-qwen3-5-122b-a10b', model_spec: { capabilities: { supportsE2EE: true } } },
      ],
    }
    assert.equal(modelSupportsE2ee('e2ee-qwen3-5-122b-a10b', catalog), true)
    assert.equal(modelSupportsE2ee('deepseek-v4-flash-0731', catalog), false)
    assert.equal(modelSupportsE2ee('e2ee-qwen3-5-122b-a10b', { data: [] }), false)
  })

  it('rejects missing models, plaintext, files, tools, and web features', () => {
    assert.match(
      validateE2eeChatRequest({
        messages: [{ role: 'user', content: ciphertext }],
        venice_parameters: { enable_web_search: 'off' },
      }) ?? '',
      /explicit E2EE-capable model/,
    )
    assert.match(
      validateE2eeChatRequest({
        model: 'e2ee-qwen3-5-122b-a10b',
        messages: [{ role: 'user', content: 'plaintext' }],
      }) ?? '',
      /encrypted hex ciphertext/,
    )
    assert.match(
      validateE2eeChatRequest({
        model: 'e2ee-qwen3-5-122b-a10b',
        messages: [{ role: 'user', content: ciphertext }],
        tools: [{ type: 'function', function: { name: 'lookup' } }],
      }) ?? '',
      /function calling/,
    )
    assert.match(
      validateE2eeChatRequest({
        model: 'e2ee-qwen3-5-122b-a10b',
        messages: [{ role: 'user', content: ciphertext }],
        venice_parameters: { enable_web_search: 'on' },
      }) ?? '',
      /web search/,
    )
    assert.equal(
      validateE2eeChatRequest({
        model: 'e2ee-qwen3-5-122b-a10b',
        messages: [{ role: 'user', content: ciphertext }],
        venice_parameters: { enable_web_search: 'off' },
      }),
      undefined,
    )
  })

  it('rejects SSE content that is not valid ciphertext', () => {
    assert.match(
      validateE2eeSseContent(['{"choices":[{"delta":{"content":"plaintext"}}]}', '[DONE]']) ?? '',
      /plaintext or invalid ciphertext/,
    )
    assert.equal(
      validateE2eeSseContent([`{"choices":[{"delta":{"content":"${ciphertext}"}}]}`, '[DONE]']),
      undefined,
    )
  })
})
