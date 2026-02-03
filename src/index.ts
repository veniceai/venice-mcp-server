#!/usr/bin/env node
/**
 * Venice AI MCP Server
 * 
 * Exposes Venice's AI capabilities to Claude Code, Cline, and other MCP-compatible agents.
 * 
 * Features:
 * - Chat completions (all Venice text models)
 * - Image generation (Flux, SDXL, etc.)
 * - Text-to-speech (60+ voices)
 * - Embeddings for RAG
 * - Web search integration
 * 
 * Usage:
 *   VENICE_API_KEY=your-key venice-mcp-server
 * 
 * In Claude Code mcp.json:
 *   {
 *     "mcpServers": {
 *       "venice": {
 *         "command": "npx",
 *         "args": ["@venice-ai/mcp-server"],
 *         "env": { "VENICE_API_KEY": "your-key" }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import { z } from 'zod';

// Venice API client
const venice = new OpenAI({
  apiKey: process.env.VENICE_API_KEY || '',
  baseURL: 'https://api.venice.ai/api/v1',
});

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'venice_chat',
    description: `Generate text using Venice AI's uncensored language models. 
Supports all OpenAI-compatible parameters plus Venice extensions like web search.
Models include: venice-uncensored, llama-3.3-70b, qwen-2.5-coder-32b, deepseek-r1, and more.
Use for: creative writing, code generation, analysis, uncensored content, reasoning tasks.`,
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model ID. Popular choices: venice-uncensored (default, uncensored), llama-3.3-70b (general), qwen-2.5-coder-32b (coding), deepseek-r1 (reasoning)',
          default: 'venice-uncensored',
        },
        prompt: {
          type: 'string',
          description: 'The user prompt to send to the model',
        },
        system_prompt: {
          type: 'string',
          description: 'Optional system prompt to set context/persona',
        },
        temperature: {
          type: 'number',
          description: 'Sampling temperature 0-2. Lower = more deterministic (default: 0.7)',
          default: 0.7,
        },
        max_tokens: {
          type: 'integer',
          description: 'Maximum tokens to generate (default: 4096)',
          default: 4096,
        },
        enable_web_search: {
          type: 'string',
          enum: ['on', 'off', 'auto'],
          description: 'Enable web search. "on" forces search, "auto" lets model decide (default: off)',
          default: 'off',
        },
        json_schema: {
          type: 'object',
          description: 'Optional JSON schema for structured output. Model will return valid JSON matching this schema.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'venice_image',
    description: `Generate images using Venice AI's image models.
Supports: Flux Pro (highest quality), Flux Dev (fast), SDXL, Pony, Illustrious.
Completely uncensored — can generate any content.
Returns a URL to the generated image.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate. Be specific about style, composition, lighting, etc.',
        },
        model: {
          type: 'string',
          description: 'Image model. Options: flux-pro (best), flux-dev (fast), sdxl, pony, illustrious',
          default: 'flux-dev',
        },
        width: {
          type: 'integer',
          description: 'Image width in pixels (default: 1024)',
          default: 1024,
        },
        height: {
          type: 'integer',
          description: 'Image height in pixels (default: 1024)',
          default: 1024,
        },
        style_preset: {
          type: 'string',
          description: 'Optional style preset: photographic, digital-art, anime, comic-book, cinematic, etc.',
        },
        negative_prompt: {
          type: 'string',
          description: 'What to avoid in the image (e.g., "blurry, low quality, distorted")',
        },
        seed: {
          type: 'integer',
          description: 'Random seed for reproducibility',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'venice_tts',
    description: `Convert text to speech using Venice AI's TTS models.
60+ high-quality voices available across different styles and languages.
Returns a URL to the generated audio file.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to convert to speech',
        },
        voice: {
          type: 'string',
          description: 'Voice ID. Popular options: alloy, echo, fable, onyx, nova, shimmer (default: alloy)',
          default: 'alloy',
        },
        model: {
          type: 'string',
          description: 'TTS model (default: tts-1-hd)',
          default: 'tts-1-hd',
        },
        speed: {
          type: 'number',
          description: 'Speech speed 0.25-4.0 (default: 1.0)',
          default: 1.0,
        },
        response_format: {
          type: 'string',
          enum: ['mp3', 'opus', 'aac', 'flac', 'wav'],
          description: 'Audio format (default: mp3)',
          default: 'mp3',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'venice_embeddings',
    description: `Generate vector embeddings for semantic search and RAG applications.
Uses BGE-M3, a powerful multilingual embedding model.
Returns a float array representing the semantic meaning of the input.`,
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Text to generate embeddings for',
        },
        model: {
          type: 'string',
          description: 'Embedding model (default: text-embedding-bge-m3)',
          default: 'text-embedding-bge-m3',
        },
      },
      required: ['input'],
    },
  },
  {
    name: 'venice_upscale',
    description: `Upscale and enhance images using Venice AI.
Increases resolution up to 4x while preserving details.
Input can be a URL or base64 image.`,
    inputSchema: {
      type: 'object',
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of the image to upscale',
        },
        scale: {
          type: 'integer',
          description: 'Upscale factor: 2 or 4 (default: 2)',
          default: 2,
        },
      },
      required: ['image_url'],
    },
  },
  {
    name: 'venice_models',
    description: `List available Venice AI models.
Returns models grouped by type: text, image, audio, video, embeddings.
Use this to discover which models are available for other Venice tools.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['text', 'image', 'audio', 'video', 'embeddings', 'all'],
          description: 'Filter by model type (default: all)',
          default: 'all',
        },
      },
    },
  },
];

// Tool handlers
async function handleChat(args: Record<string, unknown>): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  
  if (args.system_prompt) {
    messages.push({ role: 'system', content: String(args.system_prompt) });
  }
  
  messages.push({ role: 'user', content: String(args.prompt) });
  
  const params: OpenAI.ChatCompletionCreateParams = {
    model: String(args.model || 'venice-uncensored'),
    messages,
    temperature: Number(args.temperature ?? 0.7),
    max_tokens: Number(args.max_tokens ?? 4096),
  };
  
  // Venice-specific parameters
  const veniceParams: Record<string, unknown> = {};
  if (args.enable_web_search && args.enable_web_search !== 'off') {
    veniceParams.enable_web_search = args.enable_web_search;
  }
  
  if (Object.keys(veniceParams).length > 0) {
    (params as any).venice_parameters = veniceParams;
  }
  
  // JSON schema for structured output
  if (args.json_schema) {
    params.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema: args.json_schema as Record<string, unknown>,
      },
    };
  }
  
  const response = await venice.chat.completions.create(params);
  const content = response.choices[0]?.message?.content || '';
  
  // Include usage info
  const usage = response.usage;
  const usageInfo = usage 
    ? `\n\n[Tokens: ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion = ${usage.total_tokens} total]`
    : '';
  
  return content + usageInfo;
}

async function handleImage(args: Record<string, unknown>): Promise<string> {
  const model = String(args.model || 'flux-dev');
  
  // Venice image generation endpoint
  const response = await fetch('https://api.venice.ai/api/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: String(args.prompt),
      width: Number(args.width || 1024),
      height: Number(args.height || 1024),
      style_preset: args.style_preset,
      negative_prompt: args.negative_prompt,
      seed: args.seed,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image generation failed: ${error}`);
  }
  
  const data = await response.json() as { data: Array<{ url: string }> };
  const imageUrl = data.data?.[0]?.url;
  
  if (!imageUrl) {
    throw new Error('No image URL in response');
  }
  
  return `Generated image: ${imageUrl}\n\nPrompt: ${args.prompt}\nModel: ${model}\nSize: ${args.width || 1024}x${args.height || 1024}`;
}

async function handleTTS(args: Record<string, unknown>): Promise<string> {
  const response = await fetch('https://api.venice.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: String(args.model || 'tts-1-hd'),
      input: String(args.text),
      voice: String(args.voice || 'alloy'),
      speed: Number(args.speed || 1.0),
      response_format: String(args.response_format || 'mp3'),
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`TTS failed: ${error}`);
  }
  
  // For TTS, Venice returns the audio directly or a URL
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('audio')) {
    // Binary audio response - would need to save to file in real implementation
    return `Audio generated successfully. Voice: ${args.voice || 'alloy'}, Speed: ${args.speed || 1.0}x\n\nNote: Audio binary returned. In production, this would be saved to a file.`;
  }
  
  const data = await response.json() as { url?: string };
  return `Generated audio: ${data.url || 'Audio data returned'}\n\nText: "${String(args.text).slice(0, 100)}..."\nVoice: ${args.voice || 'alloy'}`;
}

async function handleEmbeddings(args: Record<string, unknown>): Promise<string> {
  const response = await venice.embeddings.create({
    model: String(args.model || 'text-embedding-bge-m3'),
    input: String(args.input),
  });
  
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('No embedding in response');
  }
  
  // Return summary (full vector would be too long)
  return `Generated embedding vector with ${embedding.length} dimensions.\n\nFirst 10 values: [${embedding.slice(0, 10).map(v => v.toFixed(4)).join(', ')}...]\n\nInput: "${String(args.input).slice(0, 100)}..."`;
}

async function handleUpscale(args: Record<string, unknown>): Promise<string> {
  const response = await fetch('https://api.venice.ai/api/v1/images/upscale', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: String(args.image_url),
      scale: Number(args.scale || 2),
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upscale failed: ${error}`);
  }
  
  const data = await response.json() as { url?: string; data?: Array<{ url: string }> };
  const resultUrl = data.url || data.data?.[0]?.url;
  
  return `Upscaled image: ${resultUrl}\n\nOriginal: ${args.image_url}\nScale: ${args.scale || 2}x`;
}

async function handleModels(args: Record<string, unknown>): Promise<string> {
  const response = await venice.models.list();
  const models = response.data;
  
  const typeFilter = String(args.type || 'all').toLowerCase();
  
  // Group by type
  const grouped: Record<string, string[]> = {
    text: [],
    image: [],
    audio: [],
    video: [],
    embeddings: [],
  };
  
  for (const model of models) {
    const id = model.id;
    // Categorize based on model ID patterns
    if (id.includes('embed') || id.includes('bge')) {
      grouped.embeddings.push(id);
    } else if (id.includes('flux') || id.includes('sdxl') || id.includes('pony') || id.includes('illustrious')) {
      grouped.image.push(id);
    } else if (id.includes('tts') || id.includes('whisper') || id.includes('speech')) {
      grouped.audio.push(id);
    } else if (id.includes('video') || id.includes('minimax') || id.includes('kling')) {
      grouped.video.push(id);
    } else {
      grouped.text.push(id);
    }
  }
  
  let output = '# Venice AI Models\n\n';
  
  const types = typeFilter === 'all' 
    ? ['text', 'image', 'audio', 'video', 'embeddings']
    : [typeFilter];
  
  for (const type of types) {
    const list = grouped[type] || [];
    if (list.length > 0) {
      output += `## ${type.charAt(0).toUpperCase() + type.slice(1)} Models (${list.length})\n`;
      output += list.map(m => `- ${m}`).join('\n');
      output += '\n\n';
    }
  }
  
  return output;
}

// Main server setup
async function main() {
  if (!process.env.VENICE_API_KEY) {
    console.error('Error: VENICE_API_KEY environment variable is required');
    console.error('Get your API key at: https://venice.ai/settings/api');
    process.exit(1);
  }
  
  const server = new Server(
    {
      name: 'venice-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  
  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      let result: string;
      
      switch (name) {
        case 'venice_chat':
          result = await handleChat(args || {});
          break;
        case 'venice_image':
          result = await handleImage(args || {});
          break;
        case 'venice_tts':
          result = await handleTTS(args || {});
          break;
        case 'venice_embeddings':
          result = await handleEmbeddings(args || {});
          break;
        case 'venice_upscale':
          result = await handleUpscale(args || {});
          break;
        case 'venice_models':
          result = await handleModels(args || {});
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
  
  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Venice MCP Server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
