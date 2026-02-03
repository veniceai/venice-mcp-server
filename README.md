# Venice AI MCP Server 🚀

An official Model Context Protocol (MCP) server that enables Claude Code, Cline, and other AI agents to natively access Venice AI's capabilities.

## What This Does

This MCP server exposes Venice AI's full API as tools that AI coding assistants can use:

| Tool | Description |
|------|-------------|
| `venice_chat` | Text generation with any Venice model (uncensored, reasoning, coding) |
| `venice_image` | Image generation (Flux Pro, SDXL, Pony, Illustrious) |
| `venice_tts` | Text-to-speech with 60+ voices |
| `venice_embeddings` | Vector embeddings for RAG/semantic search |
| `venice_upscale` | Image upscaling and enhancement |
| `venice_models` | List available models |

## Why Use This

### Native AI-to-AI Integration
Instead of copy-pasting API responses, agents can directly call Venice. This enables:
- Claude Code generating images inline while coding a website
- Agents using uncensored models for creative writing tasks
- Multi-modal workflows (generate image → describe it → iterate)

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

\`\`\`json
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
\`\`\`

#### For Cline (VS Code)

Add to your Cline MCP settings:

\`\`\`json
{
  "venice": {
    "command": "npx",
    "args": ["@venice-ai/mcp-server"],
    "env": {
      "VENICE_API_KEY": "your-venice-api-key"
    }
  }
}
\`\`\`

#### Manual / Development

\`\`\`bash
# Clone and install
git clone https://github.com/veniceai/venice-mcp-server
cd venice-mcp-server
npm install

# Set your API key
export VENICE_API_KEY="your-key"

# Run the server
npm run dev
\`\`\`

## Available Tools

### \`venice_chat\`
Generate text using Venice's language models.

**Parameters:**
- \`prompt\` (required) - The user message
- \`model\` - Model ID (default: \`venice-uncensored\`)
- \`system_prompt\` - System message for context/persona
- \`temperature\` - 0-2 (default: 0.7)
- \`max_tokens\` - Max tokens (default: 4096)
- \`enable_web_search\` - \`on\`, \`off\`, or \`auto\`
- \`json_schema\` - JSON schema for structured output

**Popular models:**
- \`venice-uncensored\` — Uncensored, creative, any content
- \`llama-3.3-70b\` — General purpose, high quality
- \`qwen-2.5-coder-32b\` — Optimized for code
- \`deepseek-r1\` — Reasoning with step-by-step thinking

### \`venice_image\`
Generate images from text prompts.

**Parameters:**
- \`prompt\` (required) - Image description
- \`model\` - Model (default: \`flux-dev\`)
- \`width\` / \`height\` - Dimensions (default: 1024)
- \`style_preset\` - Style: photographic, anime, etc.
- \`negative_prompt\` - What to avoid
- \`seed\` - For reproducibility

### \`venice_tts\`
Convert text to speech.

**Parameters:**
- \`text\` (required) - Text to speak
- \`voice\` - Voice ID (default: \`alloy\`)
- \`speed\` - 0.25-4.0 (default: 1.0)
- \`response_format\` - mp3, opus, aac, flac, wav

### \`venice_embeddings\`
Generate vector embeddings for semantic search.

**Parameters:**
- \`input\` (required) - Text to embed
- \`model\` - Model (default: \`text-embedding-bge-m3\`)

### \`venice_upscale\`
Upscale images to higher resolution.

**Parameters:**
- \`image_url\` (required) - URL of image
- \`scale\` - 2 or 4 (default: 2)

### \`venice_models\`
List available models.

**Parameters:**
- \`type\` - Filter: text, image, audio, video, embeddings, all

## Usage Examples

Once configured, your AI agent can use Venice tools naturally:

### Text Generation
\`\`\`
User: "Use Venice to generate a creative story about a robot learning to paint"

Agent: [calls venice_chat with prompt, uses venice-uncensored model]
\`\`\`

### Image Generation
\`\`\`
User: "Generate a cyberpunk cityscape image with Venice"

Agent: [calls venice_image with detailed prompt]
"Generated image: https://venice-images.s3.../abc123.png"
\`\`\`

### Web Search + Generation
\`\`\`
User: "Research the latest AI news and write a summary"

Agent: [calls venice_chat with enable_web_search: "on"]
"Based on recent news: [summary with citations]"
\`\`\`

## License

MIT
