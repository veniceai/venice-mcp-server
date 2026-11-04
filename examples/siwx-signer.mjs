#!/usr/bin/env node
// Example VENICE_SIWX_SIGNER_COMMAND for an EVM wallet.
//
// The MCP server runs this once per wallet-authenticated request. It fetches a
// fresh SIWE challenge from Venice, signs it with the key in
// VENICE_SIWX_KEY_FILE, and prints the base64 SIGN-IN-WITH-X value on stdout.
// The MCP server never reads the key file; only this process does.
//
// Setup:
//   npm install viem            (in the folder that holds this script)
//   printf '0x<private key>' > ~/.venice-wallet-key && chmod 600 ~/.venice-wallet-key
//
// MCP config env:
//   VENICE_SIWX_SIGNER_COMMAND = node /path/to/siwx-signer.mjs
//   VENICE_SIWX_KEY_FILE       = /home/you/.venice-wallet-key
//
// Use a dedicated wallet that only holds Venice credit.

import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

const EVM_CHAIN_ID = 8453 // Base mainnet

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const keyFile = process.env.VENICE_SIWX_KEY_FILE
if (!keyFile) fail('VENICE_SIWX_KEY_FILE is not set')
const privateKey = readFileSync(keyFile, 'utf8').trim()
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail(`${keyFile} must contain a 0x-prefixed 32-byte hex private key`)

const account = privateKeyToAccount(privateKey)
const baseUrl = (process.env.VENICE_SIWX_BASE_URL || 'https://api.venice.ai/api').replace(/\/+$/, '')

// Any x402-protected route answers an unauthenticated request with a 402 that
// carries a fresh challenge. The balance route is a GET with no side effects.
const res = await fetch(`${baseUrl}/v1/x402/balance/${account.address}`, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(10_000),
})
const body = await res.json().catch(() => undefined)
const info = body?.extensions?.['sign-in-with-x']?.info
if (res.status !== 402 || !info?.nonce) fail(`Venice did not return a SIWX challenge (HTTP ${res.status})`)

// EIP-4361 message, in the layout Venice issues the challenge for.
const message = [
  `${info.domain} wants you to sign in with your Ethereum account:`,
  account.address,
  '',
  info.statement,
  '',
  `URI: ${info.uri}`,
  `Version: ${info.version}`,
  `Chain ID: ${EVM_CHAIN_ID}`,
  `Nonce: ${info.nonce}`,
  `Issued At: ${info.issuedAt}`,
  `Expiration Time: ${info.expirationTime}`,
].join('\n')

const signature = await account.signMessage({ message })
const payload = {
  address: account.address,
  message,
  signature,
  chainId: `eip155:${EVM_CHAIN_ID}`,
  timestamp: Date.parse(info.issuedAt),
}
process.stdout.write(Buffer.from(JSON.stringify(payload)).toString('base64'))
