import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { StubClient } from './helpers/stub-client.js'

describe('tool annotation protocol contracts', () => {
  for (const [name, media, contentType] of [
    ['venice_video_status', 'video', 'video/mp4'],
    ['venice_music_status', 'audio', 'audio/wav'],
  ] as const) {
    it(`${name} advertises deletion before any call and only deletes when requested`, async (t) => {
      const stub = new StubClient({
        [`/v1/${media}/retrieve`]: () => ({
          kind: 'binary',
          buffer: Buffer.from('mock-media-bytes'),
          contentType,
        }),
        [`/v1/${media}/complete`]: () => ({ success: true }),
      })
      const server = buildServer({
        config: loadConfig({ VENICE_API_KEY: 'test-key' }),
        client: stub.asClient(),
      })
      const client = new Client({ name: 'annotation-test', version: '1.0.0' })
      t.after(async () => {
        await client.close()
        await server.close()
      })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      await client.connect(clientTransport)

      const { tools } = await client.listTools()
      const status = tools.find((tool) => tool.name === name)
      assert.deepEqual(status?.annotations, {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      })
      assert.equal(tools.find((tool) => tool.name === 'venice_text_parser')?.annotations?.openWorldHint, true)
      assert.equal(tools.find((tool) => tool.name === 'venice_chat')?.annotations?.openWorldHint, true)
      assert.equal(tools.find((tool) => tool.name === 'venice_chat_with_character')?.annotations?.openWorldHint, true)
      assert.equal(tools.find((tool) => tool.name === 'venice_list_models')?.annotations?.openWorldHint, false)
      assert.equal(stub.calls.length, 0, 'tool discovery must not call the provider')

      for (const deleteMedia of [undefined, false, true]) {
        const result = await client.callTool({
          name,
          arguments: {
            queue_id: 'mock-job',
            model: 'mock-model',
            ...(deleteMedia === undefined ? {} : { delete_media_on_completion: deleteMedia }),
          },
        })
        assert.equal(result.isError, undefined)
        const metadata = result.structuredContent
        assert.ok(metadata && typeof metadata === 'object' && 'server_media_deleted' in metadata)
        assert.equal(metadata.server_media_deleted, deleteMedia === true)
        assert.equal(stub.callsTo(`/v1/${media}/complete`).length, deleteMedia === true ? 1 : 0)
      }
    })
  }
})
