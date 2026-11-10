# Open WebUI / LibreChat / AnythingLLM (HTTP)

With Node.js 20 or newer, run the pinned npm release in HTTP mode:

```bash
VENICE_API_KEY='<your-venice-api-key>' \
VENICE_MCP_AUTH_TOKEN='<choose-a-long-random-token>' \
VENICE_MCP_HOST=0.0.0.0 \
PORT=3333 \
npx -y @veniceai/mcp-server@0.3.2 --http
```

Configure Open WebUI's server-side MCP connection with URL `http://localhost:3333/mcp` and header `Authorization: Bearer <choose-a-long-random-token>`. If Open WebUI runs in a container or on another machine, replace `localhost` with an address reachable from that environment and allow its authority below.

`VENICE_MCP_HOST=0.0.0.0` binds beyond loopback and requires a long random `VENICE_MCP_AUTH_TOKEN` (at least 16 characters). Omit `VENICE_MCP_HOST` to use `127.0.0.1`; keep the token configured for local use too. Do not publish `/mcp` to an untrusted network without that token or an authenticated reverse proxy; callers can invoke tools using the server's Venice credentials.

A loopback bind does not require the token, so the server starts without one and warns, but it cannot tell which local process is calling. Anything on the machine can then spend your Venice credentials.

The default Host allowlist supports `localhost:3333`, `127.0.0.1:3333`, and `[::1]:3333` with the port above. For a different hostname, reverse proxy, or mapped port, set `VENICE_MCP_ALLOWED_HOSTS` to the exact authority your client sends (host and non-default port). For browser clients that send Origin, set `VENICE_MCP_ALLOWED_ORIGINS` to the exact browser application's origin (scheme, host, and non-default port). Both settings accept comma-separated entries, without wildcards, and replace their default lists; include any local entries you still use. Native clients may omit Origin. Host/Origin checks run before authentication and body parsing, and forwarded headers do not bypass them.

The Origin allowlist does not enable CORS or browser preflight handling. Use Open WebUI's server-side MCP connection, or a trusted proxy configured for the intended browser origin.
