import { loadOrCreateWallet, buildSiwxHeader, fetchSiweChallenge, buildSiweMessage } from './wallet-helper.js'
import { privateKeyToAccount } from 'viem/accounts'

const wallet = loadOrCreateWallet()
console.log('wallet:', wallet.address)

const challenge = await fetchSiweChallenge(wallet.address)
console.log('challenge:', JSON.stringify(challenge, null, 2))

const message = buildSiweMessage(challenge, wallet.address)
console.log('\n--- SIWE message ---')
console.log(message)
console.log('--- end ---\n')

const account = privateKeyToAccount(wallet.privateKey)
const signature = await account.signMessage({ message })
const issuedAtMs = Date.parse(challenge.issuedAt)
const payload = {
  address: wallet.address,
  message,
  signature,
  chainId: 'eip155:8453',
  timestamp: issuedAtMs,
}
const token = Buffer.from(JSON.stringify(payload)).toString('base64')

console.log('payload:', JSON.stringify({ ...payload, signature: signature.slice(0, 20) + '...' }, null, 2))

// Now hit the actual endpoint and read the response
console.log('\nposting to /chat/completions...')
const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Sign-In-With-X': token,
  },
  body: JSON.stringify({
    model: 'venice-uncensored',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 4,
  }),
})
console.log('status:', res.status)
console.log('body:', await res.text())
