#!/usr/bin/env node
// Example VENICE_SIWX_SIGNER_COMMAND for an EVM wallet.
//
// The MCP server runs this once per wallet-authenticated request. It builds a
// fresh SIWE message locally (Venice lets the client pick the nonce), signs it
// with the key in VENICE_SIWX_KEY_FILE, and prints the base64 SIGN-IN-WITH-X
// value on stdout. No network call is made. The MCP server never reads the key
// file; only this process does.
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

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

const EVM_CHAIN_ID = 8453 // Base mainnet
// Venice's guidance is to sign SIWX only for api.venice.ai, so these are fixed
// rather than taken from VENICE_SIWX_BASE_URL.
const DOMAIN = 'api.venice.ai'
const URI = 'https://api.venice.ai'
// Venice accepts a message up to 5 minutes after Issued At; expire it sooner.
const LIFETIME_MS = 4 * 60_000

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const keyFile = process.env.VENICE_SIWX_KEY_FILE
if (!keyFile) fail('VENICE_SIWX_KEY_FILE is not set')
const privateKey = readFileSync(keyFile, 'utf8').trim()
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail(`${keyFile} must contain a 0x-prefixed 32-byte hex private key`)

const account = privateKeyToAccount(privateKey)
const issuedAt = new Date()

// EIP-4361 message. Each nonce is single-use, so every run picks a new one.
const message = [
  `${DOMAIN} wants you to sign in with your Ethereum account:`,
  account.address,
  '',
  'Sign in to Venice AI',
  '',
  `URI: ${URI}`,
  'Version: 1',
  `Chain ID: ${EVM_CHAIN_ID}`,
  `Nonce: ${randomBytes(8).toString('hex')}`,
  `Issued At: ${issuedAt.toISOString()}`,
  `Expiration Time: ${new Date(issuedAt.getTime() + LIFETIME_MS).toISOString()}`,
].join('\n')

const signature = await account.signMessage({ message })
const payload = {
  address: account.address,
  message,
  signature,
  chainId: `eip155:${EVM_CHAIN_ID}`,
  timestamp: issuedAt.getTime(),
}
process.stdout.write(Buffer.from(JSON.stringify(payload)).toString('base64'))
