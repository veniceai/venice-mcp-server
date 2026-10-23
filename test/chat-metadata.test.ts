import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { buildTools, type ToolResult } from '../src/tools/index.js'
import { StubClient } from './helpers/stub-client.js'

const cfg = loadConfig({ VENICE_DEFAULT_CHAT_MODEL: 'configured-model-alias' })
const messages = [{ role: 'user', content: 'Hello' }]
const chatTools = ['venice_chat', 'venice_chat_with_character'] as const
const teeHeaders = { '/v1/chat/completions': { 'x-venice-tee': 'true' } }

function caller(stub: StubClient) {
  const tools = buildTools(stub.asClient(), cfg)
  return (name: string, args: unknown) => {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.ok(tool, `Missing tool: ${name}`)
    return tool.handler(z.object(tool.inputSchema).parse(args))
  }
}

function textAt(result: ToolResult, index = 0): string {
  const block = result.content[index]
  assert.ok(block && block.type === 'text')
  return block.text
}

describe('chat completion metadata', () => {
  for (const name of chatTools) {
    for (const source of ['structured', 'text'] as const) {
      for (const model of [undefined, 'requested-model-alias']) {
        it(`${name}: ${source} metadata drives the signature request with ${model ? 'an explicit' : 'the default'} model`, async () => {
          let issued: { id: string; model: string } | undefined
          const message = { role: 'assistant', content: 'Hello from the enclave.' }
          const usage = { prompt_tokens: 3, completion_tokens: 5 }
          const stub = new StubClient({
            '/v1/chat/completions': () => {
              issued = { id: `chatcmpl-${randomUUID()}+/=?&`, model: 'tee-provider/actual-model+v2' }
              return { ...issued, choices: [{ message }], usage }
            },
            '/v1/tee/signature?': (call) => {
              assert.ok(issued, 'A chat completion must precede the signature request')
              const params = new URLSearchParams(call.path.split('?')[1])
              assert.equal(params.get('request_id'), issued.id)
              assert.equal(params.get('model'), issued.model)
              assert.equal(call.auth, 'none')
              return { signature: 'mock-signature', request_id: params.get('request_id') }
            },
          }, teeHeaders)
          const call = caller(stub)
          const result = await call(name, { messages, character_slug: 'test-character', model })
          assert.equal(result.isError, undefined)
          assert.equal(textAt(result), message.content)
          assert.deepEqual(result.structuredContent?.usage, usage)
          if (name === 'venice_chat') assert.deepEqual(result.structuredContent?.message, message)

          // Use only the tool result to construct the signature request, just as an MCP client does.
          const metadata = source === 'structured' ? result.structuredContent : JSON.parse(textAt(result, 1))
          assert.equal(typeof metadata?.id, 'string')
          assert.equal(typeof metadata?.model, 'string')
          const signature = await call('venice_tee_signature', {
            request_id: metadata.id,
            model: metadata.model,
          })
          assert.equal(signature.isError, undefined)
          assert.equal(signature.structuredContent?.signature, 'mock-signature')
          assert.equal(signature.structuredContent?.request_id, metadata.id)
          assert.deepEqual(JSON.parse(textAt(result, 1)), issued)
          assert.equal(result.structuredContent?.id, issued?.id)
          assert.equal(result.structuredContent?.model, issued?.model)
          assert.equal(result.content.length, 2)
          assert.equal(stub.calls.length, 2)
          const request = stub.calls[0].body as Record<string, unknown>
          assert.equal(request.model, model ?? cfg.defaultChatModel)
          assert.equal(request.stream, false)
          if (name === 'venice_chat_with_character') {
            assert.deepEqual(request.venice_parameters, { character_slug: 'test-character' })
          }
        })
      }
    }

    it(`${name}: does not infer TEE from model names or the response body`, async () => {
      const metadata = { id: 'upstream-id', model: 'e2ee-tee-model' }
      const message = { role: 'assistant', content: 'An ordinary reply.' }
      const call = caller(new StubClient({
        '/v1/chat/completions': () => ({
          ...metadata,
          choices: [{ message }],
          tee: true,
          headers: { 'X-Venice-TEE': 'true' },
        }),
      }))
      const result = await call(name, { messages, character_slug: 'test-character', model: 'e2ee-tee-model' })
      assert.deepEqual(result.content, [{ type: 'text', text: message.content }])
      assert.equal(result.structuredContent?.id, metadata.id)
      assert.equal(result.structuredContent?.model, metadata.model)
    })

    for (const tee of [false, true]) {
      it(`${name}: metadata survives text truncation without changing the first block (TEE=${tee})`, async () => {
        const metadata = { id: `chatcmpl-${randomUUID()}`, model: 'actual-model' }
        const message = { role: 'assistant', content: 'x'.repeat(9000) }
        const call = caller(new StubClient({
          '/v1/chat/completions': () => ({ ...metadata, choices: [{ message }] }),
        }, tee ? teeHeaders : {}))
        const result = await call(name, { messages, character_slug: 'test-character' })
        assert.equal(textAt(result), `${'x'.repeat(8000)}\n…[truncated 1000 chars]`)
        assert.equal(result.content.length, tee ? 2 : 1)
        if (tee) assert.deepEqual(JSON.parse(textAt(result, 1)), metadata)
        assert.equal(result.structuredContent?.id, metadata.id)
        assert.equal(result.structuredContent?.model, metadata.model)
        // Truncation must be visible without parsing the inline marker.
        assert.equal(result.structuredContent?.truncated, true)
        assert.equal(result.structuredContent?.omitted_chars, 1000)
        if (name === 'venice_chat') assert.deepEqual(result.structuredContent?.message, message)
      })

      for (const metadata of [{}, { id: 'upstream-id-only' }, { model: 'upstream-model-only' }]) {
        it(`${name}: does not fabricate missing metadata when upstream returns ${JSON.stringify(metadata)} (TEE=${tee})`, async () => {
          const call = caller(new StubClient({
            '/v1/chat/completions': () => ({ ...metadata, choices: [{ message: { content: '' } }] }),
          }, tee ? teeHeaders : {}))
          const result = await call(name, { messages, character_slug: 'test-character', model: 'requested-alias' })
          assert.equal(result.isError, undefined)
          assert.equal(textAt(result), '')
          for (const key of ['id', 'model']) {
            assert.equal(Object.hasOwn(result.structuredContent!, key), Object.hasOwn(metadata, key))
          }
          if (tee && Object.keys(metadata).length > 0) {
            assert.deepEqual(JSON.parse(textAt(result, 1)), metadata)
            assert.equal(result.content.length, 2)
          } else {
            assert.equal(result.content.length, 1)
          }
        })
      }
    }

    it(`${name}: leaves upstream failures as errors without completion metadata`, async () => {
      const call = caller(new StubClient({
        '/v1/chat/completions': () => { throw new Error('Mock completion failed') },
      }))
      const result = await call(name, { messages, character_slug: 'test-character' })
      assert.equal(result.isError, true)
      assert.match(textAt(result), /Mock completion failed/)
      assert.equal(result.content.length, 1)
      assert.equal(result.structuredContent, undefined)
    })
  }

  for (const tee of [false, true]) {
    it(`preserves tool-call JSON and thought signatures in the first chat block (TEE=${tee})`, async () => {
      const metadata = { id: `chatcmpl-${randomUUID()}`, model: 'actual-model' }
      const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_lookup',
          type: 'function',
          thought_signature: 'mock-thought-signature+/=',
          function: { name: 'lookup', arguments: '{}' },
        }],
      }
      const call = caller(new StubClient({
        '/v1/chat/completions': () => ({ ...metadata, choices: [{ message }] }),
      }, tee ? teeHeaders : {}))
      const result = await call('venice_chat', { messages })
      assert.equal(textAt(result), JSON.stringify(message, null, 2))
      assert.deepEqual(result.structuredContent?.message, message)
      assert.equal(result.content.length, tee ? 2 : 1)
      if (tee) assert.deepEqual(JSON.parse(textAt(result, 1)), metadata)
    })

    it(`preserves each chat tool's first-block fallback when the completion has no message (TEE=${tee})`, async () => {
      const response = { id: `chatcmpl-${randomUUID()}`, model: 'actual-model', choices: [] }
      const call = caller(new StubClient({ '/v1/chat/completions': () => response }, tee ? teeHeaders : {}))
      const chat = await call('venice_chat', { messages })
      const character = await call('venice_chat_with_character', { messages, character_slug: 'test-character' })
      assert.equal(textAt(chat), JSON.stringify(response, null, 2))
      assert.equal(textAt(character), '')
      for (const result of [chat, character]) {
        assert.equal(result.structuredContent?.id, response.id)
        assert.equal(result.structuredContent?.model, response.model)
        assert.equal(result.content.length, tee ? 2 : 1)
        if (tee) assert.deepEqual(JSON.parse(textAt(result, 1)), { id: response.id, model: response.model })
      }
    })
  }
})
