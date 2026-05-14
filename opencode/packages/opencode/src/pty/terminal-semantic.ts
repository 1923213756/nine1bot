import path from "path"

export namespace TerminalSemantic {
  export const Profiles = ["generic-shell", "claude-code", "opencode", "codex"] as const
  export type Profile = (typeof Profiles)[number]

  export const States = ["ready", "busy", "awaiting_input", "completed", "error"] as const
  export type State = (typeof States)[number]

  export const Purposes = ["auto", "shell", "interactive-cli"] as const
  export type Purpose = (typeof Purposes)[number]

  export const Confidence = ["low", "medium", "high"] as const
  export type Confidence = (typeof Confidence)[number]

  export interface ProfileDetection {
    profile: Profile
    confidence: Confidence
    locked: boolean
    lockedBy: "default" | "purpose" | "command" | "screen-signature" | "command+screen-signature"
    reason: string
    detectedAt: number
  }

  export interface ProfileSignal {
    profile: Exclude<Profile, "generic-shell">
    reason: string
    confidence: Confidence
  }

  export interface TranscriptReference {
    path: string
    startOffset: number
    endOffset: number
    recentStartOffset: number
    recentEndOffset: number
    maxBytes: number
    updatedAt: number
  }

  export interface Snapshot {
    terminal: {
      id: string
      name: string
      status: "running" | "exited"
      exitCode?: number
      rows: number
      cols: number
      lastActivity: number
    }
    profile: ProfileDetection
    semanticState: State
    promptMode: string
    meaningfulOutput: string
    recentWindow: string
    suggestedNextAction: string
    transcript: TranscriptReference
    searchText: string
  }

  export function initialProfile(input: {
    purpose?: Purpose
    command: string
    args: string[]
    now?: number
  }): ProfileDetection {
    const now = input.now ?? Date.now()
    const purpose = input.purpose ?? "auto"
    if (purpose === "shell") {
      return {
        profile: "generic-shell",
        confidence: "high",
        locked: true,
        lockedBy: "purpose",
        reason: "terminal_create purpose=shell",
        detectedAt: now,
      }
    }

    const commandSignal = detectCommandProfile([input.command, ...input.args].join(" "))
    if (commandSignal && !isKnownShell(input.command)) {
      return {
        profile: commandSignal.profile,
        confidence: "high",
        locked: true,
        lockedBy: "command",
        reason: `startup command matched ${commandSignal.reason}`,
        detectedAt: now,
      }
    }

    return {
      profile: "generic-shell",
      confidence: purpose === "interactive-cli" ? "medium" : "low",
      locked: false,
      lockedBy: "default",
      reason:
        purpose === "interactive-cli"
          ? "interactive CLI purpose requested; waiting for a known CLI signature"
          : "no known CLI signature detected",
      detectedAt: now,
    }
  }

  export function updateProfile(input: {
    current: ProfileDetection
    commandSignal?: ProfileSignal
    screenSignal?: ProfileSignal
    purpose?: Purpose
    now?: number
  }): ProfileDetection {
    const now = input.now ?? Date.now()
    if (input.current.locked) return input.current

    if (
      input.commandSignal &&
      input.screenSignal &&
      input.commandSignal.profile === input.screenSignal.profile
    ) {
      return {
        profile: input.commandSignal.profile,
        confidence: "high",
        locked: true,
        lockedBy: "command+screen-signature",
        reason: `${input.commandSignal.reason}; ${input.screenSignal.reason}`,
        detectedAt: now,
      }
    }

    if (input.screenSignal?.confidence === "high") {
      return {
        profile: input.screenSignal.profile,
        confidence: "medium",
        locked: true,
        lockedBy: "screen-signature",
        reason: input.screenSignal.reason,
        detectedAt: now,
      }
    }

    if (input.commandSignal) {
      return {
        profile: input.commandSignal.profile,
        confidence: "medium",
        locked: false,
        lockedBy: "command",
        reason: input.commandSignal.reason,
        detectedAt: now,
      }
    }

    return input.current
  }

