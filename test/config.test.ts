import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('uses sensible defaults when env is empty', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.baseUrl, 'https://api.venice.ai/api')
    assert.equal(cfg.apiKey, undefined)
    assert.equal(cfg.siwxToken, undefined)
    assert.equal(cfg.defaultChatModel, 'deepseek-v4-flash-0731')
    assert.equal(cfg.defaultImageModel, 'flux-2-pro')
    assert.equal(cfg.defaultTtsModel, 'tts-kokoro')
    assert.equal(cfg.defaultAsrModel, 'openai/whisper-large-v3')
    assert.equal(cfg.timeoutMs, 60_000)
    assert.equal(cfg.enableNsfw, true)
    assert.equal(cfg.serverName, '@veniceai/mcp-server')
  })

  it('baseUrl is always the Venice API root', () => {
    assert.equal(loadConfig({}).baseUrl, 'https://api.venice.ai/api')
  })

  it('reads API key + SIWX token independently', () => {
    const cfg = loadConfig({ VENICE_API_KEY: 'vk_abc', VENICE_SIWX_TOKEN: 'siwx_xyz' })
    assert.equal(cfg.apiKey, 'vk_abc')
    assert.equal(cfg.siwxToken, 'siwx_xyz')
  })

  it('respects VENICE_DISABLE_NSFW=1', () => {
    assert.equal(loadConfig({ VENICE_DISABLE_NSFW: '1' }).enableNsfw, false)
    assert.equal(loadConfig({ VENICE_DISABLE_NSFW: '0' }).enableNsfw, true)
    assert.equal(loadConfig({ VENICE_DISABLE_NSFW: '' }).enableNsfw, true)
  })

  it('parses numeric timeout', () => {
    assert.equal(loadConfig({ VENICE_HTTP_TIMEOUT_MS: '12345' }).timeoutMs, 12345)
  })

  it('falls back to default timeout for invalid values', () => {
    assert.equal(loadConfig({ VENICE_HTTP_TIMEOUT_MS: 'nope' }).timeoutMs, 60_000)
    assert.equal(loadConfig({ VENICE_HTTP_TIMEOUT_MS: '0' }).timeoutMs, 60_000)
    assert.equal(loadConfig({ VENICE_HTTP_TIMEOUT_MS: '-1' }).timeoutMs, 60_000)
  })

  it('overrides default models from env', () => {
    const cfg = loadConfig({
      VENICE_DEFAULT_CHAT_MODEL: 'gpt-5.5',
      VENICE_DEFAULT_IMAGE_MODEL: 'flux-2-max',
      VENICE_DEFAULT_TTS_MODEL: 'venice-tts-2',
      VENICE_DEFAULT_ASR_MODEL: 'venice-asr-2',
    })
    assert.equal(cfg.defaultChatModel, 'gpt-5.5')
    assert.equal(cfg.defaultImageModel, 'flux-2-max')
    assert.equal(cfg.defaultTtsModel, 'venice-tts-2')
    assert.equal(cfg.defaultAsrModel, 'venice-asr-2')
  })

  it('keeps web3 minting off unless VENICE_MCP_ENABLE_WEB3_MINT=1', () => {
    assert.equal(loadConfig({}).enableWeb3Mint, false)
    assert.equal(loadConfig({ VENICE_MCP_ENABLE_WEB3_MINT: 'true' }).enableWeb3Mint, false)
    assert.equal(loadConfig({ VENICE_MCP_ENABLE_WEB3_MINT: '1' }).enableWeb3Mint, true)
  })

  it('reads mint ceilings with low defaults and ignores invalid values', () => {
    assert.equal(loadConfig({}).maxMintUsd, 50)
    assert.equal(loadConfig({}).maxMintDiem, 50)
    const cfg = loadConfig({ VENICE_MCP_MAX_MINT_USD: '10.5', VENICE_MCP_MAX_MINT_DIEM: '3' })
    assert.equal(cfg.maxMintUsd, 10.5)
    assert.equal(cfg.maxMintDiem, 3)
    for (const value of ['nope', '0', '-5', 'Infinity']) {
      assert.equal(loadConfig({ VENICE_MCP_MAX_MINT_USD: value }).maxMintUsd, 50, value)
      assert.equal(loadConfig({ VENICE_MCP_MAX_MINT_DIEM: value }).maxMintDiem, 50, value)
    }
  })
})
