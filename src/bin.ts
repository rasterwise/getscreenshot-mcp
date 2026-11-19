#!/usr/bin/env node
/**
 * Single entry point for the `getscreenshot-mcp` bin.
 *
 *   getscreenshot-mcp            MCP server on stdio (what MCP clients launch)
 *   getscreenshot-mcp --http     hosted Streamable HTTP server
 *   getscreenshot-mcp <command>  CLI: capture, pdf, usage, --help, --version
 *
 * Each mode is imported lazily so the CLI does not load the MCP SDK or sharp.
 */
const args = process.argv.slice(2);
const first = args[0];

async function main(): Promise<void> {
  if (first === undefined || first === "--stdio" || first === "stdio") {
    const { runStdio } = await import("./stdio.js");
    if (process.stdin.isTTY) {
      process.stderr.write(
        "getscreenshot-mcp is waiting for an MCP client on stdin. Run `getscreenshot-mcp --help` for the command-line interface.\n",
      );
    }
    await runStdio();
    return;
  }
  if (first === "--http" || first === "http") {
    const { runHttp } = await import("./http.js");
    await runHttp();
    return;
  }
  const { runCli } = await import("./cli.js");
  process.exitCode = await runCli(args);
}

main().catch((err: unknown) => {
  process.stderr.write(`getscreenshot-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
