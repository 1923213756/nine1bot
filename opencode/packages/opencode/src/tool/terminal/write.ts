import z from "zod"
import path from "path"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"
import { CommandAnalyzer } from "../command-analyzer"
import { TerminalSemantic } from "../../pty/terminal-semantic"

export const TerminalWriteTool = Tool.define("terminal_write", {
  description: `Send input to a terminal session.

Use this to:
- Type commands and press Enter
- Answer prompts (passwords, confirmations like y/n)
- Send special keys (Ctrl+C to interrupt, Ctrl+D for EOF, etc.)
- Interact with CLI applications and menus
- Navigate in vim, htop, or other interactive programs

Text input and submit are separated. For interactive CLIs (Claude Code, OpenCode, Codex), prefer the two-step workflow for multi-line prompts:
1. Send the prompt with submit=false.
2. Inspect with terminal_view.
3. Submit with input="" and submit=true.

After sending input, use terminal_view to see the semantic view, or terminal_wait to wait for a state/pattern.

Special key sequences (use these in the input string):
- \\n or \\r - Enter key
- \\x03 - Ctrl+C (interrupt/SIGINT)
- \\x04 - Ctrl+D (EOF)
- \\x1a - Ctrl+Z (suspend/SIGTSTP)
- \\t - Tab
- \\x1b[A - Up arrow
- \\x1b[B - Down arrow
- \\x1b[C - Right arrow
- \\x1b[D - Left arrow
- \\x1b - Escape key

Examples:
- Run a command: terminal_write({ id: "xxx", input: "ls -la" })
- Multi-line interactive prompt without submitting: terminal_write({ id: "xxx", input: "line 1\\nline 2", submit: false })
- Submit only: terminal_write({ id: "xxx", input: "", submit: true })
- Answer yes: terminal_write({ id: "xxx", input: "y" })
- Send password: terminal_write({ id: "xxx", input: "mypassword" })
- Interrupt process: terminal_write({ id: "xxx", input: "\\x03", pressEnter: false })
- Exit vim: terminal_write({ id: "xxx", input: ":q!", pressEnter: true })

Compatibility: pressEnter is an alias for submit when submit is omitted.`,

  parameters: z.object({
    id: z.string().describe("Terminal session ID"),
    input: z.string().optional().default("").describe("Text or command to send to the terminal. Empty string is allowed when submit=true."),
    pressEnter: z.boolean().optional().describe("Compatibility alias for submit when submit is omitted (default legacy behavior: true)"),
    submit: z.boolean().optional().describe("Send an explicit Enter/submit action after writing input. Overrides pressEnter when provided."),
    inputMode: z.enum(["command", "paste", "literal"]).optional().describe("How to send text: command decodes escapes, paste uses bracketed paste, literal sends exact text."),
  }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id, ctx.sessionID)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    if (info.status !== "running") {
      throw new Error(`Terminal has exited (status: ${info.status})`)
    }

    const rawInput = params.input ?? ""
    const explicitSubmit = params.submit !== undefined
    const submit = explicitSubmit ? params.submit === true : params.pressEnter !== false
    const profile = AgentTerminal.getProfile(params.id, ctx.sessionID)
    const hasMultilineInput = rawInput.includes("\n") || /\\[nr]/.test(rawInput)
    const interactivePurpose = info.purpose === "interactive-cli"
    const defaultInputMode =
      (interactivePurpose || profile?.profile !== "generic-shell") && hasMultilineInput ? "paste" : "command"
    const inputMode = params.inputMode ?? defaultInputMode
    const decodedInput = inputMode === "literal" ? rawInput : decodeEscapes(rawInput)
    const terminalInput = buildTerminalInput(decodedInput, inputMode, {
      submit,
      legacySubmit: !explicitSubmit,
    })

    // Security check: analyze command and request permissions if needed
    const shouldAnalyze =
      inputMode === "command" &&
      (profile?.profile === undefined || profile.profile === "generic-shell") &&
      (decodedInput.length > 0 || submit)
    const pendingInput = AgentTerminal.getPendingInput(params.id, ctx.sessionID)
    const analysisInput = submit ? `${pendingInput}${decodedInput}\n` : decodedInput
    const analysis = shouldAnalyze
      ? await CommandAnalyzer.analyze(analysisInput, ctx.cwd)
      : { isCommand: false, commands: [], externalDirectories: [], requiresPermission: false }

    if (analysis.isCommand && analysis.requiresPermission) {
      // Request external_directory permission if accessing paths outside project
      if (analysis.externalDirectories.length > 0) {
        await ctx.ask({
          permission: "external_directory",
          patterns: analysis.externalDirectories,
          always: analysis.externalDirectories.map((x) => path.dirname(x) + "*"),
          metadata: {
            tool: "terminal_write",
            terminalId: params.id,
            terminalName: info.name,
          },
        })
      }

      // Request bash permission for command execution
      if (analysis.commands.length > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: analysis.commands.map((c) => c.pattern),
          always: analysis.commands.map((c) => c.alwaysPattern),
          metadata: {
            tool: "terminal_write",
            terminalId: params.id,
            terminalName: info.name,
          },
        })
      }
    }

    AgentTerminal.observeInput(params.id, decodedInput, submit, inputMode, ctx.sessionID)
    const success = AgentTerminal.write(params.id, terminalInput, ctx.sessionID)
    if (!success) {
      throw new Error(`Failed to write to terminal: ${params.id}`)
    }

    // Brief wait for terminal to process input
    await new Promise((resolve) => setTimeout(resolve, 50))

    const snapshot = await AgentTerminal.getSemanticSnapshot(params.id, ctx.sessionID)

    return {
      title: `Sent to ${info.name}`,
      output: snapshot
        ? `Input sent to terminal "${info.name}".\n\n${TerminalSemantic.formatModel(snapshot)}`
        : `Input sent to terminal "${info.name}".`,
      metadata: {
        terminalId: params.id,
        name: info.name,
        inputLength: terminalInput.length,
        textLength: decodedInput.length,
        submit,
        inputMode,
        profile: snapshot?.profile ?? info.profile,
        semanticState: snapshot?.semanticState ?? info.semanticState,
        transcript: snapshot?.transcript,
      },
    }
  },
})

function decodeEscapes(input: string) {
  return input
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x1b/g, "\x1b")
}

function buildTerminalInput(
  input: string,
  inputMode: "command" | "paste" | "literal",
  options: { submit: boolean; legacySubmit: boolean },
) {
  let result = inputMode === "paste" && input.length > 0 ? `\x1b[200~${input}\x1b[201~` : input
  if (!options.submit) return result
  if (options.legacySubmit && (result.endsWith("\n") || result.endsWith("\r"))) return result
  return `${result}\r`
}
