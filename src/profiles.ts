import type { Config } from './config.js'
import type { ToolDef, ToolResult } from './tools/index.js'

type ToolContent = ToolResult['content'][number]

/**
 * Curated tool set for shared/hosted deployments (ChatGPT, Claude.ai, Grok connectors).
 * Media generation plus the lookups needed to use it. Left out: chat and LLM tools (the host
 * already has a model), wallet/x402 and crypto tools, and anything that touches local files.
 * Names not present in this build are ignored, so tools from open PRs can be listed ahead of time.
 */
export const HOSTED_TOOLS: ReadonlySet<string> = new Set([
  'venice_list_models',
  'venice_model_details',
  'venice_image_styles',
  'venice_image_generate',
  'venice_image_edit',
  'venice_image_multi_edit',
  'venice_image_upscale',
  'venice_image_remove_bg',
  'venice_video_quote',
  'venice_video_generate',
  'venice_video_status',
  'venice_video_complete',
  'venice_audio_quote',
  'venice_music_generate',
  'venice_music_status',
  'venice_music_complete',
  'venice_tts',
  'venice_get_profile',
])

/** Tools whose `safe_mode` input is forced on in the hosted profile. */
const SAFE_MODE_TOOLS: ReadonlySet<string> = new Set(['venice_image_generate', 'venice_image_edit'])

/** Status tools that may wait for a queued job instead of returning PROCESSING immediately. */
const WAITING_STATUS_TOOLS: ReadonlySet<string> = new Set(['venice_video_status', 'venice_music_status'])

const PENDING_STATUSES: ReadonlySet<string> = new Set(['PROCESSING', 'QUEUED', 'IN_QUEUE', 'IN_PROGRESS', 'PENDING'])
const STATUS_POLL_INTERVAL_MS = 5_000

export interface ProfileRuntime {
  sleep: (ms: number) => Promise<void>
  now: () => number
}

const defaultRuntime: ProfileRuntime = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
}

/** Filter and wrap tools for the configured profile. The `full` profile with default limits is a no-op. */
export function applyProfile(tools: ToolDef[], cfg: Config, runtime: ProfileRuntime = defaultRuntime): ToolDef[] {
  const hosted = cfg.profile === 'hosted'
  return tools
    .filter((tool) => !hosted || HOSTED_TOOLS.has(tool.name))
    .map((tool) => {
      let handler = tool.handler
      if (hosted && SAFE_MODE_TOOLS.has(tool.name) && 'safe_mode' in tool.inputSchema) {
        const inner = handler
        handler = (args) => inner({ ...(args as Record<string, unknown>), safe_mode: true } as never)
      }
      if (cfg.statusWaitMs > 0 && WAITING_STATUS_TOOLS.has(tool.name)) {
        handler = waitForJob(handler, cfg.statusWaitMs, runtime)
      }
      if (cfg.maxInlineMediaChars > 0) {
        handler = limitInlineMedia(handler, cfg.maxInlineMediaChars)
      }
      return handler === tool.handler ? tool : { ...tool, handler }
    })
}

function jobStatus(result: ToolResult): string | undefined {
  const status = result.structuredContent?.status
  return typeof status === 'string' ? status.toUpperCase() : undefined
}

function waitForJob(handler: ToolDef['handler'], waitMs: number, runtime: ProfileRuntime): ToolDef['handler'] {
  return async (args) => {
    const deadline = runtime.now() + waitMs
    let result = await handler(args)
    while (!result.isError && PENDING_STATUSES.has(jobStatus(result) ?? '')) {
      const remaining = deadline - runtime.now()
      if (remaining < STATUS_POLL_INTERVAL_MS) break
      await runtime.sleep(STATUS_POLL_INTERVAL_MS)
      result = await handler(args)
    }
    return result
  }
}

function inlinePayload(item: ToolContent): { kind: string; mimeType?: string; chars: number } | undefined {
  const value = item as { type: string; data?: unknown; mimeType?: string; resource?: { blob?: unknown; mimeType?: string } }
  if ((value.type === 'image' || value.type === 'audio') && typeof value.data === 'string') {
    return { kind: value.type, mimeType: value.mimeType, chars: value.data.length }
  }
  if (value.type === 'resource' && typeof value.resource?.blob === 'string') {
    return { kind: 'resource', mimeType: value.resource.mimeType, chars: value.resource.blob.length }
  }
  return undefined
}

/**
 * Hosted MCP clients reject or truncate large tool results, so oversized inline media is replaced
 * with an explanation. Links (`resource_link`) and text pass through untouched.
 */
function limitInlineMedia(handler: ToolDef['handler'], maxChars: number): ToolDef['handler'] {
  return async (args) => {
    const result = await handler(args)
    const omitted: Array<{ type: string; mime_type?: string; base64_chars: number }> = []
    const content = result.content.map((item): ToolContent => {
      const payload = inlinePayload(item)
      if (!payload || payload.chars <= maxChars) return item
      omitted.push({ type: payload.kind, mime_type: payload.mimeType, base64_chars: payload.chars })
      const kb = Math.round((payload.chars * 3) / 4 / 1024)
      return {
        type: 'text',
        text:
          `The ${payload.mimeType ?? payload.kind} result (~${kb} KB) is too large to return inline from this server. ` +
          'Try a smaller output (lower resolution, fewer variants, or jpeg/webp), a model that returns a download link, ' +
          'or run the Venice MCP server locally.',
      }
    })
    if (omitted.length === 0) return result
    return {
      ...result,
      content,
      structuredContent: { ...(result.structuredContent ?? {}), omitted_inline_media: omitted },
    }
  }
}
