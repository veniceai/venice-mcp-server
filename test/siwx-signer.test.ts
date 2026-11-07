import { after, before, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { verifyMessage } from 'viem'
import { loadConfig } from '../src/config.js'
import { formatToolError } from '../src/format.js'
import { MAX_CONCURRENT_SIGNERS, MAX_SIGNER_OUTPUT_BYTES, runSiwxSigner, SiwxSignerError } from '../src/siwx-signer.js'
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
  mcpToken: e.VENICE_MCP_AUTH_TOKEN ?? null, mcpOther: e.VENICE_MCP_OAUTH_CLIENT_SECRET ?? null,
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
        VENICE_MCP_OAUTH_CLIENT_SECRET: 'oauth_secret_must_not_leak',
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
      mcpOther: null,
      other: 'kept',
    })
  })

  it('reports a non-zero exit and logs the last stderr line on the server, not in the error', async () => {
    const command = nodeCommand(
      'exit-2.mjs',
      `process.stdout.write('partial'); process.stderr.write('debug noise\\nwallet locked: secret-ish\\x1b[31m\\n'); process.exit(2)`,
    )
    const logged = mock.method(console, 'error', () => {})
    try {
      await assert.rejects(runSiwxSigner(command, request, { timeoutMs: 10_000 }), (err: Error) => {
        assert.ok(err instanceof SiwxSignerError)
        assert.equal(
          err.message,
          'SIWX signer command exited with code 2; its stderr is in the server log. No request was sent to Venice.',
        )
        assert.doesNotMatch(err.message, /secret-ish/)
        return true
      })
      assert.deepEqual(
        logged.mock.calls.map((call) => call.arguments),
        [['[venice-mcp] SIWX signer command exited with code 2: wallet locked: secret-ish [31m']],
      )
    } finally {
      logged.mock.restore()
    }
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

  it('kills the whole process tree on timeout, not just the shell', { skip: process.platform === 'win32' }, async () => {
    const pidFile = path.join(scratch, 'tree-hang.pid')
    const hang = nodeCommand(
      'tree-hang.mjs',
      `import { writeFileSync } from 'node:fs'
writeFileSync(${q(pidFile)}, String(process.pid))
setTimeout(() => {}, 60_000)`,
    )
    // A compound command makes the shell fork instead of exec'ing the signer.
    await assert.rejects(runSiwxSigner(`${hang} && echo done`, request, { timeoutMs: 1_000 }), /timed out after 1000ms/)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(pid > 0)
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(alive(), false, 'signer process survived the timeout')
  })

  it(`runs at most ${MAX_CONCURRENT_SIGNERS} signers at once and queues the rest`, async () => {
    const dir = path.join(scratch, 'concurrency')
    mkdirSync(dir)
    const command = nodeCommand(
      'concurrent.mjs',
      `import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const dir = ${q(dir)}
const mine = path.join(dir, String(process.pid))
writeFileSync(mine, '')
let peak = 0
const end = Date.now() + 150
while (Date.now() < end) {
  peak = Math.max(peak, readdirSync(dir).length)
  await new Promise((resolve) => setTimeout(resolve, 10))
}
rmSync(mine)
process.stdout.write('peak-' + peak)
`,
    )
    const runs = MAX_CONCURRENT_SIGNERS * 3
    const results = await Promise.all(
      Array.from({ length: runs }, () => runSiwxSigner(command, request, { timeoutMs: 10_000 })),
    )
    const peaks = results.map((value) => Number(value.replace('peak-', '')))
    assert.equal(peaks.length, runs)
    assert.ok(Math.max(...peaks) <= MAX_CONCURRENT_SIGNERS, `peak concurrency ${Math.max(...peaks)}`)
    assert.ok(Math.max(...peaks) >= 2, 'signers did not run in parallel at all')
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
      {
        match: 'GET /v1/models*',
        reply: ({ headers }: { headers: Record<string, string> }) => ({
          siwx: headers['sign-in-with-x'] ?? null,
          authorization: headers.authorization ?? null,
        }),
      },
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

  it('does not sign or spend a static token on discovery routes that need no auth', async () => {
    const signer = countingSigner()
    for (const env of [{ VENICE_SIWX_SIGNER_COMMAND: signer.command }, { VENICE_SIWX_TOKEN: 'single_use' }]) {
      const client = new VeniceClient(cfg(env))
      assert.deepEqual(await client.get('/v1/models?type=all', undefined, { auth: 'public' }), {
        siwx: null,
        authorization: null,
      })
    }
    assert.equal(signer.runs(), 0)

    // An API key is still sent when one is configured.
    const keyed = new VeniceClient(cfg({ VENICE_API_KEY: 'vk_abc', VENICE_SIWX_SIGNER_COMMAND: signer.command }))
    assert.deepEqual(await keyed.get('/v1/models?type=all', undefined, { auth: 'public' }), {
      siwx: null,
      authorization: 'Bearer vk_abc',
    })
    assert.equal(signer.runs(), 0)
  })

  it('fails locally without contacting Venice when the signer fails', async (t) => {
    const before = server.calls.length
    const command = nodeCommand('fails.mjs', `process.stderr.write('hardware wallet not connected'); process.exit(1)`)
    const client = new VeniceClient(cfg({ VENICE_SIWX_SIGNER_COMMAND: command }))
    t.mock.method(console, 'error', () => {})
    for (const call of [
      () => client.post('/v1/needs-siwx', {}),
      () => client.postMultipart('/v1/multipart', new FormData()),
      () => client.postBinary('/v1/binary', { json: {} }),
    ]) {
      await assert.rejects(call(), (err: unknown) => {
        assert.ok(err instanceof SiwxSignerError)
        assert.equal(
          formatToolError(err),
          'Error: SIWX signer command exited with code 1; its stderr is in the server log. No request was sent to Venice.',
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
 * A local stand-in for Venice's wallet auth, following its documented rules:
 * the client picks the nonce, the message must be for api.venice.ai on chain
 * 8453, `Issued At` must be under 5 minutes old (and at most 30 s ahead), an
 * `Expiration Time` is enforced, and the signature must be a valid EIP-191
 * signature by the wallet in the path. Each nonce works once; reuse is a 401.
 */
async function startSingleUseSiwxVenice(): Promise<MockVeniceServer> {
  const used = new Set<string>()
  const MAX_AGE_MS = 5 * 60_000
  const MAX_SKEW_MS = 30_000
  const rejected = { __status: 401, __body: { error: 'Invalid Sign-in-with-x signature' } }

  const route = async ({ path: reqPath, headers }: { path: string; headers: Record<string, string> }) => {
    const wallet = decodeURIComponent(reqPath.split('/').at(-1)!.split('?')[0])
    const header = headers['sign-in-with-x']
    if (!header) return { __status: 402, __body: { error: 'Payment required' } }
    let payload: { address: `0x${string}`; message: string; signature: `0x${string}` }
    try {
      payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    } catch {
      return rejected
    }
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(payload.message)?.[1]
    const nonce = field('Nonce')
    const issuedAt = Date.parse(field('Issued At') ?? '')
    const expiresAt = field('Expiration Time')
    const now = Date.now()
    if (!payload.message.startsWith('api.venice.ai wants you to sign in with your Ethereum account:\n')) return rejected
    if (field('Chain ID') !== '8453' || !nonce || used.has(nonce)) return rejected
    if (!Number.isFinite(issuedAt) || now - issuedAt > MAX_AGE_MS || issuedAt - now > MAX_SKEW_MS) return rejected
    if (expiresAt !== undefined && Date.parse(expiresAt) <= now) return rejected
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
    // The signer builds its message locally, so each tool call is exactly one request to Venice.
    const calls = venice.calls.slice(callsBefore)
    assert.equal(calls.length, 3)
    const signed = calls.filter((call) => call.headers['sign-in-with-x'])
    assert.equal(signed.length, 3)
    assert.equal(new Set(signed.map((call) => call.headers['sign-in-with-x'])).size, 3)
    for (const call of signed) assert.equal(call.headers.authorization, undefined)
  })
})
