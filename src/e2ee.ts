/**
 * Venice E2EE request/response gates for venice_chat.
 * This server does not encrypt, decrypt, or verify attestation. It only refuses
 * to forward or return a call as E2EE unless payloads have the documented
 * ciphertext shape. Shape checks cannot prove the content is really encrypted.
 *
 * @see https://docs.venice.ai/guides/features/tee-e2ee-models
 */
import { ECDH } from 'node:crypto'

const UNCOMPRESSED_POINT_BYTES = 65
const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16

/** Minimum hex length: ephemeral_pub (65) + nonce (12) + tag (16) = 93 bytes. */
export const MIN_ENCRYPTED_HEX_LENGTH = (UNCOMPRESSED_POINT_BYTES + GCM_NONCE_BYTES + GCM_TAG_BYTES) * 2

function isUncompressedSecp256k1Point(bytes: Buffer): boolean {
  if (bytes.length !== UNCOMPRESSED_POINT_BYTES || bytes[0] !== 0x04) return false
  try {
    ECDH.convertKey(bytes, 'secp256k1', undefined, undefined, 'uncompressed')
    return true
  } catch {
    return false
  }
}

export function isUncompressedSecp256k1PublicKey(hex: string): boolean {
  return /^04[0-9a-fA-F]{128}$/.test(hex) && isUncompressedSecp256k1Point(Buffer.from(hex, 'hex'))
}

/**
 * Venice ciphertext layout: ephemeral uncompressed secp256k1 public key, then
 * the AES-GCM nonce, then ciphertext with the 16-byte tag appended.
 */
export function hasCiphertextShape(value: string): boolean {
  if (value.length < MIN_ENCRYPTED_HEX_LENGTH || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return false
  }
  return isUncompressedSecp256k1Point(Buffer.from(value.slice(0, UNCOMPRESSED_POINT_BYTES * 2), 'hex'))
}

export function modelSupportsE2ee(modelId: string, catalog: unknown): boolean {
  const models = extractCatalogModels(catalog)
  const match = models.find((entry) => entry.id === modelId)
  return match?.model_spec?.capabilities?.supportsE2EE === true
}

/** Tool inputs that may accompany an E2EE call; none of them carry caller text to the API. */
const E2EE_REQUEST_KEYS = new Set([
  'model',
  'messages',
  'venice_parameters',
  'e2ee_headers',
  'timeout_ms',
])

/**
 * Upstream builds a minimal E2EE provider body (model, messages, stream) and
 * drops these. Accepting them would look like a cap that is never applied.
 */
const E2EE_IGNORED_SAMPLING_KEYS = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens'] as const

/** The only venice_parameters values accepted on the E2EE path. */
const E2EE_VENICE_PARAMETER_VALUES: Readonly<Record<string, unknown>> = {
  enable_e2ee: true,
  enable_web_search: 'off',
  enable_web_citations: false,
  enable_web_scraping: false,
  enable_x_search: false,
  include_venice_system_prompt: false,
}

/** The fixed venice_parameters sent upstream for every E2EE call. */
export const E2EE_VENICE_PARAMETERS = {
  enable_e2ee: true,
  include_venice_system_prompt: false,
  enable_web_search: 'off',
} as const

const E2EE_MESSAGE_KEYS = new Set(['role', 'content'])

