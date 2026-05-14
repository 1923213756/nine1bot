import { describe, expect, test } from "bun:test"
import { TerminalSemantic } from "../../src/pty/terminal-semantic"

const transcript = {
  path: "/tmp/terminal.log",
  startOffset: 0,
  endOffset: 120,
  recentStartOffset: 0,
  recentEndOffset: 120,
  maxBytes: 1024 * 1024 * 10,
  updatedAt: 1,
}

describe("TerminalSemantic", () => {
  test("locks a known CLI profile with command and screen signatures", () => {
    const initial = TerminalSemantic.initialProfile({
      purpose: "auto",
      command: "/bin/zsh",
      args: ["-l", "-i"],
      now: 1,
    })
    const commandSignal = TerminalSemantic.detectCommandProfile("codex")
    const screenSignal = TerminalSemantic.detectScreenProfile("Welcome to Codex CLI")

    const detected = TerminalSemantic.updateProfile({
      current: initial,
      commandSignal,
      screenSignal,
      now: 2,
    })

    expect(detected).toMatchObject({
      profile: "codex",
      confidence: "high",
      locked: true,
      lockedBy: "command+screen-signature",
    })
  })

  test("filters decorative terminal chrome from model output", () => {
    const snapshot = TerminalSemantic.createSnapshot({
      id: "agt_test",
      name: "test",
      status: "running",
      rows: 24,
      cols: 80,
      lastActivity: 0,
      profile: {
        profile: "generic-shell",
        confidence: "low",
        locked: false,
        lockedBy: "default",
        reason: "test",
        detectedAt: 0,
      },
      screenText: "done\n$ ",
      fullView: ["╭────────╮", "done", "╰────────╯", "$ "].join("\n"),
      rawTail: "done\n$ ",
      transcript,
      windowLines: 80,
      now: 2_000,
    })

    const formatted = TerminalSemantic.formatModel(snapshot)
    expect(snapshot.semanticState).toBe("ready")
    expect(formatted).toContain("Suggested Next Action (heuristic)")
    expect(formatted).toContain("done")
    expect(formatted).not.toContain("╭────────╮")
    expect(formatted).not.toContain("╰────────╯")
  })

  test("maps visible prompts to awaiting input", () => {
    const snapshot = TerminalSemantic.createSnapshot({
      id: "agt_test",
      name: "test",
      status: "running",
      rows: 24,
      cols: 80,
      lastActivity: 0,
      profile: {
        profile: "codex",
        confidence: "high",
        locked: true,
        lockedBy: "command+screen-signature",
        reason: "test",
        detectedAt: 0,
      },
      screenText: "Allow command? [y/n]",
      fullView: "Allow command? [y/n]",
      rawTail: "Allow command? [y/n]",
      transcript,
      windowLines: 80,
      now: 2_000,
    })

    expect(snapshot.semanticState).toBe("awaiting_input")
    expect(snapshot.promptMode).toContain("Awaiting input")
  })
})
