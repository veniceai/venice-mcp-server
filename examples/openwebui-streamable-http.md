# Open WebUI / LibreChat / AnythingLLM (HTTP)

Run the server in HTTP mode, then point your MCP client at `http://localhost:3333/mcp`:

```bash
docker run --rm -p 3333:3333 \
  -e VENICE_API_KEY=<your-venice-api-key> \
  -e VENICE_MCP_AUTH_TOKEN=<choose-a-long-random-token> \
  -e VENICE_MCP_HTTP=1 \
  ghcr.io/veniceai/venice-mcp-server:latest
```

In Open WebUI: Settings → Tools → Add MCP Server → URL `http://localhost:3333/mcp` and send `Authorization: Bearer <choose-a-long-random-token>` if your client supports custom headers.

The Docker image binds to `0.0.0.0`, so startup requires `VENICE_MCP_AUTH_TOKEN` by default. Do not publish `/mcp` to an untrusted network without that token or an authenticated reverse proxy; callers can invoke tools using the server's Venice credentials.
