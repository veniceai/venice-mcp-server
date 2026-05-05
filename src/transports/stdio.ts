import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from '../server.js'

/** Run the server over stdio (for Claude Desktop, Cursor, LM Studio, etc.). */
export async function runStdio(): Promise<void> {
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Keep the process alive; stdio transport closes when stdin closes.
}
