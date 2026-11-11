/** MCP status for the pane's top block: which servers the session reaches, which wait on a sign-in, and which configured ones never connected. Pure, so the tests drive it without an engine. */
import type { McpServer } from './types'

// A server that needs a sign-in exposes only these two tools, claude.ai connectors and OAuth servers alike.
const AUTH_TOOL = /__(authenticate|complete_authentication)$/
const CLAUDE_AI = 'claude.ai '

type Json = Record<string, any>

/** Parses a config file's text; a missing or broken file counts as empty, never as a failure. */
function parse(text: string | undefined): Json {
  try {
    return text ? (JSON.parse(text) as Json) : {}
  } catch {
    return {}
  }
}

/**
 * The servers the config files ask for in `cwd`: user and local scope from ~/.claude.json, project scope from
 * .mcp.json, minus the ones disabled for this project. Plugin servers are not listed; they show once connected.
 */
export function configuredServers(claudeJson: string | undefined, mcpJson: string | undefined, cwd: string): string[] {
  const user = parse(claudeJson)
  // ponytail: keyed by cwd only, so a session started in a subfolder of a configured project misses its local servers.
  const project: Json = user.projects?.[cwd] ?? {}
  const disabled = new Set<string>([...(project.disabledMcpServers ?? []), ...(project.disabledMcpjsonServers ?? [])])
  const names = [user.mcpServers, project.mcpServers, parse(mcpJson).mcpServers].flatMap(servers => Object.keys(servers ?? {}))
  return [...new Set(names)].filter(name => !disabled.has(name))
}

/**
 * Each server's state from the tools the context carries (deferred ones included) and the configured names:
 * any real tool is connected, sign-in tools alone mean auth, a configured name with no tools is down.
 */
export function classify(tools: readonly { name: string; serverName: string }[], configured: readonly string[]): McpServer[] {
  const byServer = new Map<string, string[]>()
  for (const tool of tools) byServer.set(tool.serverName, [...(byServer.get(tool.serverName) ?? []), tool.name])
  const servers: McpServer[] = [...byServer].map(([name, names]) => ({
    name,
    state: names.every(tool => AUTH_TOOL.test(tool)) ? 'auth' : 'connected',
    isClaudeAi: name.startsWith(CLAUDE_AI),
  }))
  for (const name of configured) {
    if (!byServer.has(name)) servers.push({ name, state: 'down', isClaudeAi: false })
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** The name the pane shows: claude.ai connectors without their prefix, the rest as /mcp lists them. */
export function shortName(server: McpServer): string {
  return server.isClaudeAi ? server.name.slice(CLAUDE_AI.length) : server.name
}
