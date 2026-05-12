#!/usr/bin/env tsx
/**
 * End-to-end x402 test harness against live Venice API.
 *
 * Phases (controlled by VENICE_E2E_PHASE env var):
 *
 *   phase=create      -> Generate wallet (or load), print address + funding instructions, exit
 *   phase=empty       -> Run empty-wallet test: SIWX -> MCP venice_chat -> expect 402
 *   phase=balance     -> Read on-chain USDC balance + Venice credit balance via MCP
 *   phase=topup       -> Build EIP-3009 + POST /api/v1/x402/top-up
 *   phase=funded      -> Run funded test: SIWX -> MCP venice_chat -> expect real completion
 *   phase=full        -> empty + balance (skips topup; assumes user already funded)
 *
 * No private keys are sent anywhere. Wallet is persisted at ./.e2e-wallet.json.
 */
import {
  loadOrCreateWallet,
  buildSiwxHeader,
  buildX402TopUpHeader,
  getUsdcBalance,
} from './wallet-helper.js'
import { spawnMcp } from './mcp-stdio-client.js'

const VENICE_API = process.env.VENICE_API_URL || 'https://api.venice.ai'
const PHASE = process.env.VENICE_E2E_PHASE || 'create'

function log(msg: string) {
  console.log(`[e2e] ${msg}`)
}

function header(msg: string) {
  console.log(`\n${'='.repeat(70)}\n  ${msg}\n${'='.repeat(70)}`)
}

