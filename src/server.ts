/**
 * Build a configured MCP server with Venice tools, resources, and prompts.
 * Pure factory — does not bind any transport. Transports live in src/transports/.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { VeniceClient } from './venice-client.js'
import { loadConfig, type Config } from './config.js'
import { buildTools, type BuildToolsOptions } from './tools/index.js'
import { TOOL_ANNOTATIONS } from './tools/annotations.js'
import { buildResources } from './resources.js'
import { buildPrompts } from './prompts.js'
import { profileTool, securitySchemes, withReauthChallenge, type ToolAuthContext } from './auth/tool-auth.js'

export interface BuildOptions extends BuildToolsOptions {
  config?: Config
  /** Inject an alternate client for tests. */
  client?: VeniceClient
  /** Tracks work that can outlive a disconnected HTTP response. */
  trackOperation?: (operation: Promise<unknown>) => void
  /** Set when the server runs behind OAuth: adds ChatGPT auth metadata and the profile tool. */
  auth?: ToolAuthContext
}

export function buildServer(opts: BuildOptions = {}): McpServer {
  const cfg = opts.config ?? loadConfig()
  const client = opts.client ?? new VeniceClient(cfg)

  const server = new McpServer(
    { name: cfg.serverName, version: cfg.serverVersion },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
      },
      instructions: [
        'Venice MCP exposes uncensored, privacy-respecting AI inference (LLM, image, video, TTS, ASR, music) via Venice.ai.',
        'Auth: set VENICE_API_KEY, or set VENICE_SIWX_TOKEN to a pre-signed EVM or Solana SIGN-IN-WITH-X payload.',
        'See https://docs.venice.ai/mcp for full reference.',
      ].join(' '),
    }
  )

  // Tools — cast to any to bypass deep ZodRawShape inference in the SDK.
  // We rely on Zod for runtime validation; TS-side typing is widened.
  const srv = server as unknown as {
    registerTool: (name: string, def: unknown, handler: unknown) => void
    registerResource: (name: string, uri: string, def: unknown, handler: unknown) => void
    registerPrompt: (name: string, def: unknown, handler: unknown) => void
  }

  const track = <T>(operation: Promise<T>): Promise<T> => {
    opts.trackOperation?.(operation)
    return operation
  }

  const auth = opts.auth
  for (const t of buildTools(client, cfg, opts)) {
    const handler = auth ? withReauthChallenge(t.handler, auth) : t.handler
    srv.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: TOOL_ANNOTATIONS[t.name],
        ...(auth ? { _meta: { securitySchemes: securitySchemes(auth) } } : {}),
      },
      async (args: unknown) => track(handler(args as never))
    )
  }

  if (auth) {
    const profile = profileTool(auth)
    srv.registerTool(
      profile.name,
      {
        title: profile.title,
        description: profile.description,
        inputSchema: profile.inputSchema,
        outputSchema: profile.outputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { securitySchemes: securitySchemes(auth), 'openai/profile': true },
      },
      async () => track(profile.handler({} as never))
    )
  }

  // Resources
  for (const r of buildResources(client)) {
    srv.registerResource(
      r.uri.replace(/^venice:\/\//, ''),
      r.uri,
      {
        title: r.name,
        description: r.description,
        mimeType: r.mimeType,
      },
      async () => ({ contents: [await track(r.read())] })
    )
  }

  // Prompts
  for (const p of buildPrompts()) {
    srv.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema },
      async (args: unknown) => p.build(args as never)
    )
  }

  return server
}

export { loadConfig } from './config.js'
export { VeniceClient } from './venice-client.js'