  export function detectCommandProfile(command: string): ProfileSignal | undefined {
    const words = command
      .split(/[\s;&|]+/)
      .map((word) => word.trim())
      .filter(Boolean)

    for (const word of words) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
      const normalized = path.basename(word.replace(/^['"]|['"]$/g, "")).toLowerCase().replace(/\.exe$/, "")
      if (normalized === "claude" || normalized === "claude-code") {
        return { profile: "claude-code", confidence: "medium", reason: `command "${normalized}"` }
      }
      if (normalized === "opencode") {
        return { profile: "opencode", confidence: "medium", reason: `command "${normalized}"` }
      }
      if (normalized === "codex") {
        return { profile: "codex", confidence: "medium", reason: `command "${normalized}"` }
      }
      if (normalized === "@anthropic-ai/claude-code") {
        return { profile: "claude-code", confidence: "medium", reason: `package "${normalized}"` }
      }
    }
    return undefined
  }

  export function detectScreenProfile(text: string): ProfileSignal | undefined {
    const clean = stripAnsi(text)
    if (/(^|\n)\s*(welcome to\s+)?claude code\b/i.test(clean) || /claude\.ai\/code/i.test(clean)) {
      return { profile: "claude-code", confidence: "high", reason: "screen contains Claude Code signature" }
    }
    if (/(^|\n)\s*(welcome to\s+)?opencode\b/i.test(clean) || /\bopen\s*code\b.*\b(ai|cli|agent)\b/i.test(clean)) {
      return { profile: "opencode", confidence: "high", reason: "screen contains OpenCode signature" }
    }
    if (
      /(^|\n)\s*(welcome to\s+)?(?:openai\s+)?codex(?:\s+cli)?\b/i.test(clean) ||
      /\bcodex\b.*\b(openai|cli|agent)\b/i.test(clean)
    ) {
      return { profile: "codex", confidence: "high", reason: "screen contains Codex signature" }
    }
    return undefined
  }

  export function createSnapshot(input: {
    id: string
    name: string
    status: "running" | "exited"
    exitCode?: number
    rows: number
    cols: number
    lastActivity: number
    profile: ProfileDetection
    screenText: string
    fullView: string
    rawTail: string
    transcript: TranscriptReference
    windowLines: number
    now?: number
  }): Snapshot {
    const now = input.now ?? Date.now()
    const recentLines = filterNoise(stripAnsi(input.fullView).split(/\r?\n/))
    const windowLines = recentLines.slice(-Math.max(1, input.windowLines))
    const meaningfulLines = windowLines.filter((line) => line.trim().length > 0)
    const promptMode = detectPromptMode(input.profile.profile, input.screenText, meaningfulLines)
    const semanticState = detectState({
      profile: input.profile.profile,
      status: input.status,
      exitCode: input.exitCode,
      promptMode,
      lines: meaningfulLines,
      lastActivity: input.lastActivity,
      now,
    })
    const meaningfulOutput = meaningfulLines.slice(-24).join("\n").trim() || "(no meaningful output yet)"
    const recentWindow = windowLines.join("\n").trim() || "(screen is blank)"
    return {
      terminal: {
        id: input.id,
        name: input.name,
        status: input.status,
        exitCode: input.exitCode,
        rows: input.rows,
        cols: input.cols,
        lastActivity: input.lastActivity,
      },
      profile: input.profile,
      semanticState,
      promptMode,
      meaningfulOutput,
      recentWindow,
      suggestedNextAction: suggestNextAction(semanticState, input.profile.profile),
      transcript: input.transcript,
      searchText: [meaningfulLines.join("\n"), stripAnsi(input.rawTail)].join("\n"),
    }
  }

  export function formatModel(snapshot: Snapshot): string {
    const transcript = snapshot.transcript
    const exitCode = snapshot.terminal.exitCode === undefined ? [] : [`- Exit Code: ${snapshot.terminal.exitCode}`]
    return [
      "Terminal State",
      `- ID: ${snapshot.terminal.id}`,
      `- Name: ${snapshot.terminal.name}`,
      `- Status: ${snapshot.terminal.status}`,
      `- Semantic State: ${snapshot.semanticState}`,
      `- Size: ${snapshot.terminal.cols}x${snapshot.terminal.rows}`,
      ...exitCode,
      `- Transcript: ${transcript.path}`,
      `- Transcript Range: bytes ${transcript.startOffset}-${transcript.endOffset} (recent ${transcript.recentStartOffset}-${transcript.recentEndOffset})`,
      "",
      "Detected Profile",
      `- Profile: ${snapshot.profile.profile}`,
      `- Confidence: ${snapshot.profile.confidence}`,
      `- Locked: ${snapshot.profile.locked ? "yes" : "no"}`,
      `- Locked By: ${snapshot.profile.lockedBy}`,
      `- Reason: ${snapshot.profile.reason}`,
      "",
      "Prompt / Mode",
      snapshot.promptMode,
      "",
      "Meaningful Output",
      snapshot.meaningfulOutput,
      "",
      "Recent Window",
      snapshot.recentWindow,
      "",
      "Suggested Next Action (heuristic)",
      snapshot.suggestedNextAction,
    ].join("\n")
  }

  export function stripAnsi(value: string) {
    return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
  }

  function filterNoise(lines: string[]) {
    const result: string[] = []
    let previousBlank = false
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/g, "")
      const trimmed = line.trim()
      const blank = trimmed.length === 0
      if (blank) {
        if (!previousBlank) result.push("")
        previousBlank = true
        continue
      }
      previousBlank = false
      if (isDecorativeLine(trimmed)) continue
      result.push(line)
    }
    return result
  }