async function phaseCreate() {
  header('PHASE 1: Wallet creation')
  const wallet = loadOrCreateWallet()
  log(`address:     ${wallet.address}`)
  log(`network:     Base mainnet (eip155:8453)`)
  log(`USDC token:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
  log(`treasury:    0x2670B922ef37C7Df47158725C0CC407b5382293F`)
  log(`min top-up:  $5.00 USDC`)
  log(``)
  log(`Saved to:    ./.e2e-wallet.json (private key in chmod 600 file)`)

  // Check current on-chain balance
  try {
    const bal = await getUsdcBalance(wallet.address)
    const usd = Number(bal) / 1e6
    log(`current USDC on Base: ${usd.toFixed(6)} USDC`)
    if (usd >= 5) log('✓ Wallet has enough to top up')
    else log('⚠ Wallet needs at least $5.00 USDC + a few cents of ETH for gas (none needed if treasury covers gas)')
  } catch (e) {
    log(`(could not query Base RPC: ${(e as Error).message})`)
  }
}

async function phaseEmpty() {
  header('PHASE 2: Empty-wallet test (expect 402 INSUFFICIENT_BALANCE)')
  // Generate a brand-new ephemeral wallet so this test stays valid even when
  // the persisted .e2e-wallet.json has been topped up. The point of this phase
  // is to exercise the never-funded code path in Venice's middleware.
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
  const ephemeralPk = generatePrivateKey()
  const ephemeralAccount = privateKeyToAccount(ephemeralPk)
  const ephemeralWallet = { privateKey: ephemeralPk, address: ephemeralAccount.address }

  log(`ephemeral wallet (not persisted): ${ephemeralWallet.address}`)
  const siwxToken = await buildSiwxHeader(ephemeralWallet)
  log(`signed SIWE for ${ephemeralWallet.address}`)
  log(`SIWX token length: ${siwxToken.length} chars (base64)`)

  const mcp = spawnMcp({
    VENICE_TEST_BASE_URL: VENICE_API.replace(/\/?$/, '/api').replace(/\/api\/api$/, '/api'),
    VENICE_SIWX_TOKEN: siwxToken,
    VENICE_LOG_LEVEL: 'error',
  })

  try {
    log('initializing MCP session...')
    const init = await mcp.initialize()
    log(`server: ${init.serverInfo?.name} v${init.serverInfo?.version}`)

    log('calling venice_chat with cheap prompt...')
    const result = await mcp.callTool('venice_chat', {
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      model: 'venice-uncensored',
      max_tokens: 8,
    })
    log('response received:')
    console.log(JSON.stringify(result, null, 2))

    // Verify it's a 402 / payment-required error
    const text = JSON.stringify(result)
    const isError = result?.isError === true
    const has402 = text.includes('402') || /balance/i.test(text) || /insufficient/i.test(text) || /top.?up/i.test(text)
    if (isError && has402) {
      log('✓ PASS: empty wallet correctly returned 402 / insufficient balance')
    } else if (isError) {
      log('⚠ Got error but did not look like 402:')
      console.log(text.slice(0, 600))
    } else {
      log('✗ FAIL: expected error but got success response')
    }
  } finally {
    await mcp.close()
    if (mcp.stderr()) log(`mcp stderr:\n${mcp.stderr().slice(0, 800)}`)
  }
}

async function phaseBalance() {
  header('PHASE: Balance check')
  const wallet = loadOrCreateWallet()
  log(`address: ${wallet.address}`)

  // On-chain
  try {
    const onchain = await getUsdcBalance(wallet.address)
    log(`on-chain USDC (Base): ${(Number(onchain) / 1e6).toFixed(6)}`)
  } catch (e) {
    log(`could not query Base RPC: ${(e as Error).message}`)
  }

  // Venice credit balance via MCP
  const siwxToken = await buildSiwxHeader(wallet)
  const mcp = spawnMcp({
    VENICE_TEST_BASE_URL: VENICE_API.replace(/\/?$/, '/api').replace(/\/api\/api$/, '/api'),
    VENICE_SIWX_TOKEN: siwxToken,
    VENICE_LOG_LEVEL: 'error',
  })
  try {
    await mcp.initialize()
    log('calling venice_x402_balance tool...')
    const r = await mcp.callTool('venice_x402_balance', { wallet_address: wallet.address })
    console.log(JSON.stringify(r, null, 2))
  } finally {
    await mcp.close()
  }
}

async function phaseTopUp() {
  header('PHASE 3: x402 Top-up via /api/v1/x402/top-up')
  const wallet = loadOrCreateWallet()
  const amountUsd = Number(process.env.E2E_TOPUP_USD || '5')
  log(`amount: $${amountUsd} USDC`)
  log('checking on-chain balance first...')
  const bal = await getUsdcBalance(wallet.address)
  const have = Number(bal) / 1e6
  log(`on-chain USDC: ${have.toFixed(6)}`)
  if (have < amountUsd) {
    log(`✗ Need at least ${amountUsd} USDC on-chain to top up. Send to ${wallet.address} on Base.`)
    process.exit(1)
  }

  log('signing EIP-3009 transferWithAuthorization...')
  const { header: paymentHeader, amountBaseUnits } = await buildX402TopUpHeader(wallet, amountUsd)
  log(`amount base units: ${amountBaseUnits} (${amountUsd} USDC)`)
  log(`payment header length: ${paymentHeader.length} chars`)

  log('POST /api/v1/x402/top-up...')
  const res = await fetch(`${VENICE_API}/api/v1/x402/top-up`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-402-Payment': paymentHeader,
    },
  })
  log(`status: ${res.status}`)
  const body = await res.text()
  console.log(body)
  if (res.ok) log('✓ Top-up settled')
}

async function phaseFunded() {
  header('PHASE 4: Funded-wallet test (expect real chat completion)')
  const wallet = loadOrCreateWallet()
  const siwxToken = await buildSiwxHeader(wallet)

  const mcp = spawnMcp({
    VENICE_TEST_BASE_URL: VENICE_API.replace(/\/?$/, '/api').replace(/\/api\/api$/, '/api'),
    VENICE_SIWX_TOKEN: siwxToken,
    VENICE_LOG_LEVEL: 'error',
  })

  try {
    await mcp.initialize()
    log('calling venice_chat...')
    const result = await mcp.callTool('venice_chat', {
      messages: [{ role: 'user', content: 'Say exactly: hello from x402' }],
      model: 'venice-uncensored',
      max_tokens: 24,
      temperature: 0,
    })
    console.log(JSON.stringify(result, null, 2))
    if (result?.isError) {
      log('✗ FAIL: got an error from venice_chat')
    } else {
      log('✓ PASS: real completion returned')
    }
  } finally {
    await mcp.close()
    if (mcp.stderr()) log(`mcp stderr:\n${mcp.stderr().slice(0, 500)}`)
  }
}

async function main() {
  switch (PHASE) {
    case 'create':
      await phaseCreate()
      break
    case 'empty':
      await phaseEmpty()
      break
    case 'balance':
      await phaseBalance()
      break
    case 'topup':
      await phaseTopUp()
      break
    case 'funded':
      await phaseFunded()
      break
    case 'full':
      await phaseCreate()
      await phaseEmpty()
      await phaseBalance()
      break
    default:
      console.error(`Unknown VENICE_E2E_PHASE=${PHASE}`)
      process.exit(2)
  }
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
