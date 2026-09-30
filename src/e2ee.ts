/**
 * Venice E2EE request/response gates for venice_chat.
 * This server does not encrypt, decrypt, or verify attestation. It only refuses
 * to forward or label a call as E2EE unless the documented ciphertext contract holds.
 *
 * @see https://docs.venice.ai/guides/features/tee-e2ee-models
 */

/** Minimum hex length: ephemeral_pub (65) + nonce (12) + tag (16) = 93 bytes. */
export const MIN_ENCRYPTED_HEX_LENGTH = 186

export function isValidEncryptedHex(value: string): boolean {
  return value.length >= MIN_ENCRYPTED_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(value)
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
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'venice_parameters',
  'e2ee_headers',
  'timeout_ms',
])

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
    return `E2EE does not allow "${key}": it would travel to the API as plaintext outside the enclave trust boundary. Only model, messages, temperature, top_p, max_tokens, max_completion_tokens, and timeout_ms may accompany encrypted messages.`
  }

  if (!Array.isArray(args.messages)) {
    return 'E2EE requires user/system content to be encrypted hex ciphertext (at least 186 hex characters). Plaintext, files, and multimodal parts are not allowed.'
  }
  for (const message of args.messages) {
    const messageError = validateE2eeMessage(message)
    if (messageError) return messageError
  }
  return undefined
}

export function validateE2eeSseContent(dataEvents: readonly string[]): string | undefined {
  for (const data of dataEvents) {
    if (data === '[DONE]') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      if (data.trim() !== '') {
        return 'E2EE response contained a non-JSON data event; refusing to label the result encrypted.'
      }
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      return 'E2EE response contained plaintext or invalid ciphertext; refusing to label the result encrypted.'
    }
    const contents = collectMessageContents(parsed as Record<string, unknown>)
    if (contents === undefined) {
      return 'E2EE response contained plaintext or invalid ciphertext; refusing to label the result encrypted.'
    }
    for (const content of contents) {
      if (content === '') continue
      if (!isValidEncryptedHex(content)) {
        return 'E2EE response contained plaintext or invalid ciphertext; refusing to label the result encrypted.'
      }
    }
  }
  return undefined
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
    if (typeof record.content !== 'string' || !isValidEncryptedHex(record.content)) {
      return 'E2EE requires user/system content to be encrypted hex ciphertext (at least 186 hex characters). Plaintext, files, and multimodal parts are not allowed.'
    }
    return undefined
  }

  if (role === 'assistant') {
    if (record.content != null && record.content !== '') {
      if (typeof record.content !== 'string' || !isValidEncryptedHex(record.content)) {
        return 'E2EE assistant history must be encrypted hex ciphertext when content is present.'
      }
    }
    return undefined
  }

  return 'E2EE messages must use the user, system, developer, or assistant role.'
}

function collectMessageContents(payload: Record<string, unknown>): string[] | undefined {
  const choices = payload.choices
  if (!Array.isArray(choices)) return []
  const contents: string[] = []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const record = choice as Record<string, unknown>
    for (const container of [record.delta, record.message]) {
      if (!container || typeof container !== 'object') continue
      const fields = container as Record<string, unknown>
      if (fields.content !== undefined && fields.content !== null && typeof fields.content !== 'string') {
        return undefined
      }
      if (typeof fields.content === 'string') contents.push(fields.content)
      if (fields.reasoning_content !== undefined && fields.reasoning_content !== null && fields.reasoning_content !== '') {
        if (typeof fields.reasoning_content !== 'string') return undefined
        contents.push(fields.reasoning_content)
      }
    }
  }
  return contents
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
