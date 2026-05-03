/**
 * Wallet helper for end-to-end x402 testing against live Venice API.
 *
 * - Generates / loads a persistent test wallet (./.e2e-wallet.json)
 * - Fetches a fresh SIWE challenge from any 402 endpoint
 * - Signs it with EIP-191 personal_sign
 * - Builds the X-Sign-In-With-X base64 header
 * - Builds an EIP-3009 transferWithAuthorization for top-up
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { createWalletClient, http, publicActions, parseUnits } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { base } from 'viem/chains'

const WALLET_FILE = path.resolve(process.cwd(), '.e2e-wallet.json')
const VENICE_API = process.env.VENICE_API_URL || 'https://api.venice.ai'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base mainnet USDC
const TREASURY = '0x2670B922ef37C7Df47158725C0CC407b5382293F'
const CHAIN_ID = 8453

export interface TestWallet {
  privateKey: `0x${string}`
  address: `0x${string}`
}

export function loadOrCreateWallet(): TestWallet {
  if (fs.existsSync(WALLET_FILE)) {
    const data = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'))
    return data as TestWallet
  }
  const pk = generatePrivateKey()
  const account = privateKeyToAccount(pk)
  const wallet: TestWallet = { privateKey: pk, address: account.address }
  fs.writeFileSync(WALLET_FILE, JSON.stringify(wallet, null, 2), { mode: 0o600 })
  return wallet
}

export interface SiweChallenge {
  domain: string
  uri: string
  version: string
  nonce: string
  issuedAt: string
  expirationTime: string
  statement: string
}

/**
 * Hit any x402-protected endpoint without auth -> 402 with a fresh SIWE challenge.
 * We use /api/v1/x402/balance/<addr> because it's GET, no body needed, and returns
 * the SIWE info we need.
 */
export async function fetchSiweChallenge(address: string): Promise<SiweChallenge> {
  const res = await fetch(`${VENICE_API}/api/v1/x402/balance/${address}`)
  if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as any
  const info = body?.extensions?.['sign-in-with-x']?.info
  if (!info) throw new Error(`No SIWE challenge in 402 response: ${JSON.stringify(body)}`)
  return info as SiweChallenge
}

/**
 * Build the canonical SIWE message text from a challenge for a given address.
 * Format follows EIP-4361.
 */
export function buildSiweMessage(challenge: SiweChallenge, address: string): string {
  return [
    `${challenge.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    challenge.statement,
    '',
    `URI: ${challenge.uri}`,
    `Version: ${challenge.version}`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expiration Time: ${challenge.expirationTime}`,
  ].join('\n')
}

/**
 * Sign a SIWE message and produce the base64-encoded X-Sign-In-With-X header value.
 */
export async function buildSiwxHeader(wallet: TestWallet, address?: string): Promise<string> {
  const account = privateKeyToAccount(wallet.privateKey)
  const useAddress = (address || account.address) as `0x${string}`
  const challenge = await fetchSiweChallenge(useAddress)
  const message = buildSiweMessage(challenge, useAddress)
  const signature = await account.signMessage({ message })
  const issuedAtMs = Date.parse(challenge.issuedAt)
  const payload = {
    address: useAddress,
    message,
    signature,
    chainId: 'eip155:8453',
    timestamp: issuedAtMs,
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

/**
 * Get USDC balance (base units, 6 decimals) for an address on Base.
 */
export async function getUsdcBalance(address: `0x${string}`): Promise<bigint> {
  const client = createWalletClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL || 'https://mainnet.base.org'),
  }).extend(publicActions)
  // Standard ERC-20 balanceOf
  const data = await client.readContract({
    address: USDC_ADDRESS,
    abi: [
      {
        name: 'balanceOf',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'owner', type: 'address' }],
        outputs: [{ type: 'uint256' }],
      },
    ],
    functionName: 'balanceOf',
    args: [address],
  })
  return data as bigint
}

/**
 * Build an EIP-3009 transferWithAuthorization payload for USDC on Base
 * and return the base64 X-402-Payment header value to POST to /api/v1/x402/top-up.
 *
 * The signature uses EIP-712 typed data over the TransferWithAuthorization struct,
 * which is what x402 'exact' scheme expects on Base USDC.
 */
export async function buildX402TopUpHeader(
  wallet: TestWallet,
  amountUsd: number,
): Promise<{ header: string; amountBaseUnits: string }> {
  const account = privateKeyToAccount(wallet.privateKey)
  const amountBaseUnits = parseUnits(amountUsd.toString(), 6).toString()
  const validAfter = '0' // immediately valid
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600) // 1h from now
  // 32-byte random nonce (hex)
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = ('0x' + Buffer.from(nonceBytes).toString('hex')) as `0x${string}`

  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: CHAIN_ID,
    verifyingContract: USDC_ADDRESS as `0x${string}`,
  }
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const
  const message = {
    from: account.address,
    to: TREASURY as `0x${string}`,
    value: BigInt(amountBaseUnits),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  }

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  })

  // Build x402 SDK-format payment payload (matches Venice payment parser)
  const paymentPayload = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:8453',
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: TREASURY,
        value: amountBaseUnits,
        validAfter,
        validBefore,
        nonce,
      },
    },
  }

  const header = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
  return { header, amountBaseUnits }
}
