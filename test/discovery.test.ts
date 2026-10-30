import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { StubClient } from './helpers/stub-client.js'

async function connect(t: TestContext, env: Record<string, string> = {}): Promise<Client> {
  const server = buildServer({
    config: loadConfig({ VENICE_API_KEY: 'test-key', ...env }),
    client: new StubClient().asClient(),
  })
  const client = new Client({ name: 'discovery-test', version: '1.0.0' })
  t.after(async () => {
    await client.close()
    await server.close()
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return client
}

describe('server discovery', () => {
  it('points the instructions at the MCP guide', async (t) => {
    const client = await connect(t)
    assert.match(
      client.getInstructions() ?? '',
      /See https:\/\/docs\.venice\.ai\/guides\/integrations\/venice-mcp for full reference\./,
    )
  })

  it('calls the inference uncensored by default', async (t) => {
    const client = await connect(t)
    assert.match(client.getInstructions() ?? '', /exposes uncensored, privacy-respecting AI inference/)
  })

  it('drops "uncensored" from the instructions when VENICE_DISABLE_NSFW=1', async (t) => {
    const client = await connect(t, { VENICE_DISABLE_NSFW: '1' })
    const instructions = client.getInstructions() ?? ''
    assert.match(instructions, /exposes privacy-respecting AI inference/)
    assert.doesNotMatch(instructions, /uncensored/i)
  })

  it('offers every prompt template by default', async (t) => {
    const client = await connect(t)
    const { prompts } = await client.listPrompts()
    assert.deepEqual(
      prompts.map((prompt) => prompt.name),
      ['uncensored-research', 'nsfw-creative-writing', 'image-style-explorer'],
    )
  })

  it('hides the NSFW prompt templates when VENICE_DISABLE_NSFW=1', async (t) => {
    const client = await connect(t, { VENICE_DISABLE_NSFW: '1' })
    const { prompts } = await client.listPrompts()
    assert.deepEqual(prompts.map((prompt) => prompt.name), ['image-style-explorer'])
  })
})
