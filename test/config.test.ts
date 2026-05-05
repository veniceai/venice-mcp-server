import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('uses sensible defaults when env is empty', () => {
    const cfg = loadConfig({})
    assert.equal(cfg.baseUrl, 'https://api.venice.ai/api')
    assert.equal(cfg.apiKey, undefined)
    assert.equal(cfg.siwxToken, undefined)
    assert.equal(cfg.defaultChatModel, 'venice-uncensored')
    assert.equal(cfg.defaultImageModel, 'flux-2-pro')
    assert.equal(cfg.defaultTtsModel, 'tts-kokoro')
    assert.equal(cfg.defaultAsrModel, 'openai/whisper-large-v3')
    assert.equal(cfg.timeoutMs, 60_000)
    assert.equal(cfg.enableNsfw, true)
    assert.equal(cfg.serverName, '@veniceai/mcp-server')
  })

  it('strips trailing slash from base url', () => {
    const cfg = loadConfig({ VENICE_API_BASE_URL: 'https://api.example.com/' })
    assert.equal(cfg.baseUrl, 'https://api.example.com')
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
})
