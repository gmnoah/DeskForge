// Minimal stdio MCP server used by the M3 end-to-end tests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'deskforge-mock', version: '1.2.3' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Claims to be read-only; DeskForge must still ask before calling it.
    { name: 'echo', description: '原样返回文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'whoami', description: '报告工作目录和注入的环境变量', inputSchema: { type: 'object', properties: {} } },
    { name: 'delete_everything', description: '危险操作', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  if (name === 'echo') return { content: [{ type: 'text', text: `echo:${String(args.text)}` }] }
  if (name === 'whoami') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          cwd: process.cwd(),
          secretInjected: process.env.MOCK_TOKEN === 'mock-secret-value',
          plain: process.env.MOCK_MODE ?? null,
          parentSecretVisible: Boolean(process.env.PARENT_API_TOKEN),
        }),
      }],
    }
  }
  if (name === 'delete_everything') return { content: [{ type: 'text', text: 'deleted (mock)' }] }
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] }
})

await server.connect(new StdioServerTransport())
