import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnMcp, type McpAuth, type McpClient } from './e2e/mcp-stdio-client.js'
import { startMockVenice, type MockRoute } from './helpers/mock-venice-server.js'

// Synthetic, unsigned fixtures only. Never import the live runners or wallet helper.
const walletAddress = `0x${'1'.repeat(40)}`
const inheritedEnv = {
  VENICE_API_KEY: 'vk_inherited_fixture',
  VENICE_SIWX_TOKEN: 'siwx_inherited_fixture',
  VENICE_DEFAULT_CHAT_MODEL: 'inherited-model-fixture',
}

async function startMcp(t: TestContext, auth: McpAuth, routes: MockRoute[], env: NodeJS.ProcessEnv = {}) {
  const upstream = await startMockVenice(routes)
  let mcp: McpClient | undefined
  t.after(async () => {
    try {
      await mcp?.close()
    } finally {
      await upstream.close()
    }
  })
  mcp = spawnMcp(auth, {
    ...env,
    VENICE_TEST_BASE_URL: upstream.url,
    VENICE_MCP_HTTP: '0',
    VENICE_HTTP_TIMEOUT_MS: '2000',
  })
  await mcp.initialize()
  return { mcp, upstream }
}

describe('E2E auth isolation over spawned MCP stdio', { concurrency: false }, () => {
  let previous: NodeJS.ProcessEnv
  beforeEach(() => {
    previous = Object.fromEntries(
      Object.keys(inheritedEnv).map(key => [key, process.env[key]]),
    )
    Object.assign(process.env, inheritedEnv)
  })
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('wallet mode sends only its explicit SIWX token and preserves non-auth settings', async t => {
    const { mcp, upstream } = await startMcp(t, { mode: 'x402', siwxToken: 'siwx_selected_fixture' }, [
      {
        match: 'POST /v1/chat/completions',
        reply: { choices: [{ message: { content: 'local wallet response' } }] },
      },
    ])
    const result = await mcp.callTool('venice_chat', {
      messages: [{ role: 'user', content: 'local fixture' }],
    })
    assert.notEqual(result.isError, true)
    assert.equal(result.content[0].text, 'local wallet response')
    assert.equal(upstream.calls.length, 1)
    const [request] = upstream.calls
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers['sign-in-with-x'], 'siwx_selected_fixture')
    assert.equal((request.body as { model: string }).model, inheritedEnv.VENICE_DEFAULT_CHAT_MODEL)

    // An inherited key must not make an API-key-only comparison pass either.
    const apiKeyOnly = await mcp.callTool('venice_list_api_keys')
    assert.equal(apiKeyOnly.isError, true)
    assert.match(apiKeyOnly.content[0].text, /VENICE_API_KEY is required/)
    assert.equal(upstream.calls.length, 1)
    assert.equal(process.env.VENICE_API_KEY, inheritedEnv.VENICE_API_KEY)
    assert.equal(process.env.VENICE_SIWX_TOKEN, inheritedEnv.VENICE_SIWX_TOKEN)
  })

  it('API-key mode sends only its explicit key, including no inherited SIWX on wallet endpoints', async t => {
    const { mcp, upstream } = await startMcp(t, { mode: 'apikey', apiKey: 'vk_selected_fixture' }, [
      {
        match: 'POST /v1/chat/completions',
        reply: { choices: [{ message: { content: 'local API-key response' } }] },
      },
      {
        match: `GET /v1/x402/balance/${walletAddress}`,
        reply: { __status: 401, __body: { error: 'SIWX required by local fixture' } },
      },
    ])
    const result = await mcp.callTool('venice_chat', {
      messages: [{ role: 'user', content: 'local fixture' }],
    })
    assert.notEqual(result.isError, true)
    assert.equal(upstream.calls.length, 1)
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer vk_selected_fixture')
    assert.equal(upstream.calls[0].headers['sign-in-with-x'], undefined)

    // Default requests prefer the API key even if SIWX leaked into the child.
    // A SIWX-only route exposes that otherwise hidden contamination.
    const balance = await mcp.callTool('venice_x402_balance', { wallet_address: walletAddress })
    assert.equal(balance.isError, true)
    assert.equal(upstream.calls.length, 2)
    assert.equal(upstream.calls[1].path, `/v1/x402/balance/${walletAddress}`)
    assert.equal(upstream.calls[1].headers.authorization, undefined)
    assert.equal(upstream.calls[1].headers['sign-in-with-x'], undefined)
  })

  it('surfaces a mock wallet 402 instead of succeeding with the inherited API key', async t => {
    const { mcp, upstream } = await startMcp(t, { mode: 'x402', siwxToken: 'siwx_empty_fixture' }, [
      {
        match: 'POST /v1/chat/completions',
        reply: ({ headers }: { headers: Record<string, string> }) => headers.authorization
          ? { choices: [{ message: { content: 'wrong auth mode succeeded' } }] }
          : {
              __status: 402,
              __body: { reason: 'insufficient_balance', currentBalanceUsd: 0, minimumBalanceUsd: 0.01 },
            },
      },
    ])
    const result = await mcp.callTool('venice_chat', {
      messages: [{ role: 'user', content: 'local fixture' }],
    })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /402/)
    assert.match(result.content[0].text, /wallet credit is too low/)
    assert.match(result.content[0].text, /Current balance: +\$0\.0000/)
    assert.equal(upstream.calls.length, 1)
    assert.equal(upstream.calls[0].headers.authorization, undefined)
    assert.equal(upstream.calls[0].headers['sign-in-with-x'], 'siwx_empty_fixture')
  })

  for (const auth of [
    { mode: 'apikey', apiKey: 'vk_explicit_fixture' },
    { mode: 'x402', siwxToken: 'siwx_explicit_fixture' },
  ] satisfies McpAuth[]) {
    it(`${auth.mode} selection also overrides credentials supplied in the child environment`, async t => {
      const { mcp, upstream } = await startMcp(t, auth, [
        {
          match: 'POST /v1/chat/completions',
          reply: { choices: [{ message: { content: 'local override response' } }] },
        },
        {
          match: `GET /v1/x402/balance/${walletAddress}`,
          reply: { balance: 0 },
        },
      ], {
        VENICE_API_KEY: 'vk_environment_override',
        VENICE_SIWX_TOKEN: 'siwx_environment_override',
      })
      const result = await mcp.callTool('venice_chat', {
        messages: [{ role: 'user', content: 'local fixture' }],
      })
      assert.notEqual(result.isError, true)
      await mcp.callTool('venice_x402_balance', { wallet_address: walletAddress })
      assert.equal(upstream.calls.length, 2)
      assert.equal(upstream.calls[0].headers.authorization,
        auth.mode === 'apikey' ? `Bearer ${auth.apiKey}` : undefined)
      const expectedSiwx = auth.mode === 'x402' ? auth.siwxToken : undefined
      assert.equal(upstream.calls[0].headers['sign-in-with-x'], expectedSiwx)
      assert.equal(upstream.calls[1].headers['sign-in-with-x'], expectedSiwx)
      assert.equal(upstream.calls[1].headers.authorization, undefined)
    })
  }

  it('requires an explicit credential instead of falling back to the parent', () => {
    assert.throws(() => spawnMcp({ mode: 'apikey', apiKey: '' }), /explicit apikey credential/)
    assert.throws(() => spawnMcp({ mode: 'x402', siwxToken: '' }), /explicit x402 credential/)
  })
})
