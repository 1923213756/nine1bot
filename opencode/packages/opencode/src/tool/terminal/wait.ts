import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"
import { TerminalSemantic } from "../../pty/terminal-semantic"

export const TerminalWaitTool = Tool.define("terminal_wait", {
  description: `Wait for terminal state and/or specific content.

State waits mean "wait until the target state appears" (waitUntilState), not "wait for that state to end".
The most common states are state="ready" and state="awaiting_input".

Use this after sending commands or interactive CLI prompts to wait for:
- Command completion (look for shell prompt like "$ " or "# ")
- Semantic states: ready, busy, awaiting_input, completed, error
- Specific output text or patterns
- Error messages
- Interactive prompts (password:, [y/n], etc.)
- Process completion indicators

If both state and pattern are provided, the target state must appear first and then the pattern must match within the semantic window or recent transcript.
The default probeMode is passive and does not inject input into Claude Code/OpenCode/Codex.

Pattern tips:
- Use regex for flexible matching
- For shell prompts: "\\\\$\\\\s*$" or "#\\\\s*$"
- For password prompts: "password:" or "Password:"
- For yes/no prompts: "\\\\[y/n\\\\]" or "\\\\(yes/no\\\\)"
- For specific text: just use the literal text

Examples:
- Wait until an interactive CLI is ready: terminal_wait({ id: "xxx", state: "ready" })
- Wait until a CLI asks for input: terminal_wait({ id: "xxx", state: "awaiting_input" })
- Wait for shell prompt: terminal_wait({ id: "xxx", pattern: "\\\\$\\\\s*$" })
- Wait for password prompt: terminal_wait({ id: "xxx", pattern: "password:" })
- Wait for specific text: terminal_wait({ id: "xxx", pattern: "Build successful" })
- Wait with custom timeout: terminal_wait({ id: "xxx", pattern: "Done", timeout: 60000 })`,

  parameters: z
    .object({
      id: z.string().describe("Terminal session ID"),
      pattern: z.string().optional().describe("Text or regex pattern to wait for"),
      state: z.enum(["ready", "busy", "awaiting_input", "completed", "error"]).optional().describe("Semantic state to wait until"),
      probeMode: z.enum(["passive", "active"]).optional().describe("Probe mode (default: passive). Active probes are only used when an adapter declares them safe."),
      pollMs: z.number().optional().describe("Polling interval in milliseconds (default: 250)"),
      timeout: z.number().optional().describe("Timeout in milliseconds (default: 30000)"),
      windowLines: z.number().optional().describe("Semantic window lines to scan (default: 80)"),
    })
    .refine((value) => value.pattern !== undefined || value.state !== undefined, {
      message: "Provide at least one of pattern or state.",
    }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id, ctx.sessionID)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    const timeout = params.timeout || 30000

    // Update metadata to show we're waiting
    ctx.metadata({
      title: `Waiting in ${info.name}`,
      metadata: {
        terminalId: params.id,
        pattern: params.pattern,
        state: params.state,
        status: "waiting",
      },
    })

    const requestedProbeMode = params.probeMode ?? "passive"
    const result = await AgentTerminal.waitForSemantic(params.id, {
      pattern: params.pattern,
      state: params.state,
      timeout,
      pollMs: params.pollMs,
      windowLines: params.windowLines,
      sessionID: ctx.sessionID,
    })
    const snapshot = result.snapshot ?? (await AgentTerminal.getSemanticSnapshot(params.id, ctx.sessionID))

    if (result.matched) {
      return {
        title: `Wait matched in ${info.name}`,
        output: `Wait condition matched in terminal "${info.name}".

${snapshot ? TerminalSemantic.formatModel(snapshot) : ""}`,
        metadata: {
          terminalId: params.id,
          pattern: params.pattern,
          state: params.state,
          matched: true,
          timedOut: false,
          stateMatched: result.stateMatched,
          patternMatched: result.patternMatched,
          probeMode: "passive",
          requestedProbeMode,
          activeProbeSupported: false,
          profile: snapshot?.profile ?? info.profile,
          semanticState: snapshot?.semanticState ?? info.semanticState,
          transcript: snapshot?.transcript,
        },
      }
    } else {
      return {
        title: `Timeout waiting in ${info.name}`,
        output: `Timeout after ${timeout}ms waiting for terminal condition.

Requested state: ${params.state ?? "(none)"}
Requested pattern: ${params.pattern ?? "(none)"}

${snapshot ? TerminalSemantic.formatModel(snapshot) : ""}

The condition was not met. Use terminal_view(format="raw") if the semantic view looks suspicious, or increase the timeout.`,
        metadata: {
          terminalId: params.id,
          pattern: params.pattern,
          state: params.state,
          matched: false,
          timedOut: true,
          stateMatched: result.stateMatched,
          patternMatched: result.patternMatched,
          probeMode: "passive",
          requestedProbeMode,
          activeProbeSupported: false,
          profile: snapshot?.profile ?? info.profile,
          semanticState: snapshot?.semanticState ?? info.semanticState,
          transcript: snapshot?.transcript,
        },
      }
    }
  },
}, {
  truncation: {
    direction: "tail",
  },
})
