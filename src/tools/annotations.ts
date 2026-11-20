import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

/** Every hint is set explicitly: the MCP spec defaults an omitted hint to destructive and open-world. */
export type ToolHints = Required<Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>>

/** Lookups within a fixed catalog or account domain, with no side effects. */
const READ: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Reads public user-generated characters or reviews. */
const OPEN_READ: ToolHints = { ...READ, openWorldHint: true }
/** Polls a queued job and may delete its media after buffering, before returning. Repeated cleanup has no additional effect. */
const STATUS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
/** Paid calls that create something new (text, media, embeddings, voices, keys). */
const GENERATE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
/** Paid calls that may ingest URLs, use web features, or consume remote user-generated content. */
const OPEN_GENERATE: ToolHints = { ...GENERATE, openWorldHint: true }
/** Deletes server-side media. Repeating it has no further effect. */
const CLEANUP: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
/** May broadcast to a blockchain, which cannot be undone. */
const IRREVERSIBLE: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

/**
 * Keyed by tool name; missing entries for registered tools fail the tests.
 * Hints cover all supported arguments, including optional web access and deletion.
 * Network transport alone does not make a fixed catalog or account domain open-world.
 */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolHints>> = {
  // chat / text
  venice_chat: OPEN_GENERATE,
  venice_chat_with_character: OPEN_GENERATE,
  venice_responses: OPEN_GENERATE,
  venice_embeddings: GENERATE,
  venice_tee_attestation: READ,
  venice_tee_signature: READ,

  // image
  venice_image_generate: OPEN_GENERATE,
  venice_image_edit: OPEN_GENERATE,
  venice_image_multi_edit: OPEN_GENERATE,
  venice_image_upscale: OPEN_GENERATE,
  venice_image_remove_bg: OPEN_GENERATE,
  venice_image_styles: READ,

  // video
  venice_video_quote: READ,
  venice_video_generate: OPEN_GENERATE,
  venice_video_status: STATUS,
  venice_video_wait: STATUS,
  venice_video_complete: CLEANUP,

  // audio / music
  venice_tts: GENERATE,
  venice_asr: OPEN_GENERATE,
  venice_voice_clone: OPEN_GENERATE,
  venice_audio_quote: READ,
  venice_music_generate: GENERATE,
  venice_music_status: STATUS,
  venice_music_wait: STATUS,
  venice_music_complete: CLEANUP,

  // augment
  venice_web_search: OPEN_GENERATE,
  venice_web_scrape: OPEN_GENERATE,
  venice_text_parser: OPEN_GENERATE,

  // catalog / characters
  venice_list_models: READ,
  venice_model_details: READ,
  venice_model_traits: READ,
  venice_model_compatibility_mapping: READ,
  venice_list_characters: OPEN_READ,
  venice_get_character: OPEN_READ,
  venice_character_reviews: OPEN_READ,

  // billing / keys
  venice_billing_balance: READ,
  venice_billing_usage_history: READ,
  venice_billing_usage_analytics: READ,
  venice_list_api_keys: READ,
  venice_get_api_key: READ,
  venice_api_key_rate_limits: READ,
  venice_api_key_rate_limit_logs: READ,
  venice_web3_key_challenge: READ,
  venice_web3_key_mint: GENERATE,

  // x402 / crypto
  venice_x402_balance: READ,
  venice_x402_transactions: READ,
  venice_x402_top_up_info: READ,
  venice_crypto_networks: READ,
  venice_crypto_rpc: IRREVERSIBLE,
}
