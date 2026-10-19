import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

describe('chat metadata over MCP stdio and upstream HTTP', () => {
  let upstream: MockVeniceServer
  let client: Client
  let teeHeader: string | undefined
  const metadata = { id: 'chatcmpl-local+/=?&', model: 'provider/actual-model+v2' }
  const message = { role: 'assistant', content: 'Hello.\nAn unchanged answer ✓' }
  const usage = { prompt_tokens: 3, completion_tokens: 5 }

  before(async () => {
    upstream = await startMockVenice([
      {
        match: 'POST /v1/chat/completions',
        reply: () => ({
          __status: 200,
          __headers: teeHeader === undefined ? {} : { 'X-Venice-TEE': teeHeader },
          __body: { ...metadata, choices: [{ message }], usage },
        }),
      },
      {
        match: 'GET /v1/tee/signature*',
        reply: ({ path }: { path: string }) => {
          const params = new URL(path, 'http://fixture').searchParams
          return {
            request_id: params.get('request_id'),
            model: params.get('model'),
            signature: 'local-fixture-signature',
          }
        },
      },
    ])
    client = new Client({ name: 'chat-metadata-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      env: {
        VENICE_TEST_BASE_URL: upstream.url,
        VENICE_API_KEY: 'vk_local_fixture',
        VENICE_DEFAULT_CHAT_MODEL: 'configured-model-alias',
      },
      stderr: 'pipe',
    }))
  })

  after(async () => {
    await client?.close()
    await upstream?.close()
  })

  for (const name of ['venice_chat', 'venice_chat_with_character']) {
    for (const header of [undefined, 'true', 'false', 'TRUE', '1', 'true, false']) {
      it(`${name}: X-Venice-TEE=${header ?? '(absent)'}`, async (t) => {
        teeHeader = header
        const result = CallToolResultSchema.parse(await client.callTool({
          name,
          arguments: {
            messages: [{ role: 'user', content: 'Hello' }],
            character_slug: 'test-character',
          },
        }))
        if (header === undefined || header === 'true') {
          t.diagnostic(JSON.stringify({ tool: name, teeHeader: header ?? null, result }))
        }
        assert.equal(result.isError, undefined)
        assert.deepEqual(result.structuredContent, {
          ...metadata,
          ...(name === 'venice_chat' ? { message } : {}),
          usage,
        })
        const chatRequest = upstream.calls.at(-1)
        assert.equal(chatRequest?.headers.authorization, 'Bearer vk_local_fixture')
        assert.equal((chatRequest?.body as { model: string }).model, 'configured-model-alias')
        assert.equal((chatRequest?.body as { stream: boolean }).stream, false)
        assert.deepEqual(result.content[0], { type: 'text', text: message.content })

        if (header !== 'true') {
          // A text-only host consumes every block, not just content[0].
          assert.deepEqual(result.content, [{ type: 'text', text: message.content }])
          return
        }

        assert.equal(result.content.length, 2)
        const fallback = result.content[1]
        assert.ok(fallback.type === 'text')
        const signatureArgs = JSON.parse(fallback.text)
        assert.deepEqual(signatureArgs, metadata)
        const signature = CallToolResultSchema.parse(await client.callTool({
          name: 'venice_tee_signature',
          arguments: { request_id: signatureArgs.id, model: signatureArgs.model },
        }))
        assert.equal(signature.isError, undefined)
        assert.deepEqual(signature.structuredContent, {
          request_id: metadata.id,
          model: metadata.model,
          signature: 'local-fixture-signature',
        })
        assert.equal(upstream.calls.at(-1)?.headers.authorization, undefined)
      })
    }
  }
})
