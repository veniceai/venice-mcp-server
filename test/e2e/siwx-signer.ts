/**
 * VENICE_SIWX_SIGNER_COMMAND for the live e2e runs: signs a fresh SIWX header
 * for the persistent .e2e-wallet.json on every request the MCP server makes.
 * The message is built locally with a random nonce, like examples/siwx-signer.mjs,
 * so the run does not spend the rate-limited balance route on challenges.
 */
import { randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSiweMessage, loadOrCreateWallet } from './wallet-helper.js'

const wallet = loadOrCreateWallet()
const account = privateKeyToAccount(wallet.privateKey)
const issuedAt = new Date()
const message = buildSiweMessage(
  {
    domain: 'api.venice.ai',
    uri: 'https://api.venice.ai',
    version: '1',
    statement: 'Sign in to Venice AI',
    nonce: randomBytes(8).toString('hex'),
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 4 * 60_000).toISOString(),
  },
  account.address,
)
const payload = {
  address: account.address,
  message,
  signature: await account.signMessage({ message }),
  chainId: 'eip155:8453',
  timestamp: issuedAt.getTime(),
}
process.stdout.write(Buffer.from(JSON.stringify(payload)).toString('base64'))