export function validateE2eeChatRequest(args: {
  model?: string
  messages?: unknown
  tools?: unknown
  tool_choice?: unknown
  parallel_tool_calls?: unknown
  response_format?: unknown
  venice_parameters?: {
    enable_web_search?: 'auto' | 'on' | 'off'
    enable_web_citations?: boolean
    enable_web_scraping?: boolean
    enable_x_search?: boolean
    include_venice_system_prompt?: boolean
    character_slug?: string
  }
  [key: string]: unknown
}): string | undefined {
  if (typeof args.model !== 'string' || args.model.trim() === '') {
    return 'E2EE requires an explicit E2EE-capable model; the default chat model is not used.'
  }
  if (args.tools !== undefined || args.tool_choice !== undefined || args.parallel_tool_calls !== undefined) {
    return 'E2EE does not support tools or function calling.'
  }
  if (args.response_format !== undefined) {
    return 'E2EE does not support structured output; response_format is rejected in full, including json_object and text. A schema would travel to the API as plaintext outside the enclave trust boundary, and the E2EE request would not honour it.'
  }
  for (const key of E2EE_IGNORED_SAMPLING_KEYS) {
    if (args[key] !== undefined) {
      return `E2EE does not apply ${key}. Upstream sends only model, messages, and stream for an E2EE completion, so this value would be silently ignored.`
    }
  }

  const venice = args.venice_parameters
  if (venice) {
    if (venice.enable_web_search !== undefined && venice.enable_web_search !== 'off') {
      return 'E2EE does not support web search.'
    }
    if (venice.enable_web_citations === true || venice.enable_web_scraping === true || venice.enable_x_search === true) {
      return 'E2EE does not support web search, citations, or scraping.'
    }
    if (venice.include_venice_system_prompt === true) {
      return 'E2EE cannot include the Venice system prompt; encrypt any system instructions client-side.'
    }
    if (venice.character_slug !== undefined) {
      return 'E2EE does not support character injection; encrypt any persona instructions client-side.'
    }
    for (const [key, value] of Object.entries(venice)) {
      if (value === undefined) continue
      if (!(key in E2EE_VENICE_PARAMETER_VALUES) || E2EE_VENICE_PARAMETER_VALUES[key] !== value) {
        return `E2EE does not allow this venice_parameters.${key} value; the E2EE request always sends enable_e2ee=true, include_venice_system_prompt=false, and enable_web_search="off".`
      }
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || E2EE_REQUEST_KEYS.has(key)) continue
    return `E2EE does not allow "${key}": it would travel to the API as plaintext outside the enclave trust boundary. Only model, messages, and timeout_ms may accompany encrypted messages.`
  }

  if (!Array.isArray(args.messages)) {
    return 'E2EE requires user/system content to be encrypted hex ciphertext in the Venice layout: a 65-byte uncompressed secp256k1 ephemeral public key, a 12-byte nonce, then AES-GCM ciphertext with its 16-byte tag (at least 186 hex characters). Plaintext, hex-encoded plaintext, files, and multimodal parts are not allowed.'
  }
  for (const message of args.messages) {
    const messageError = validateE2eeMessage(message)
    if (messageError) return messageError
  }
  return undefined
}

export interface E2eeStreamDelta {
  content?: string
  reasoning_content?: string
}

