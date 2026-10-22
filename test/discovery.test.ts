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
})
