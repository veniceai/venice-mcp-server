/** Canonical error wrapping for upstream failures. */
export class VeniceUpstreamError extends Error {
  readonly status: number
  readonly body: unknown
  readonly headers: Record<string, string>
  /** True when the upstream returned 402 Payment Required (x402). */
  readonly isPaymentRequired: boolean

  constructor(opts: {
    message: string
    status: number
    body: unknown
    headers?: Record<string, string>
  }) {
    super(opts.message)
    this.name = 'VeniceUpstreamError'
    this.status = opts.status
    this.body = opts.body
    this.headers = opts.headers ?? {}
    this.isPaymentRequired = opts.status === 402
  }
}

export interface VeniceMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelCatalogItem {
  id?: string
  object?: string
  owned_by?: string
  type?: string
  model_spec?: Record<string, unknown>
}

export interface ModelCatalogResponse {
  data?: ModelCatalogItem[]
  models?: ModelCatalogItem[]
  object?: string
  type?: string
}

/**
 * Present only the model-scoped metadata needed to choose a TTS voice while
 * retaining the catalog envelope. There is no global GET /audio/voices API.
 */
export function shapeTtsVoiceCatalog(resp: ModelCatalogResponse): Record<string, unknown> {
  const models = resp.data ?? resp.models ?? []
  return {
    object: resp.object ?? 'list',
    type: resp.type ?? 'tts',
    data: models.map((model) => {
      const spec = model.model_spec ?? {}
      return {
        id: model.id,
        type: model.type,
        owned_by: model.owned_by,
        name: spec.name,
        voices: Array.isArray(spec.voices) ? spec.voices : [],
        default_voice: spec.default_voice,
        supports_custom_voice_id: spec.supports_custom_voice_id,
        voice_cloning: spec.voice_cloning,
        supported_formats: spec.supported_formats,
        default_format: spec.default_format,
      }
    }),
  }
}
