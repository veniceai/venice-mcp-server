import { z } from 'zod'
import type { ToolDef, ToolResult } from '../tools/index.js'
import type { VerifiedToken } from './oauth.js'

/** Per-request OAuth context passed to `buildServer` by the HTTP transport. */
export interface ToolAuthContext {
  scopes: string[]
  /** `WWW-Authenticate` value that sends the client back through sign-in. */
  reauthChallenge: string
  token: VerifiedToken
}

export function securitySchemes(ctx: ToolAuthContext): Array<{ type: 'oauth2'; scopes: string[] }> {
  return [{ type: 'oauth2', scopes: ctx.scopes }]
}

/**
 * A 401 from Venice means the key behind this connection was revoked or expired. ChatGPT only
 * offers to reconnect when the error result carries `_meta["mcp/www_authenticate"]`.
 */
export function withReauthChallenge(handler: ToolDef['handler'], ctx: ToolAuthContext): ToolDef['handler'] {
  return async (args) => {
    const result = await handler(args)
    if (!result.isError) return result
    const text = result.content.map((item) => ('text' in item ? item.text : '')).join(' ')
    if (!/Venice API error 401\b/.test(text)) return result
    return { ...result, _meta: { 'mcp/www_authenticate': [ctx.reauthChallenge] } } as ToolResult
  }
}

const profileOutput = {
  id: z.string().min(1).describe('Opaque profile identifier, stable across token refresh and reconnection.'),
  name: z.string().optional().describe('Display name for the authenticated profile.'),
  email: z.string().optional().describe('Email address for display; not used as the profile identity.'),
}

/** Read-only tool that tells the host which Venice account this connection belongs to. */
export function profileTool(ctx: ToolAuthContext): ToolDef & { outputSchema: typeof profileOutput } {
  return {
    name: 'venice_get_profile',
    title: 'Venice Profile',
    description:
      'Return the Venice profile for this connection. The opaque id stays the same across token refresh and reconnection.',
    inputSchema: {},
    outputSchema: profileOutput,
    handler: async () => {
      const profile: Record<string, string> = { id: ctx.token.subject }
      if (ctx.token.name) profile.name = ctx.token.name
      if (ctx.token.email) profile.email = ctx.token.email
      return { content: [{ type: 'text', text: JSON.stringify(profile) }], structuredContent: profile }
    },
  }
}
