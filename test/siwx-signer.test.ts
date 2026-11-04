import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { loadConfig } from '../src/config.js'
import { formatToolError } from '../src/format.js'
import { MAX_SIGNER_OUTPUT_BYTES, runSiwxSigner, SiwxSignerError } from '../src/siwx-signer.js'
import { VeniceUpstreamError } from '../src/types.js'
import { VeniceClient } from '../src/venice-client.js'
import { spawnMcp, type McpClient } from './e2e/mcp-stdio-client.js'
import { startMockVenice, type MockVeniceServer } from './helpers/mock-venice-server.js'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXAMPLE_SIGNER = path.join(REPO_ROOT, 'examples/siwx-signer.mjs')
const q = (value: string) => JSON.stringify(value)
const NODE = q(process.execPath)

let scratch: string

/** Write a small Node script and return a shell command that runs it. */
function nodeCommand(name: string, source: string): string {
  const file = path.join(scratch, name)
  writeFileSync(file, source)
  return `${NODE} ${q(file)}`
}

/** A signer that counts its runs and prints `signed-<n>`. */
function countingSigner(): { command: string; runs: () => number } {
  const counter = path.join(scratch, `count-${randomBytes(4).toString('hex')}`)
  const command = nodeCommand(
    `counting-${randomBytes(4).toString('hex')}.mjs`,
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const file = ${q(counter)}
const n = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1
writeFileSync(file, String(n))
process.stdout.write('signed-' + n + '\\n')
`,
  )
  return {
    command,
    runs: () => {
      try {
        return Number(readFileSync(counter, 'utf8'))
      } catch {
        return 0
      }
    },
  }
}

before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'venice-siwx-signer-'))
})

after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('runSiwxSigner', () => {
  const request = { method: 'GET', path: '/v1/x402/balance/0xabc', baseUrl: 'http://127.0.0.1:1/api' }

  it('returns trimmed stdout and passes request context, but not credentials, to the command', async () => {
    const command = nodeCommand(
      'env-echo.mjs',
      `const e = process.env
process.stdout.write('  ' + Buffer.from(JSON.stringify({
  base: e.VENICE_SIWX_BASE_URL, method: e.VENICE_SIWX_REQUEST_METHOD, path: e.VENICE_SIWX_REQUEST_PATH,
  key: e.VENICE_API_KEY ?? null, token: e.VENICE_SIWX_TOKEN ?? null, cmd: e.VENICE_SIWX_SIGNER_COMMAND ?? null,
  mcpToken: e.VENICE_MCP_AUTH_TOKEN ?? null,
  other: e.SIGNER_FIXTURE ?? null,
})).toString('base64') + '\\n\\n')
`,
    )
    const value = await runSiwxSigner(command, request, {
      timeoutMs: 10_000,
      env: {
        ...process.env,
        VENICE_API_KEY: 'vk_must_not_leak',
        VENICE_SIWX_TOKEN: 'siwx_must_not_leak',
        VENICE_SIWX_SIGNER_COMMAND: command,
        VENICE_MCP_AUTH_TOKEN: 'http_bearer_must_not_leak',
        SIGNER_FIXTURE: 'kept',
      },
    })
    assert.deepEqual(JSON.parse(Buffer.from(value, 'base64').toString('utf8')), {
      base: request.baseUrl,
      method: 'GET',
      path: request.path,
      key: null,
      token: null,
      cmd: null,
      mcpToken: null,
      other: 'kept',
    })
  })

  it('reports a non-zero exit with the last stderr line', async () => {
    const command = nodeCommand(
      'exit-2.mjs',
      `process.stdout.write('partial'); process.stderr.write('debug noise\\nwallet locked\\n'); process.exit(2)`,
    )
    await assert.rejects(runSiwxSigner(command, request, { timeoutMs: 10_000 }), (err: Error) => {
      assert.ok(err instanceof SiwxSignerError)
      assert.equal(err.message, 'SIWX signer command exited with code 2: wallet locked. No request was sent to Venice.')
      return true
    })
  })

  it('reports a command that does not exist', async () => {
    await assert.rejects(
      runSiwxSigner(q(path.join(scratch, 'no-such-signer')), request, { timeoutMs: 10_000 }),
      (err: Error) => err instanceof SiwxSignerError && /exited with code \d+/.test(err.message),
    )
  })

  it('rejects empty output', async () => {
    const command = nodeCommand('empty.mjs', `process.stdout.write(' \\n')`)
    await assert.rejects(runSiwxSigner(command, request, { timeoutMs: 10_000 }), /printed nothing/)
  })

  it('rejects multi-line or non-ASCII output instead of sending it as a header', async () => {
    for (const [name, out] of [
      ['two-lines.mjs', 'aaa\\nbbb'],
      ['carriage-return.mjs', 'aaa\\rInjected: 1'],
      ['non-ascii.mjs', 'caf\\u00e9'],
    ]) {
      const command = nodeCommand(name, `process.stdout.write('${out}')`)
      await assert.rejects(
        runSiwxSigner(command, request, { timeoutMs: 10_000 }),
        /not a single line of printable ASCII/,
        name,
      )
    }
  })

  it('rejects output larger than the cap', async () => {
    const command = nodeCommand('huge.mjs', `process.stdout.write('a'.repeat(${MAX_SIGNER_OUTPUT_BYTES + 1}))`)
    await assert.rejects(runSiwxSigner(command, request, { timeoutMs: 10_000 }), /printed more than 65536 bytes/)
  })

  it('times out a signer that hangs', async () => {
    const command = nodeCommand('hang.mjs', `setTimeout(() => {}, 60_000)`)
    const started = Date.now()
    await assert.rejects(runSiwxSigner(command, request, { timeoutMs: 300 }), /timed out after 300ms/)
    assert.ok(Date.now() - started < 5_000)
  })
})

describe('VeniceClient with VENICE_SIWX_SIGNER_COMMAND', () => {
  let server: MockVeniceServer

  before(async () => {
    const echo = ({ headers }: { headers: Record<string, string> }) =>
      headers['sign-in-with-x']
        ? { siwx: headers['sign-in-with-x'], authorization: headers.authorization ?? null }
        : { __status: 401, __body: { error: 'no auth' } }
    server = await startMockVenice([
      { match: 'POST /v1/needs-siwx', reply: echo },
      { match: 'GET /v1/x402/balance/*', reply: echo },
      { match: 'POST /v1/multipart', reply: echo },
      { match: 'POST /v1/binary', reply: echo },
      { match: 'POST /v1/used-up', reply: { __status: 401, __body: { error: 'Invalid Sign-in-with-x signature' } } },
    ])
  })

  after(async () => {
    if (server) await server.close()
  })

  const cfg = (env: NodeJS.ProcessEnv) => ({ ...loadConfig(env), baseUrl: server.url })

  it('signs a fresh header for every request', async () => {
    const signer = countingSigner()
    const client = new VeniceClient(cfg({ VENICE_SIWX_SIGNER_COMMAND: signer.command }))
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      seen.push((await client.post<{ siwx: string }>('/v1/needs-siwx', {})).siwx)
    }
    assert.deepEqual(seen, ['signed-1', 'signed-2', 'signed-3'])
    assert.equal(signer.runs(), 3)
  })

  it('signs SIWX-only, multipart and binary requests', async () => {
    const signer = countingSigner()
    const client = new VeniceClient(cfg({ VENICE_SIWX_SIGNER_COMMAND: signer.command }))

    const balance = await client.get<{ siwx: string }>('/v1/x402/balance/0xabc', undefined, { auth: 'siwx' })
    const form = new FormData()
    form.set('file', new Blob(['x']), 'x.txt')
    const multipart = await client.postMultipart<{ siwx: string }>('/v1/multipart', form)
    const binary = await client.postBinary('/v1/binary', { json: {} })

    assert.equal(balance.siwx, 'signed-1')
    assert.equal(multipart.siwx, 'signed-2')
    assert.equal(JSON.parse(binary.buffer.toString('utf8')).siwx, 'signed-3')
  })

  it('takes precedence over a static VENICE_SIWX_TOKEN', async () => {
    const signer = countingSigner()
    const client = new VeniceClient(
      cfg({ VENICE_SIWX_SIGNER_COMMAND: signer.command, VENICE_SIWX_TOKEN: 'static_token' }),
    )
    assert.equal((await client.post<{ siwx: string }>('/v1/needs-siwx', {})).siwx, 'signed-1')
  })

  it('does not run the signer when an API key handles the request', async () => {
    const signer = countingSigner()
    const client = new VeniceClient(cfg({ VENICE_SIWX_SIGNER_COMMAND: signer.command, VENICE_API_KEY: 'vk_abc' }))
    await assert.rejects(client.post('/v1/needs-siwx', {}), (err: unknown) => {
      return err instanceof VeniceUpstreamError && err.status === 401
    })
    assert.equal(signer.runs(), 0)

    // SIWX-only routes still sign, and never forward the API key.
    const balance = await client.get<{ siwx: string; authorization: string | null }>(
      '/v1/x402/balance/0xabc',
      undefined,
      { auth: 'siwx' },
    )
    assert.deepEqual(balance, { siwx: 'signed-1', authorization: null })
  })

  it('fails locally without contacting Venice when the signer fails', async () => {
    const before = server.calls.length
    const command = nodeCommand('fails.mjs', `process.stderr.write('hardware wallet not connected'); process.exit(1)`)
    const client = new VeniceClient(cfg({ VENICE_SIWX_SIGNER_COMMAND: command }))
    for (const call of [
      () => client.post('/v1/needs-siwx', {}),
      () => client.postMultipart('/v1/multipart', new FormData()),
      () => client.postBinary('/v1/binary', { json: {} }),
    ]) {
      await assert.rejects(call(), (err: unknown) => {
        assert.ok(err instanceof SiwxSignerError)
        assert.equal(
          formatToolError(err),
          'Error: SIWX signer command exited with code 1: hardware wallet not connected. No request was sent to Venice.',
        )
        return true
      })
    }
    assert.equal(server.calls.length, before)
  })

  it('explains a 401 on a static token as a used or expired token', async () => {
    const staticClient = new VeniceClient(cfg({ VENICE_SIWX_TOKEN: 'used_token' }))
    await assert.rejects(staticClient.post('/v1/used-up', {}), (err: unknown) => {
      assert.ok(err instanceof VeniceUpstreamError)
      assert.equal(err.siwxSource, 'token')
      assert.match(formatToolError(err), /^Venice API error 401: upstream request failed\. VENICE_SIWX_TOKEN covers one request/)
      assert.match(formatToolError(err), /Set VENICE_SIWX_SIGNER_COMMAND/)
      return true
    })

    const signer = countingSigner()
    const signerClient = new VeniceClient(cfg({ VENICE_SIWX_SIGNER_COMMAND: signer.command }))
    await assert.rejects(signerClient.post('/v1/used-up', {}), (err: unknown) => {
      assert.ok(err instanceof VeniceUpstreamError)
      assert.equal(err.siwxSource, 'signer')
      assert.equal(formatToolError(err), 'Venice API error 401: upstream request failed.')
      return true
    })
  })

  it('loads the signer settings from the environment', () => {
    const loaded = loadConfig({ VENICE_SIWX_SIGNER_COMMAND: '  node signer.mjs ', VENICE_SIWX_SIGNER_TIMEOUT_MS: '2500' })
    assert.equal(loaded.siwxSignerCommand, 'node signer.mjs')
    assert.equal(loaded.siwxSignerTimeoutMs, 2500)
    const defaults = loadConfig({ VENICE_SIWX_SIGNER_COMMAND: '   ', VENICE_SIWX_SIGNER_TIMEOUT_MS: '-1' })
    assert.equal(defaults.siwxSignerCommand, undefined)
    assert.equal(defaults.siwxSignerTimeoutMs, 15_000)
  })
})

/**
 * A local stand-in for Venice's wallet auth: unauthenticated calls get a 402
 * with a fresh SIWE challenge, and an authenticated call must carry a valid
 * EIP-191 signature over a message whose nonce was issued, is unexpired, and
 * has not been used before. Reuse returns 401, as Venice does.
 */
async function startSingleUseSiwxVenice(): Promise<MockVeniceServer> {
  const issued = new Map<string, number>()
  const used = new Set<string>()
  const CHALLENGE_TTL_MS = 5 * 60_000
  const rejected = { __status: 401, __body: { error: 'Invalid Sign-in-with-x signature' } }

  const route = async ({ path: reqPath, headers }: { path: string; headers: Record<string, string> }) => {
    const wallet = decodeURIComponent(reqPath.split('/').at(-1)!.split('?')[0])
    const header = headers['sign-in-with-x']
    if (!header) {
      const nonce = randomBytes(16).toString('hex')
      const issuedAt = Date.now()
      issued.set(nonce, issuedAt)
      return {
        __status: 402,
        __body: {
          extensions: {
            'sign-in-with-x': {
              info: {
                domain: 'api.venice.ai',
                uri: 'https://api.venice.ai',
                version: '1',
                statement: 'Sign in to Venice AI',
                nonce,
                issuedAt: new Date(issuedAt).toISOString(),
                expirationTime: new Date(issuedAt + CHALLENGE_TTL_MS).toISOString(),
              },
            },
          },
        },
      }
    }
    let payload: { address: `0x${string}`; message: string; signature: `0x${string}` }
    try {
      payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    } catch {
      return rejected
    }
    const nonce = /^Nonce: (\S+)$/m.exec(payload.message)?.[1]
    const issuedAt = nonce ? issued.get(nonce) : undefined
    if (!nonce || issuedAt === undefined || used.has(nonce) || Date.now() - issuedAt > CHALLENGE_TTL_MS) return rejected
    if (payload.address.toLowerCase() !== wallet.toLowerCase()) return rejected
    if (!(await verifyMessage({ address: payload.address, message: payload.message, signature: payload.signature }))) {
      return rejected
    }
    used.add(nonce)
    return { walletAddress: wallet, balanceUsd: 1.5 }
  }

  return startMockVenice([{ match: 'GET /v1/x402/balance/*', reply: route }])
}

describe('wallet mode over MCP stdio against single-use SIWX challenges', () => {
  let venice: MockVeniceServer
  let keyFile: string
  let address: string
  const clients: McpClient[] = []

  before(async () => {
    venice = await startSingleUseSiwxVenice()
    const privateKey = generatePrivateKey()
    address = privateKeyToAccount(privateKey).address
    keyFile = path.join(scratch, 'wallet-key')
    writeFileSync(keyFile, `${privateKey}\n`, { mode: 0o600 })
  })

  after(async () => {
    for (const client of clients) await client.close()
    if (venice) await venice.close()
  })

  const env = () => ({
    VENICE_TEST_BASE_URL: venice.url,
    VENICE_SIWX_KEY_FILE: keyFile,
    VENICE_HTTP_TIMEOUT_MS: '5000',
  })

  async function balanceThreeTimes(mcp: McpClient) {
    clients.push(mcp)
    await mcp.initialize()
    const results = []
    for (let i = 0; i < 3; i++) {
      results.push(await mcp.callTool('venice_x402_balance', { wallet_address: address }))
    }
    return results
  }

  it('a static VENICE_SIWX_TOKEN works once, then 401s with a hint', async () => {
    const token = await runSiwxSigner(
      `${NODE} ${q(EXAMPLE_SIGNER)}`,
      { method: 'GET', path: '/v1/x402/balance', baseUrl: venice.url },
      { timeoutMs: 10_000, env: { ...process.env, VENICE_SIWX_KEY_FILE: keyFile } },
    )
    const [first, second, third] = await balanceThreeTimes(spawnMcp({ mode: 'x402', siwxToken: token }, env()))
    assert.notEqual(first.isError, true)
    assert.match(first.content[0].text, /"balanceUsd": 1.5/)
    for (const reused of [second, third]) {
      assert.equal(reused.isError, true)
      assert.match(reused.content[0].text, /Venice API error 401: upstream request failed\. VENICE_SIWX_TOKEN covers one request/)
    }
  })

  it('the example signer command gives every call a fresh, verifiable signature', async () => {
    const callsBefore = venice.calls.length
    const results = await balanceThreeTimes(
      spawnMcp({ mode: 'x402', siwxSignerCommand: `${NODE} ${q(EXAMPLE_SIGNER)}` }, env()),
    )
    for (const result of results) {
      assert.notEqual(result.isError, true, result.content?.[0]?.text)
      assert.match(result.content[0].text, /"balanceUsd": 1.5/)
    }
    // Each tool call = one challenge fetch by the signer + one signed call by the server.
    const calls = venice.calls.slice(callsBefore)
    assert.equal(calls.length, 6)
    const signed = calls.filter((call) => call.headers['sign-in-with-x'])
    assert.equal(signed.length, 3)
    assert.equal(new Set(signed.map((call) => call.headers['sign-in-with-x'])).size, 3)
    for (const call of signed) assert.equal(call.headers.authorization, undefined)
  })
})
