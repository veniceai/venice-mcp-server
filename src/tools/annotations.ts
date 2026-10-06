import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

/** Every hint is set explicitly: the MCP spec defaults an omitted hint to destructive and open-world. */
export type ToolHints = Required<Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>>

/** Free lookups with no side effects. */
const READ: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Polls a queued job. Safe to repeat; optional server-side cleanup only runs after the result is returned. */
const STATUS: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
/** Paid calls that create something new (text, media, embeddings, voices, keys). */
const GENERATE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
/** Paid calls whose results come from the open web. */
const WEB: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
/** Deletes server-side media. Repeating it has no further effect. */
const CLEANUP: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
/** May broadcast to a blockchain, which cannot be undone. */
const IRREVERSIBLE: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }

/**
 * Keyed by tool name. Includes tools from open PRs so they are annotated the moment they merge;
 * extra entries are harmless, and a missing entry fails the tests.
 */
export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolHints>> = {
  // chat / text
  venice_chat: GENERATE,
  venice_chat_with_character: GENERATE,
  venice_responses: GENERATE,
  venice_embeddings: GENERATE,
  venice_tee_attestation: READ,
  venice_tee_signature: READ,

  // image
  venice_image_generate: GENERATE,
  venice_image_edit: GENERATE,
  venice_image_multi_edit: GENERATE,
  venice_image_upscale: GENERATE,
  venice_image_remove_bg: GENERATE,
  venice_image_styles: READ,

  // video
  venice_video_quote: READ,
  venice_video_generate: GENERATE,
  venice_video_status: STATUS,
  venice_video_wait: STATUS,
  venice_video_complete: CLEANUP,

  // audio / music
  venice_tts: GENERATE,
  venice_asr: GENERATE,
  venice_voice_clone: GENERATE,
  venice_audio_quote: READ,
  venice_music_generate: GENERATE,
  venice_music_status: STATUS,
  venice_music_wait: STATUS,
  venice_music_complete: CLEANUP,

  // augment
  venice_web_search: WEB,
  venice_web_scrape: WEB,
  venice_text_parser: GENERATE,

  // catalog / characters
  venice_list_models: READ,
  venice_model_details: READ,
  venice_model_traits: READ,
  venice_model_compatibility_mapping: READ,
  venice_list_characters: READ,
  venice_get_character: READ,
  venice_character_reviews: READ,

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
