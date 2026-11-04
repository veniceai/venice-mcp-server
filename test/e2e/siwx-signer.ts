/**
 * VENICE_SIWX_SIGNER_COMMAND for the live e2e runs: signs a fresh SIWX header
 * for the persistent .e2e-wallet.json on every request the MCP server makes.
 */
import { buildSiwxHeader, loadOrCreateWallet } from './wallet-helper.js'

process.stdout.write(await buildSiwxHeader(loadOrCreateWallet()))
