import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// package.json sits one level above both src/ (tests) and dist/ (published build).
const pkg = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
export const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`;

export const PRICING_URL = "https://www.getscreenshotapi.com/#pricing";
export const ACCOUNT_URL = "https://www.getscreenshotapi.com/account";
export const AGENTS_URL = "https://www.getscreenshotapi.com/agents/";
export const DOCS_URL = "https://docs.rasterwise.com/docs/agents/mcp-server/";
export const HOSTED_MCP_BASE = "https://mcp.getscreenshotapi.com";
export const API_KEY_ENV = "GETSCREENSHOT_API_KEY";
