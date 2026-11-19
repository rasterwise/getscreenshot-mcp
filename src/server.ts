/**
 * Builds a GetScreenshot MCP server for one context: a process (stdio) or a
 * single HTTP request (hosted, stateless).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS, registerTools, type ServerContext } from "./tools.js";
import { AGENTS_URL, VERSION } from "./version.js";

export const SERVER_NAME = "getscreenshot";
export const SERVER_TITLE = "GetScreenshot";

export function createServer(context: ServerContext = {}): McpServer {
  const ctx: ServerContext = { ...context, apiKey: context.apiKey?.trim() || undefined };
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: VERSION,
      websiteUrl: AGENTS_URL,
    },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server, ctx);
  return server;
}

export type { ServerContext, PreviewGate, ToolCallEvent } from "./tools.js";
