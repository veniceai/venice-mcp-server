#!/usr/bin/env node
/**
 * Venice AI MCP Server
 * 
 * Exposes Venice's AI capabilities to Claude Code, Cline, and other MCP-compatible agents.
 * 
 * Features:
 * - Chat completions (all Venice text models)
 * - Image generation (Flux, SDXL, etc.)
 * - Image editing (AI-powered edits with prompts)
 * - Background removal
 * - Text-to-speech (60+ voices)
 * - Speech-to-text transcription
 * - Video generation (Kling, Minimax, etc.)
 * - Embeddings for RAG
 * - Venice Characters
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

// Venice API client
const venice = new OpenAI({
  apiKey: process.env.VENICE_API_KEY || '',
  baseURL: 'https://api.venice.ai/api/v1',
});

const VENICE_API_BASE = 'https://api.venice.ai/api/v1';

// Tool definitions
const TOOLS: Tool[] = [
  // ============ TEXT ============
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
        character: {
          type: 'string',
          description: 'Optional Venice character slug to use (e.g., "venice-uncensored", "aria"). Get available characters with venice_characters.',
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

  // ============ CHARACTERS ============
  {
    name: 'venice_characters',
    description: `List available Venice AI characters.
Characters are pre-configured personas with unique personalities, knowledge, and capabilities.
Some characters may be adult/NSFW. Use the slug with venice_chat to chat with a character.`,
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Optional: Get details for a specific character by slug',
        },
      },
    },
  },

  // ============ IMAGE GENERATION ============
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
          description: 'Image model. Options: flux-2-pro (best), flux-2-max (fast), lustify-sdxl',
          default: 'flux-2-max',
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

  // ============ IMAGE EDITING ============
  {
    name: 'venice_image_edit',
    description: `Edit an image using AI with a text prompt.
Describe the changes you want and Venice will apply them to the image.
Examples: "make the sky sunset colors", "add a cat sitting on the chair", "change her dress to red"`,
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Image as a URL or base64-encoded string',
        },
        prompt: {
          type: 'string',
          description: 'Description of the edit to apply (e.g., "make the background a beach scene")',
        },
      },
      required: ['image', 'prompt'],
    },
  },

  // ============ BACKGROUND REMOVAL ============
  {
    name: 'venice_background_remove',
    description: `Remove the background from an image.
Returns a PNG with transparent background.
Works great for product photos, portraits, and objects.`,
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Image as a URL or base64-encoded string',
        },
      },
      required: ['image'],
    },
  },

  // ============ IMAGE UPSCALE ============
  {
    name: 'venice_upscale',
    description: `Upscale and enhance images using Venice AI.
Increases resolution up to 4x while preserving details.
Input can be a URL or base64 image.`,
    inputSchema: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Image URL or base64-encoded string to upscale',
        },
        scale: {
          type: 'integer',
          description: 'Upscale factor: 2 or 4 (default: 2)',
          default: 2,
        },
      },
      required: ['image'],
    },
  },

  // ============ VIDEO GENERATION ============
  {
    name: 'venice_video_generate',
    description: `Generate a video using Venice AI's video models.
This is an async operation - returns a queue_id to check status with venice_video_status.
Models: kling-1.6-pro, kling-1.6-standard, minimax-video-01, luma-ray-2
Supports: text-to-video, image-to-video, video-to-video`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Description of the video to generate',
        },
        model: {
          type: 'string',
          description: 'Video model: kling-2.6-pro-text-to-video (best), kling-2.5-turbo-pro-text-to-video (faster). For image-to-video use kling-2.6-pro-image-to-video',
          default: 'kling-2.6-pro-text-to-video',
        },
        image_url: {
          type: 'string',
          description: 'Optional starting image URL for image-to-video generation',
        },
        end_image_url: {
          type: 'string',
          description: 'Optional ending image URL (for models that support it)',
        },
        video_url: {
          type: 'string',
          description: 'Optional source video URL for video-to-video generation',
        },
        duration: {
          type: 'string',
          description: 'Video duration: "5s" or "10s"',
          default: '5s',
        },
        aspect_ratio: {
          type: 'string',
          description: 'Aspect ratio (required): "16:9", "9:16", "1:1"',
          default: '16:9',
        },
        negative_prompt: {
          type: 'string',
          description: 'What to avoid in the video',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'venice_video_status',
    description: `Check the status of a video generation job.
Use the queue_id returned from venice_video_generate.
Returns status (queued, processing, completed, failed) and video URL when ready.`,
    inputSchema: {
      type: 'object',
      properties: {
        queue_id: {
          type: 'string',
          description: 'The queue_id returned from venice_video_generate',
        },
      },
      required: ['queue_id'],
    },
  },

  // ============ AUDIO - TTS ============
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
          description: 'TTS model (default: tts-kokoro)',
          default: 'tts-kokoro',
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

  // ============ AUDIO - TRANSCRIPTION ============
  {
    name: 'venice_transcribe',
    description: `Transcribe audio to text using Venice AI's speech recognition.
Supports: mp3, mp4, mpeg, mpga, m4a, wav, webm (max 25MB).
Can transcribe in multiple languages and optionally include timestamps.`,
    inputSchema: {
      type: 'object',
      properties: {
        audio_url: {
          type: 'string',
          description: 'URL of the audio file to transcribe',
        },
        model: {
          type: 'string',
          description: 'Transcription model (default: openai/whisper-large-v3)',
          default: 'openai/whisper-large-v3',
        },
        language: {
          type: 'string',
          description: 'Optional language code (e.g., "en", "es", "fr"). Auto-detected if not specified.',
        },
        timestamps: {
          type: 'boolean',
          description: 'Include word-level timestamps in response (default: false)',
          default: false,
        },
        response_format: {
          type: 'string',
          enum: ['json', 'text', 'verbose_json'],
          description: 'Response format (default: json)',
          default: 'json',
        },
      },
      required: ['audio_url'],
    },
  },

  // ============ EMBEDDINGS ============
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

  // ============ MODELS ============
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

// ============ TOOL HANDLERS ============

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
  if (args.character) {
    veniceParams.character_slug = args.character;
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

async function handleCharacters(args: Record<string, unknown>): Promise<string> {
  const slug = args.slug ? String(args.slug) : null;
  
  const endpoint = slug 
    ? `${VENICE_API_BASE}/characters/${slug}`
    : `${VENICE_API_BASE}/characters`;
  
  const response = await fetch(endpoint, {
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
    },
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch characters: ${error}`);
  }
  
  const data = await response.json() as any;
  
  if (slug) {
    // Single character response
    return `# ${data.name}\n\n${data.description || 'No description'}\n\n**Slug:** ${data.slug}\n**Model:** ${data.modelId || 'default'}\n**Adult:** ${data.adult ? 'Yes' : 'No'}\n**Web Search:** ${data.webEnabled ? 'Yes' : 'No'}`;
  }
  
  // List response
  const characters = data.data || [];
  let output = `# Venice AI Characters (${characters.length})\n\n`;
  
  for (const char of characters.slice(0, 50)) {
    output += `## ${char.name}\n`;
    output += `**Slug:** \`${char.slug}\`\n`;
    if (char.description) output += `${char.description.slice(0, 200)}${char.description.length > 200 ? '...' : ''}\n`;
    output += `Adult: ${char.adult ? 'Yes' : 'No'}\n\n`;
  }
  
  if (characters.length > 50) {
    output += `\n... and ${characters.length - 50} more characters`;
  }
  
  return output;
}

async function handleImage(args: Record<string, unknown>): Promise<string> {
  const model = String(args.model || 'flux-2-max');
  const width = Number(args.width || 1024);
  const height = Number(args.height || 1024);
  const size = `${width}x${height}`;
  
  // Use OpenAI-compatible endpoint with size parameter
  const response = await fetch(`${VENICE_API_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: String(args.prompt),
      size,
      response_format: 'url',
      style_preset: args.style_preset,
      negative_prompt: args.negative_prompt,
      seed: args.seed,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image generation failed: ${error}`);
  }
  
  const data = await response.json() as { data?: Array<{ url: string }> };
  const imageUrl = data.data?.[0]?.url;
  
  if (!imageUrl) {
    throw new Error('No image URL in response');
  }
  
  return `Generated image (data URL): ${imageUrl.slice(0, 100)}...\n\nPrompt: ${args.prompt}\nModel: ${model}\nSize: ${size}`;
}

async function handleImageEdit(args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${VENICE_API_BASE}/image/edit`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: String(args.image),
      prompt: String(args.prompt),
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image edit failed: ${error}`);
  }
  
  // Response is the edited image binary - check content type
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('image')) {
    // In production, you'd save this and return a URL
    return `Image edited successfully.\n\nEdit prompt: "${args.prompt}"\n\nNote: The edited image was returned as binary data. In production, this would be saved and a URL returned.`;
  }
  
  const data = await response.json() as { url?: string };
  return `Edited image: ${data.url}\n\nEdit prompt: "${args.prompt}"`;
}

async function handleBackgroundRemove(args: Record<string, unknown>): Promise<string> {
  const imageInput = String(args.image);
  
  // Determine if input is URL or base64
  const isUrl = imageInput.startsWith('http://') || imageInput.startsWith('https://');
  
  const body: Record<string, string> = {};
  if (isUrl) {
    body.image_url = imageInput;
  } else {
    // Assume base64, wrap as data URL if needed
    if (imageInput.startsWith('data:')) {
      body.image_url = imageInput;
    } else {
      body.image_url = `data:image/png;base64,${imageInput}`;
    }
  }
  
  const response = await fetch(`${VENICE_API_BASE}/image/background-remove`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Background removal failed: ${error}`);
  }
  
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('image')) {
    return `Background removed successfully.\n\nNote: The image with transparent background was returned as binary PNG data.`;
  }
  
  const data = await response.json() as { url?: string };
  return `Background removed: ${data.url}`;
}

async function handleUpscale(args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${VENICE_API_BASE}/image/upscale`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: String(args.image),
      scale: Number(args.scale || 2),
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upscale failed: ${error}`);
  }
  
  const data = await response.json() as { url?: string; data?: Array<{ url: string }> };
  const resultUrl = data.url || data.data?.[0]?.url;
  
  return `Upscaled image: ${resultUrl}\n\nScale: ${args.scale || 2}x`;
}

async function handleVideoGenerate(args: Record<string, unknown>): Promise<string> {
  const model = String(args.model || 'kling-2.6-pro-text-to-video');
  
  // Ensure duration has 's' suffix
  let duration = String(args.duration || '5s');
  if (!duration.endsWith('s')) duration += 's';
  
  const body: Record<string, unknown> = {
    model,
    prompt: String(args.prompt),
    duration,
    aspect_ratio: String(args.aspect_ratio || '16:9'),
  };
  
  if (args.image_url) body.image_url = String(args.image_url);
  if (args.end_image_url) body.end_image_url = String(args.end_image_url);
  if (args.video_url) body.video_url = String(args.video_url);
  if (args.negative_prompt) body.negative_prompt = String(args.negative_prompt);
  
  const response = await fetch(`${VENICE_API_BASE}/video/queue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Video generation failed: ${error}`);
  }
  
  const data = await response.json() as { queue_id: string; model: string };
  
  return `Video generation queued!\n\n**Queue ID:** ${data.queue_id}\n**Model:** ${data.model}\n\nUse \`venice_video_status\` with this queue_id to check progress and get the video URL when ready.\n\nTypical generation time: 1-5 minutes depending on duration and model.`;
}

async function handleVideoStatus(args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${VENICE_API_BASE}/video/retrieve`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      queue_id: String(args.queue_id),
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get video status: ${error}`);
  }
  
  const data = await response.json() as { 
    status: string; 
    video_url?: string; 
    error?: string;
    progress?: number;
  };
  
  let output = `**Status:** ${data.status}\n`;
  
  if (data.progress !== undefined) {
    output += `**Progress:** ${data.progress}%\n`;
  }
  
  if (data.status === 'completed' && data.video_url) {
    output += `\n✅ **Video ready!**\n${data.video_url}`;
  } else if (data.status === 'failed') {
    output += `\n❌ **Generation failed**\n${data.error || 'Unknown error'}`;
  } else {
    output += `\nVideo is still processing. Check again in a moment.`;
  }
  
  return output;
}

async function handleTTS(args: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${VENICE_API_BASE}/audio/speech`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: String(args.model || 'tts-kokoro'),
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
  
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('audio')) {
    return `Audio generated successfully.\n\n**Voice:** ${args.voice || 'alloy'}\n**Speed:** ${args.speed || 1.0}x\n**Text:** "${String(args.text).slice(0, 100)}${String(args.text).length > 100 ? '...' : ''}"`;
  }
  
  const data = await response.json() as { url?: string };
  return `Generated audio: ${data.url}\n\n**Voice:** ${args.voice || 'alloy'}\n**Text:** "${String(args.text).slice(0, 100)}..."`;
}

async function handleTranscribe(args: Record<string, unknown>): Promise<string> {
  const audioUrl = String(args.audio_url);
  const model = String(args.model || 'openai/whisper-large-v3');
  
  // Download the audio file first
  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio from URL: ${audioResponse.statusText}`);
  }
  
  const audioBuffer = await audioResponse.arrayBuffer();
  const audioBlob = new Blob([audioBuffer]);
  
  // Determine filename from URL or use default
  const urlParts = audioUrl.split('/');
  const filename = urlParts[urlParts.length - 1]?.split('?')[0] || 'audio.mp3';
  
  // Create FormData for multipart upload
  const formData = new FormData();
  formData.append('file', audioBlob, filename);
  formData.append('model', model);
  if (args.language) formData.append('language', String(args.language));
  if (args.timestamps) formData.append('timestamps', 'true');
  if (args.response_format) formData.append('response_format', String(args.response_format));
  
  const response = await fetch(`${VENICE_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VENICE_API_KEY}`,
    },
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Transcription failed: ${error}`);
  }
  
  const contentType = response.headers.get('content-type');
  
  if (contentType?.includes('text/plain')) {
    const text = await response.text();
    return `# Transcription\n\n${text}`;
  }
  
  const data = await response.json() as { text: string; duration?: number; language?: string };
  
  let output = `# Transcription\n\n${data.text}\n\n`;
  if (data.duration) output += `**Duration:** ${data.duration.toFixed(1)}s\n`;
  if (data.language) output += `**Language:** ${data.language}\n`;
  
  return output;
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
  
  return `Generated embedding vector with ${embedding.length} dimensions.\n\nFirst 10 values: [${embedding.slice(0, 10).map(v => v.toFixed(4)).join(', ')}...]\n\nInput: "${String(args.input).slice(0, 100)}..."`;
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
    if (id.includes('embed') || id.includes('bge')) {
      grouped.embeddings.push(id);
    } else if (id.includes('flux') || id.includes('sdxl') || id.includes('pony') || id.includes('illustrious')) {
      grouped.image.push(id);
    } else if (id.includes('tts') || id.includes('whisper') || id.includes('speech')) {
      grouped.audio.push(id);
    } else if (id.includes('video') || id.includes('minimax') || id.includes('kling') || id.includes('luma')) {
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

// ============ MAIN ============

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
        case 'venice_characters':
          result = await handleCharacters(args || {});
          break;
        case 'venice_image':
          result = await handleImage(args || {});
          break;
        case 'venice_image_edit':
          result = await handleImageEdit(args || {});
          break;
        case 'venice_background_remove':
          result = await handleBackgroundRemove(args || {});
          break;
        case 'venice_upscale':
          result = await handleUpscale(args || {});
          break;
        case 'venice_video_generate':
          result = await handleVideoGenerate(args || {});
          break;
        case 'venice_video_status':
          result = await handleVideoStatus(args || {});
          break;
        case 'venice_tts':
          result = await handleTTS(args || {});
          break;
        case 'venice_transcribe':
          result = await handleTranscribe(args || {});
          break;
        case 'venice_embeddings':
          result = await handleEmbeddings(args || {});
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
