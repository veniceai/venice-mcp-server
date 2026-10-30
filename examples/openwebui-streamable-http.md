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

Keep `VENICE_MCP_AUTH_TOKEN` set even when you only reach the server over `localhost`. A loopback bind does not require it, so the server starts without one and warns, but it cannot tell which local process is calling — anything on the machine can then spend your Venice credentials.

The default Host allowlist supports `localhost:3333`, `127.0.0.1:3333`, and `[::1]:3333`. For a different hostname, reverse proxy, or mapped port, set `VENICE_MCP_ALLOWED_HOSTS` to the exact authority your client sends. For browser clients that send Origin, set `VENICE_MCP_ALLOWED_ORIGINS` to the exact browser application's origin (scheme, host, and non-default port). Both settings accept comma-separated entries, without wildcards. Native clients may omit Origin. Host/Origin checks run before authentication and body parsing, and forwarded headers do not bypass them.

The Origin allowlist does not enable CORS or browser preflight handling. Use Open WebUI's server-side MCP connection, or a trusted proxy configured for the intended browser origin.
