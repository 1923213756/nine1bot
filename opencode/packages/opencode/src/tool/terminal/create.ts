import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"
import { TerminalSemantic } from "../../pty/terminal-semantic"

export const TerminalCreateTool = Tool.define("terminal_create", {
  description: `Create a new persistent terminal session.

Use this to start interactive terminal sessions for tasks like:
- SSH connections to remote servers
- Running interactive CLI tools (vim, htop, docker exec -it, etc.)
- Long-running processes you need to monitor
- Any task requiring persistent shell state across multiple commands

The terminal maintains full screen state, so you can use vim, htop, and other full-screen applications.
When purpose="auto", the terminal starts as the default shell and semantic profile detection is enabled.

Returns a session ID to use with other terminal tools (terminal_view, terminal_write, etc.).

Example usage:
- Create a terminal: terminal_create({ name: "ssh-prod" })
- Create for an interactive CLI: terminal_create({ name: "codex", purpose: "interactive-cli" })
- Create with specific size: terminal_create({ name: "editor", rows: 40, cols: 120 })`,

  parameters: z.object({
    name: z.string().optional().describe("Name for this terminal (e.g., 'ssh-prod', 'docker-logs')"),
    purpose: z.enum(["auto", "shell", "interactive-cli"]).optional().describe("Terminal purpose hint (default: auto). auto enables profile detection without changing shell startup."),
    cwd: z.string().optional().describe("Working directory (defaults to project root)"),
    rows: z.number().optional().describe("Terminal height in rows (default: 24)"),
    cols: z.number().optional().describe("Terminal width in columns (default: 120)"),
  }),

  async execute(params, ctx) {
    const terminal = await AgentTerminal.create({
      name: params.name,
      sessionID: ctx.sessionID,
      purpose: params.purpose,
      cwd: params.cwd || ctx.cwd,
      rows: params.rows,
      cols: params.cols,
    })

    const snapshot = await AgentTerminal.getSemanticSnapshot(terminal.id, ctx.sessionID)

    return {
      title: `Created terminal: ${terminal.name}`,
      output: snapshot
        ? `Terminal "${terminal.name}" created successfully.\n\n${TerminalSemantic.formatModel(snapshot)}`
        : `Terminal "${terminal.name}" created successfully.\nSession ID: ${terminal.id}\nPID: ${terminal.pid}`,
      metadata: {
        terminalId: terminal.id,
        name: terminal.name,
        pid: terminal.pid,
        rows: terminal.rows,
        cols: terminal.cols,
        purpose: terminal.purpose,
        profile: terminal.profile,
        semanticState: terminal.semanticState,
        transcriptPath: terminal.transcriptPath,
      },
    }
  },
})