  function isDecorativeLine(line: string) {
    if (/^[─━│┃┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝═║╟╢╠╣╦╩╬┄┅┈┉╤╧╪╫╒╕╘╛\s]+$/.test(line)) return true
    if (/^[-=_]{4,}$/.test(line)) return true
    if (/^[┌╭╔].*[┐╮╗]$/.test(line) && line.replace(/[┌┐╭╮╔╗─━═\s]/g, "").length === 0) return true
    if (/^[└╰╚].*[┘╯╝]$/.test(line) && line.replace(/[└┘╰╯╚╝─━═\s]/g, "").length === 0) return true
    return false
  }

  function detectPromptMode(profile: Profile, screenText: string, lines: string[]) {
    const last = lines.findLast((line) => line.trim().length > 0)?.trim()
    if (!last) return "No visible prompt or mode detected."

    if (isAwaitingInputLine(last) || isQuestionLine(last)) {
      return `Awaiting input: ${last}`
    }

    if (profile === "generic-shell" && isShellPrompt(last)) {
      return `Shell prompt: ${last}`
    }

    if (profile !== "generic-shell") {
      const inputLine = lines.findLast((line) => /(^|\s)(>|›|❯)\s*$/.test(line.trim()))
      if (inputLine) return `Interactive CLI input prompt: ${inputLine.trim()}`
      const lowerScreen = stripAnsi(screenText).toLowerCase()
      if (/\b(plan|edit|chat|review|build|ask)\b/.test(lowerScreen)) {
        return `Interactive CLI mode inferred from visible screen: ${last}`
      }
    }

    return `Last meaningful line: ${last}`
  }

  function detectState(input: {
    profile: Profile
    status: "running" | "exited"
    exitCode?: number
    promptMode: string
    lines: string[]
    lastActivity: number
    now: number
  }): State {
    if (input.status === "exited") return input.exitCode && input.exitCode !== 0 ? "error" : "completed"
    const recentText = input.lines.slice(-8).join("\n")
    const last = input.lines.findLast((line) => line.trim().length > 0)?.trim() ?? ""
    if (hasErrorMarker(recentText) && !isShellPrompt(last)) return "error"
    if (/^Awaiting input:/.test(input.promptMode) || isAwaitingInputLine(last) || isQuestionLine(last)) {
      return "awaiting_input"
    }
    if (input.profile === "generic-shell") {
      if (isShellPrompt(last)) return "ready"
      if (!last && input.now - input.lastActivity > 750) return "ready"
      return "busy"
    }
    if (hasBusyMarker(recentText) || input.now - input.lastActivity < 750) return "busy"
    if (/Interactive CLI input prompt:/.test(input.promptMode) || hasReadyMarker(recentText)) return "ready"
    return "ready"
  }

  function isKnownShell(command: string) {
    const basename = path.basename(command).toLowerCase().replace(/\.exe$/, "")
    return basename === "sh" || basename === "bash" || basename === "zsh" || basename === "dash" || basename === "fish"
  }

  function isShellPrompt(line: string) {
    return /(^|[\s\w./~:@-])[$#%❯>]\s*$/.test(line) && !/[?]$/.test(line)
  }

  function isQuestionLine(line: string) {
    return /(\?|continue|proceed|confirm|approve|allow|accept|overwrite|password|passphrase|yes\/no|y\/n)/i.test(line)
  }

  function isAwaitingInputLine(line: string) {
    return /(\[[YyNn]\/[YyNn]\]|\([YyNn]\/[YyNn]\)|password:|passphrase:|press enter|waiting for input)/i.test(line)
  }

  function hasBusyMarker(text: string) {
    return /\b(thinking|working|running|executing|processing|applying|reading|writing|searching|loading|streaming)\b/i.test(text)
  }

  function hasReadyMarker(text: string) {
    return /\b(ready|what can i help|enter a prompt|type your message|ask me|new session)\b/i.test(text)
  }

  function hasErrorMarker(text: string) {
    return /\b(error|failed|exception|permission denied|rate limit|timed out|traceback|panic)\b/i.test(text)
  }

  function suggestNextAction(state: State, profile: Profile) {
    if (state === "busy") return `Wait for the target state with terminal_wait(state="ready") or inspect raw output if progress stalls.`
    if (state === "awaiting_input") return "Respond with terminal_write; for multi-line prompts, write with submit=false, inspect, then submit with input=\"\" and submit=true."
    if (state === "error") return `Inspect terminal_view(format="raw") or the transcript range, then send a corrective command/input.`
    if (state === "completed") return "Read any final output, then close the terminal if it is no longer needed."
    if (profile === "generic-shell") return "Send the next shell command with terminal_write or wait for a specific pattern/state."
    return "Send the next interactive CLI prompt. For multi-line input, prefer paste mode and a separate submit step."
  }
}
