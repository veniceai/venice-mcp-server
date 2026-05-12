/**
 * MCP resources (read-only) under venice://.
 * Each resource is a function that, given the VeniceClient, returns the body.
 */
import type { VeniceClient } from './venice-client.js'
import { formatToolError } from './format.js'

export interface ResourceDef {
  uri: string
  name: string
  description: string
  mimeType: string
  read: () => Promise<{ uri: string; mimeType: string; text: string }>
}

export function buildResources(client: VeniceClient): ResourceDef[] {
  return [
    {
      uri: 'venice://models',
      name: 'Venice model catalog',
      description: 'Live catalog with prices and capability flags. Auth-free.',
      mimeType: 'application/json',
      read: async () => {
        try {
          const data = await client.get<unknown>('/v1/models')
          return {
            uri: 'venice://models',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          }
        } catch (err) {
          return {
            uri: 'venice://models',
            mimeType: 'text/plain',
            text: formatToolError(err),
          }
        }
      },
    },
    {
      uri: 'venice://styles',
      name: 'Image style presets',
      description: 'Available image style presets for venice_image_generate.',
      mimeType: 'application/json',
      read: async () => {
        try {
          const data = await client.get<unknown>('/v1/image/styles')
          return {
            uri: 'venice://styles',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          }
        } catch (err) {
          return {
            uri: 'venice://styles',
            mimeType: 'text/plain',
            text: formatToolError(err),
          }
        }
      },
    },
    {
      uri: 'venice://voices',
      name: 'Venice TTS voices',
      description: 'Available TTS voices including cloned voices.',
      mimeType: 'application/json',
      read: async () => {
        try {
          const data = await client.get<unknown>('/v1/audio/voices')
          return {
            uri: 'venice://voices',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          }
        } catch (err) {
          return {
            uri: 'venice://voices',
            mimeType: 'text/plain',
            text: formatToolError(err),
          }
        }
      },
    },
  ]
}
