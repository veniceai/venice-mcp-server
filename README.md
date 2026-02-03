# Venice AI MCP Server 🚀

An official Model Context Protocol (MCP) server that enables Claude Code, Cline, and other AI agents to natively access Venice AI's full capabilities.

## What This Does

This MCP server exposes Venice AI's complete API as tools that AI coding assistants can use:

### Text & Chat
| Tool | Description |
|------|-------------|
| `venice_chat` | Text generation with any Venice model (uncensored, reasoning, coding) |
| `venice_characters` | List and use Venice AI characters with unique personas |

### Image
| Tool | Description |
|------|-------------|
| `venice_image` | Image generation (Flux Pro, SDXL, Pony, Illustrious) |
| `venice_image_edit` | AI-powered image editing with text prompts |
| `venice_background_remove` | Remove backgrounds from images |
| `venice_upscale` | Upscale images 2x or 4x |

### Video
| Tool | Description |
|------|-------------|
| `venice_video_generate` | Generate videos (Kling, Minimax, Luma) - async |
| `venice_video_status` | Check video generation progress and get URL |

### Audio
| Tool | Description |
|------|-------------|
| `venice_tts` | Text-to-speech with 60+ voices |
| `venice_transcribe` | Speech-to-text transcription (Whisper) |

### Other
| Tool | Description |
|------|-------------|
| `venice_embeddings` | Vector embeddings for RAG/semantic search |
| `venice_models` | List available models |

## Why Use This

### Native AI-to-AI Integration
Instead of copy-pasting API responses, agents can directly call Venice. This enables:
- Claude Code generating images inline while coding a website
- Agents using uncensored models for creative writing tasks
- Multi-modal workflows (generate image → edit it → describe it → iterate)
- Video generation from within coding sessions

### Uncensored Capabilities for Agents
Most AI agent tools are limited to censored models. Venice MCP Server gives agents access to:
- **venice-uncensored** for unrestricted text generation
- **Uncensored image generation** (no NSFW filters)
- **Any content type** without refusals

### Privacy-First Agent Workflows
Venice's zero-retention policy applies to MCP calls too. Build agents that:
- Process sensitive data without logging
- Handle confidential documents
- Operate in regulated industries

## Quick Start

### Prerequisites
- Node.js 18+
- Venice API key ([get one here](https://venice.ai/settings/api))

### Installation

#### For Claude Code / Claude Desktop

Add to your MCP config (`~/.config/claude/mcp.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "venice": {
      "command": "npx",
      "args": ["@venice-ai/mcp-server"],
      "env": {
        "VENICE_API_KEY": "your-venice-api-key"
      }
    }
  }
}
```

#### For Cline (VS Code)

Add to your Cline MCP settings:

```json
{
  "venice": {
    "command": "npx",
    "args": ["@venice-ai/mcp-server"],
    "env": {
      "VENICE_API_KEY": "your-venice-api-key"
    }
  }
}
```

#### Manual / Development

```bash
# Clone and install
git clone https://github.com/veniceai/venice-mcp-server
cd venice-mcp-server
npm install

# Set your API key
export VENICE_API_KEY="your-key"

# Run the server
npm run dev
```

## Tool Reference

### `venice_chat`
Generate text using Venice's language models.

**Parameters:**
- `prompt` (required) - The user message
- `model` - Model ID (default: `venice-uncensored`)
- `system_prompt` - System message for context/persona
- `character` - Venice character slug to use
- `temperature` - 0-2 (default: 0.7)
- `max_tokens` - Max tokens (default: 4096)
- `enable_web_search` - `on`, `off`, or `auto`
- `json_schema` - JSON schema for structured output

**Popular models:**
- `venice-uncensored` — Uncensored, creative, any content
- `llama-3.3-70b` — General purpose, high quality
- `qwen-2.5-coder-32b` — Optimized for code
- `deepseek-r1` — Reasoning with step-by-step thinking

### `venice_characters`
List available Venice AI characters or get details about a specific one.

**Parameters:**
- `slug` - Optional character slug to get details

### `venice_image`
Generate images from text prompts.

**Parameters:**
- `prompt` (required) - Image description
- `model` - Model (default: `flux-dev`)
- `width` / `height` - Dimensions (default: 1024)
- `style_preset` - Style: photographic, anime, etc.
- `negative_prompt` - What to avoid
- `seed` - For reproducibility

### `venice_image_edit`
Edit an existing image using AI with a text prompt.

**Parameters:**
- `image` (required) - Image URL or base64
- `prompt` (required) - Description of the edit

### `venice_background_remove`
Remove the background from an image.

**Parameters:**
- `image` (required) - Image URL or base64

### `venice_upscale`
Upscale an image to higher resolution.

**Parameters:**
- `image` (required) - Image URL or base64
- `scale` - 2 or 4 (default: 2)

### `venice_video_generate`
Start an async video generation job.

**Parameters:**
- `prompt` (required) - Video description
- `model` - Video model (default: `kling-1.6-standard`)
- `image_url` - Starting image for image-to-video
- `end_image_url` - Ending image (some models)
- `video_url` - Source video for video-to-video
- `duration` - "5" or "10" seconds
- `aspect_ratio` - "16:9", "9:16", "1:1"
- `negative_prompt` - What to avoid

**Models:**
- `kling-1.6-pro` — Highest quality
- `kling-1.6-standard` — Good balance
- `minimax-video-01` — Fast
- `luma-ray-2` — Cinematic

### `venice_video_status`
Check video generation progress.

**Parameters:**
- `queue_id` (required) - From venice_video_generate

### `venice_tts`
Convert text to speech.

**Parameters:**
- `text` (required) - Text to speak
- `voice` - Voice ID (default: `alloy`)
- `speed` - 0.25-4.0 (default: 1.0)
- `response_format` - mp3, opus, aac, flac, wav

### `venice_transcribe`
Transcribe audio to text.

**Parameters:**
- `audio_url` (required) - URL of audio file
- `model` - Model (default: `whisper-large-v3`)
- `language` - Language code (auto-detected if not specified)
- `timestamps` - Include word timestamps
- `response_format` - json, text, verbose_json

### `venice_embeddings`
Generate vector embeddings.

**Parameters:**
- `input` (required) - Text to embed
- `model` - Model (default: `text-embedding-bge-m3`)

### `venice_models`
List available models.

**Parameters:**
- `type` - Filter: text, image, audio, video, embeddings, all

## Usage Examples

### Text Generation
```
User: "Use Venice to write an uncensored story about..."

Agent: [calls venice_chat with prompt]
```

### Image Generation + Editing
```
User: "Generate a portrait and make the background a sunset"

Agent: 
1. [calls venice_image to generate portrait]
2. [calls venice_image_edit with "make the background a sunset"]
```

### Video Generation
```
User: "Create a video of a cat playing piano"

Agent:
1. [calls venice_video_generate with prompt]
   → Returns queue_id
2. [waits, then calls venice_video_status]
   → Returns video URL when ready
```

### Web Search + Generation
```
User: "Research the latest AI news and write a summary"

Agent: [calls venice_chat with enable_web_search: "on"]
```

## License

MIT
