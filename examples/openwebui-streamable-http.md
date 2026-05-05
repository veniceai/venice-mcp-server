# Open WebUI / LibreChat / AnythingLLM (HTTP)

Run the server in HTTP mode, then point your MCP client at `http://localhost:3333/mcp`:

```bash
docker run --rm -p 3333:3333 \
  -e VENICE_API_KEY=<your-venice-api-key> \
  -e VENICE_MCP_HTTP=1 \
  ghcr.io/veniceai/venice-mcp-server:latest
```

In Open WebUI: Settings → Tools → Add MCP Server → URL `http://localhost:3333/mcp`.