/** Ciphertext deltas plus the completion id needed by venice_tee_signature. */
export function compactE2eeStream(dataEvents: readonly string[]): { id: string; deltas: E2eeStreamDelta[] } | string {
  let id: string | undefined
  const deltas: E2eeStreamDelta[] = []
  for (const data of dataEvents) {
    if (data === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (typeof parsed.id === 'string' && parsed.id !== '') {
      if (id === undefined) id = parsed.id
      else if (id !== parsed.id) return 'E2EE stream changed completion id mid-stream; refusing to return it.'
    }
    if (!Array.isArray(parsed.choices)) continue
    for (const choice of parsed.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue
      const delta: E2eeStreamDelta = {}
      if (typeof choice.delta.content === 'string' && choice.delta.content !== '') delta.content = choice.delta.content
      if (typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content !== '') {
        delta.reasoning_content = choice.delta.reasoning_content
      }
      if (delta.content !== undefined || delta.reasoning_content !== undefined) deltas.push(delta)
    }
  }
  if (id === undefined) return 'E2EE stream did not include a completion id, which venice_tee_signature requires.'
  return { id, deltas }
}

export function validateE2eeSseContent(dataEvents: readonly string[]): string | undefined {
  for (const data of dataEvents) {
    if (data === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      if (data.trim() !== '') {
        return 'E2EE response contained a non-JSON data event; refusing to return it as E2EE output.'
      }
      continue
    }
    const eventError = validateE2eeChunk(parsed)
    if (eventError) return eventError
  }
  return undefined
}

const INVALID_CIPHERTEXT = 'E2EE response contained plaintext or invalid ciphertext; refusing to return it as E2EE output.'
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter'])

function unexpectedField(path: string): string {
  return `E2EE response event contained an unexpected field "${path}"; only chunk metadata and ciphertext delta content are accepted, so the stream is not returned as E2EE output.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Allowlist of streamed chat.completion.chunk fields; anything else could carry plaintext. */
function validateE2eeChunk(chunk: unknown): string | undefined {
  if (!isRecord(chunk)) return INVALID_CIPHERTEXT
  for (const [key, value] of Object.entries(chunk)) {
    switch (key) {
      case 'id':
      case 'object':
      case 'model':
        if (typeof value !== 'string') return unexpectedField(key)
        break
      case 'system_fingerprint':
        if (value !== null && typeof value !== 'string') return unexpectedField(key)
        break
      case 'created':
        if (typeof value !== 'number') return unexpectedField(key)
        break
      case 'usage':
      case 'cost':
        if (value !== null && !isNumericTree(value)) return unexpectedField(key)
        break
      case 'prompt_logprobs':
        if (value !== null) return unexpectedField(key)
        break
      case 'venice_parameters':
        if (value !== null && !isTextFreeVeniceParameters(value)) return unexpectedField(key)
        break
      case 'choices': {
        if (!Array.isArray(value)) return unexpectedField(key)
        for (const choice of value) {
          const choiceError = validateE2eeChoice(choice)
          if (choiceError) return choiceError
        }
        break
      }
      default:
        return unexpectedField(key)
    }
  }
  return undefined
}

function validateE2eeChoice(choice: unknown): string | undefined {
  if (!isRecord(choice)) return unexpectedField('choices[]')
  for (const [key, value] of Object.entries(choice)) {
    switch (key) {
      case 'index':
        if (typeof value !== 'number') return unexpectedField(`choices[].${key}`)
        break
      case 'finish_reason':
        if (value !== null && !(typeof value === 'string' && FINISH_REASONS.has(value))) {
          return unexpectedField(`choices[].${key}`)
        }
        break
      case 'stop_reason':
        if (value !== null && typeof value !== 'number') return unexpectedField(`choices[].${key}`)
        break
      case 'logprobs':
        if (value !== null) return unexpectedField(`choices[].${key}`)
        break
      case 'delta': {
        if (!isRecord(value)) return unexpectedField(`choices[].${key}`)
        const deltaError = validateE2eeDelta(value)
        if (deltaError) return deltaError
        break
      }
      default:
        return unexpectedField(`choices[].${key}`)
    }
  }
  return undefined
}

function validateE2eeDelta(delta: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(delta)) {
    switch (key) {
      case 'role':
        if (value !== null && value !== 'assistant') return unexpectedField(`choices[].delta.${key}`)
        break
      case 'content':
      case 'reasoning_content':
        if (value === null || value === '') break
        if (typeof value !== 'string' || !hasCiphertextShape(value)) return INVALID_CIPHERTEXT
        break
      default:
        return unexpectedField(`choices[].delta.${key}`)
    }
  }
  return undefined
}

function isNumericTree(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.values(value).every(
    (entry) => entry === null || typeof entry === 'number' || (isRecord(entry) && Object.values(entry).every(
      (leaf) => leaf === null || typeof leaf === 'number',
    )),
  )
}

/** Echoed venice_parameters may only hold flags; citations or other strings are text. */
function isTextFreeVeniceParameters(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, entry]) => {
    if (entry === null || typeof entry === 'boolean') return true
    if (key === 'enable_web_search') return entry === 'off'
    return Array.isArray(entry) && entry.length === 0
  })
}

function validateE2eeMessage(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return 'E2EE messages must be objects with encrypted user/system content.'
  }
  const record = message as Record<string, unknown>
  const role = record.role

  if (role === 'tool' || record.tool_calls !== undefined) {
    return 'E2EE does not support tools or function calling.'
  }
  if (record.reasoning_content != null && record.reasoning_content !== '') {
    return 'E2EE assistant history cannot include reasoning_content; send only role and encrypted content.'
  }
  if (record.reasoning_details !== undefined) {
    return 'E2EE does not support reasoning_details; they are not encrypted ciphertext.'
  }
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || E2EE_MESSAGE_KEYS.has(key)) continue
    return `E2EE messages may only contain role and content; "${key}" would travel to the API as plaintext.`
  }

  if (role === 'user' || role === 'system' || role === 'developer') {
    if (typeof record.content !== 'string' || !hasCiphertextShape(record.content)) {
      return 'E2EE requires user/system content to be encrypted hex ciphertext in the Venice layout: a 65-byte uncompressed secp256k1 ephemeral public key, a 12-byte nonce, then AES-GCM ciphertext with its 16-byte tag (at least 186 hex characters). Plaintext, hex-encoded plaintext, files, and multimodal parts are not allowed.'
    }
    return undefined
  }

  if (role === 'assistant') {
    if (record.content != null && record.content !== '') {
      if (typeof record.content !== 'string' || !hasCiphertextShape(record.content)) {
        return 'E2EE assistant history must be encrypted hex ciphertext when content is present.'
      }
    }
    return undefined
  }

  return 'E2EE messages must use the user, system, developer, or assistant role.'
}

function extractCatalogModels(catalog: unknown): Array<{
  id?: string
  model_spec?: { capabilities?: { supportsE2EE?: boolean } }
}> {
  if (!catalog || typeof catalog !== 'object') return []
  const record = catalog as Record<string, unknown>
  const list = record.data ?? record.models
  return Array.isArray(list) ? (list as Array<{ id?: string; model_spec?: { capabilities?: { supportsE2EE?: boolean } } }>) : []
}
