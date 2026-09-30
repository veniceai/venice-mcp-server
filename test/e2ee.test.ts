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
    assert.match(
      validateE2eeChatRequest({
        model: 'e2ee-qwen3-5-122b-a10b',
        messages: [{ role: 'user', content: ciphertext }],
        venice_parameters: { character_slug: 'alice' },
      }) ?? '',
      /character/,
    )
    assert.match(
      validateE2eeChatRequest({
        model: 'e2ee-qwen3-5-122b-a10b',
        messages: [{ role: 'assistant', content: null, reasoning_content: 'plaintext chain of thought' }],
      }) ?? '',
      /reasoning_content/,
    )
  })

  it('allowlists top-level request fields and rejects anything that would carry plaintext', () => {
    const base = {
      model: 'e2ee-qwen3-5-122b-a10b',
      messages: [{ role: 'user', content: ciphertext }],
      venice_parameters: { enable_e2ee: true },
    }
    assert.equal(
      validateE2eeChatRequest({
        ...base,
        temperature: 0.5,
        top_p: 0.9,
        max_tokens: 10,
        max_completion_tokens: 20,
        e2ee_headers: {},
        timeout_ms: 120_000,
      }),
      undefined,
    )
    const leaking: Array<[string, unknown]> = [
      ['stop', ['PLAIN STOP']],
      ['stop', 'PLAIN STOP'],
      ['prompt_cache_key', 'user-alice@example.com'],
      ['prompt_cache_retention', '24h'],
      ['verbosity', 'high'],
      ['reasoning', { effort: 'high' }],
      ['reasoning_effort', 'high'],
      ['anything_else', 'x'],
    ]
    for (const [key, value] of leaking) {
      const error = validateE2eeChatRequest({ ...base, [key]: value })
      assert.match(error ?? '', new RegExp(`does not allow "${key}"`), `expected rejection for ${key}`)
      assert.doesNotMatch(error ?? '', /PLAIN STOP|alice/)
    }
  })

  it('allows only the fixed E2EE venice_parameters values', () => {
    const base = { model: 'e2ee-qwen3-5-122b-a10b', messages: [{ role: 'user', content: ciphertext }] }
    assert.equal(
      validateE2eeChatRequest({
        ...base,
        venice_parameters: {
          enable_e2ee: true,
          enable_web_search: 'off',
          enable_web_citations: false,
          include_venice_system_prompt: false,
        },
      } as never),
      undefined,
    )
    for (const venice_parameters of [
      { enable_e2ee: true, strip_thinking_response: true },
      { enable_e2ee: true, disable_thinking: true },
      { enable_e2ee: true, enable_web_search: 'auto' },
    ]) {
      assert.match(
        validateE2eeChatRequest({ ...base, venice_parameters } as never) ?? '',
        /E2EE does not (allow|support)/,
        JSON.stringify(venice_parameters),
      )
    }
  })

  it('allows only role and content on E2EE messages', () => {
    const request = (message: Record<string, unknown>) =>
      validateE2eeChatRequest({ model: 'e2ee-qwen3-5-122b-a10b', messages: [message] })
    assert.equal(request({ role: 'user', content: ciphertext }), undefined)
    assert.equal(request({ role: 'assistant', content: ciphertext }), undefined)
    for (const extra of [
      { name: 'alice-plaintext' },
      { thought_signature: 'sig' },
      { cache_control: { type: 'ephemeral' } },
      { tool_call_id: 'call_1' },
    ]) {
      const error = request({ role: 'user', content: ciphertext, ...extra })
      assert.match(error ?? '', /may only contain role and content/, JSON.stringify(extra))
      assert.doesNotMatch(error ?? '', /alice-plaintext/)
    }
    assert.match(request({ role: 'assistant', content: ciphertext, name: 'bob' }) ?? '', /role and content/)
    assert.match(request({ role: 'critic', content: ciphertext }) ?? '', /must use the user, system, developer, or assistant role/)
  })

  it('rejects every response_format variant so no schema leaves the trust boundary as plaintext', () => {
    const responseFormats = [
      {
        type: 'json_schema',
        json_schema: {
          name: 'confidential_extraction',
          schema: {
            type: 'object',
            properties: { finding: { type: 'string', description: 'canary-do-not-forward' } },
          },
        },
      },
      { type: 'json_object' },
      { type: 'text' },
    ]
    for (const response_format of responseFormats) {
      assert.match(
        validateE2eeChatRequest({
          model: 'e2ee-qwen3-5-122b-a10b',
          messages: [{ role: 'user', content: ciphertext }],
          response_format,
        }) ?? '',
        /does not support structured output/,
        `expected rejection for response_format.type=${response_format.type}`,
      )
    }
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
    assert.match(
      validateE2eeSseContent([`{"choices":[{"delta":{"content":["hello"]}}]}`, '[DONE]']) ?? '',
      /plaintext or invalid ciphertext/,
    )
    assert.match(
      validateE2eeSseContent([
        `{"choices":[{"delta":{"content":"${ciphertext}","reasoning_content":"secret thoughts"}}]}`,
        '[DONE]',
      ]) ?? '',
      /plaintext or invalid ciphertext/,
    )
    assert.match(
      validateE2eeSseContent(['this is plaintext leaked', '[DONE]']) ?? '',
      /non-JSON data event/,
    )
  })

  it('accepts documented chunk metadata around ciphertext deltas', () => {
    const meta = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'e2ee-qwen3-5-122b-a10b' }
    const events = [
      { ...meta, system_fingerprint: null, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null, logprobs: null }] },
      { ...meta, choices: [{ index: 0, delta: { content: ciphertext, reasoning_content: ciphertext } }] },
      { ...meta, choices: [{ index: 0, delta: {}, finish_reason: 'stop', stop_reason: null }] },
      {
        ...meta,
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } },
        cost: { usd: 0.001, diem: 0 },
        venice_parameters: { enable_e2ee: true, enable_web_search: 'off', web_search_citations: [] },
      },
    ].map((event) => JSON.stringify(event))
    assert.equal(validateE2eeSseContent([...events, '[DONE]']), undefined)
  })

  it('rejects chunk fields outside the allowlist instead of labelling them encrypted', () => {
    const cases: Array<[string, unknown]> = [
      ['leak', { leak: 'plaintext secret', choices: [] }],
      ['choices[].delta.refusal', { choices: [{ delta: { refusal: 'I cannot help with that' } }] }],
      ['choices[].delta.tool_calls', {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '{"secret":1}' } }] } }],
      }],
      ['choices[].delta.reasoning', { choices: [{ delta: { reasoning: 'thinking out loud' } }] }],
      ['choices[].message', { choices: [{ message: { content: ciphertext } }] }],
      ['choices[].logprobs', { choices: [{ delta: { content: ciphertext }, logprobs: { content: [{ token: 'hi' }] } }] }],
      ['choices[].finish_reason', { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
      ['choices[].stop_reason', { choices: [{ delta: {}, stop_reason: 'PLAIN STOP' }] }],
      ['usage', { choices: [], usage: { note: 'text' } }],
      ['venice_parameters', {
        choices: [],
        venice_parameters: { web_search_citations: [{ title: 'leak', url: 'https://example.com' }] },
      }],
      ['model', { model: { name: 'x' }, choices: [] }],
    ]
    for (const [field, event] of cases) {
      assert.match(
        validateE2eeSseContent([JSON.stringify(event), '[DONE]']) ?? '',
        new RegExp(`unexpected field "${field.replace(/[[\]().]/g, '\\$&')}"`),
        field,
      )
    }
    assert.match(validateE2eeSseContent(['42', '[DONE]']) ?? '', /plaintext or invalid ciphertext/)
  })
})
