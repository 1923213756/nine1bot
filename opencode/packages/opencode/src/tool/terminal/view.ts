import z from "zod"
import { Tool } from "../tool"
import { AgentTerminal } from "../../pty/agent-terminal"
import { TerminalSemantic } from "../../pty/terminal-semantic"

export const TerminalViewTool = Tool.define("terminal_view", {
  description: `View the current content of a terminal session.

By default format="model" returns a compact semantic view for model use:
- Terminal State
- Detected Profile
- Prompt / Mode
- Meaningful Output
- Recent Window
- Suggested Next Action (heuristic)

Use format="raw" when the semantic view may be wrong or when you need exact terminal text.

Use this to:
- Check command output after running a command
- See if a process is still running or has completed
- Read prompts, error messages, or interactive menus
- Monitor the state of long-running tasks
- View full-screen applications like vim or htop

If output is large, model format stays compact and raw format keeps the most recent content.
Transcript ranges can be read in raw format with transcriptOffset and transcriptBytes.`,

  parameters: z.object({
    id: z.string().describe("Terminal session ID (from terminal_create or terminal_list)"),
    format: z.enum(["model", "raw"]).optional().describe("Output format (default: model)"),
    windowLines: z.number().optional().describe("Recent semantic/raw window lines to return (default: 80)"),
    includeHistory: z.boolean().optional().describe("Include scrollback history above current screen (default: false)"),
    historyLines: z.number().optional().describe("Number of history lines to include (default: 50, only used if includeHistory is true)"),
    transcriptOffset: z.number().optional().describe("Raw transcript byte offset to read from when format=raw"),
    transcriptBytes: z.number().optional().describe("Raw transcript byte count to read when format=raw"),
  }),

  async execute(params, ctx) {
    const info = AgentTerminal.get(params.id, ctx.sessionID)
    if (!info) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    const format = params.format ?? "model"
    const windowLines = params.windowLines ?? 80
    if (format === "model") {
      const snapshot = await AgentTerminal.getSemanticSnapshot(params.id, ctx.sessionID, { windowLines })
      if (!snapshot) {
        throw new Error(`Terminal session not found: ${params.id}`)
      }
      return {
        title: `View: ${info.name}`,
        output: TerminalSemantic.formatModel(snapshot),
        metadata: {
          terminalId: params.id,
          name: info.name,
          status: info.status,
          format,
          profile: snapshot.profile,
          semanticState: snapshot.semanticState,
          transcript: snapshot.transcript,
        } as Record<string, any>,
      }
    }

    if (params.transcriptOffset !== undefined || params.transcriptBytes !== undefined) {
      const transcript = await AgentTerminal.readTranscript(params.id, ctx.sessionID, {
        offset: params.transcriptOffset,
        bytes: params.transcriptBytes,
      })
      if (!transcript) {
        throw new Error(`Terminal session not found: ${params.id}`)
      }
      return {
        title: `Transcript: ${info.name}`,
        output: `Raw transcript bytes ${transcript.range.startOffset}-${transcript.range.endOffset}
Transcript: ${transcript.transcript.path}

${transcript.text}`,
        metadata: {
          terminalId: params.id,
          name: info.name,
          status: info.status,
          format,
          transcript: transcript.transcript,
          range: transcript.range,
        } as Record<string, any>,
      }
    }

    const snapshot = await AgentTerminal.getScreenSnapshot(
      params.id,
      ctx.sessionID,
      params.includeHistory ? params.historyLines || windowLines : windowLines,
    )
    if (!snapshot) {
      throw new Error(`Terminal session not found: ${params.id}`)
    }

    const screenInfo = snapshot.info
    const cursor = snapshot.cursor
    const content = snapshot.fullView || snapshot.screen
    const width = Math.min(screenInfo?.cols || 80, 80)

    const stateInfo = [
      `Terminal: ${info.name}`,
      `Size: ${screenInfo?.cols}x${screenInfo?.rows}`,
      `Cursor: row ${cursor?.row}, col ${cursor?.col}`,
      `Status: ${info.status}`,
      screenInfo?.scrollbackLength ? `History: ${screenInfo.scrollbackLength} lines` : null,
    ]
      .filter(Boolean)
      .join(" | ")

    return {
      title: `View: ${info.name}`,
      output: `Raw terminal view
[${stateInfo}]
${"─".repeat(width)}
${content}
${"─".repeat(width)}`,
      metadata: {
        terminalId: params.id,
        name: info.name,
        status: info.status,
        format,
        cursor,
        rows: screenInfo?.rows,
        cols: screenInfo?.cols,
      } as Record<string, any>,
    }
  },
}, {
  truncation: {
    direction: "tail",
  },
})
