import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { ProjectEnvironment } from "../project/environment"
import { lazy } from "@opencode-ai/util/lazy"
import { Shell } from "@/shell/shell"
import { ScreenBuffer } from "./screen-buffer"
import { TerminalSemantic } from "./terminal-semantic"
import path from "path"
import fs from "fs/promises"
import os from "os"

/**
 * AgentTerminal - Agent 控制的持久化终端会话
 *
 * 与普通 PTY 不同，AgentTerminal 提供：
 * - 屏幕缓冲区，让 Agent 能像人一样查看终端内容
 * - 会话归属追踪（属于哪个 OpenCode 会话）
 * - 模式匹配等待功能
 * - 专用事件用于 Web UI 实时展示
 */
export namespace AgentTerminal {
  const log = Log.create({ service: "agent-terminal" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const TRANSCRIPT_LIMIT = 1024 * 1024 * 10
  const TRANSCRIPT_RECENT_BYTES = 64 * 1024
  const EXITED_RETAIN_MS = 30 * 60 * 1000
  const OUTPUT_FLUSH_INTERVAL = 25 // ms
  const OUTPUT_FLUSH_BYTES = 64 * 1024
  const SCREEN_UPDATE_THROTTLE = 100 // ms

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  // Schema definitions
  export const Purpose = z.enum(TerminalSemantic.Purposes)
  export type Purpose = z.infer<typeof Purpose>

  export const SemanticState = z.enum(TerminalSemantic.States)
  export type SemanticState = z.infer<typeof SemanticState>

  export const ProfileDetection = z.object({
    profile: z.enum(TerminalSemantic.Profiles),
    confidence: z.enum(TerminalSemantic.Confidence),
    locked: z.boolean(),
    lockedBy: z.enum(["default", "purpose", "command", "screen-signature", "command+screen-signature"]),
    reason: z.string(),
    detectedAt: z.number(),
  })
  export type ProfileDetection = z.infer<typeof ProfileDetection>

  export const TranscriptReference = z.object({
    path: z.string(),
    startOffset: z.number(),
    endOffset: z.number(),
    recentStartOffset: z.number(),
    recentEndOffset: z.number(),
    maxBytes: z.number(),
    updatedAt: z.number(),
  })
  export type TranscriptReference = z.infer<typeof TranscriptReference>

  export const Info = z
    .object({
      id: Identifier.schema("agt"),
      name: z.string(),
      sessionID: z.string(),
      purpose: Purpose,
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited"]),
      exitCode: z.number().optional(),
      pid: z.number(),
      rows: z.number(),
      cols: z.number(),
      createdAt: z.number(),
      lastActivity: z.number(),
      profile: ProfileDetection,
      semanticState: SemanticState,
      transcriptPath: z.string(),
    })
    .meta({ ref: "AgentTerminal" })

  export type Info = z.infer<typeof Info>

  export const OutputChunk = z.object({
    seq: z.number().int().nonnegative(),
    data: z.string(),
  })

  export type OutputChunk = z.infer<typeof OutputChunk>

  export const BufferSnapshot = z.object({
    buffer: z.string(),
    chunks: z.array(OutputChunk),
    latestSeq: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative(),
    reset: z.boolean(),
  })

  export type BufferSnapshot = z.infer<typeof BufferSnapshot>

  export interface ScreenSnapshot {
    sessionID: string
    screen: string
    screenAnsi: string
    cursor: ScreenBuffer.CursorPosition
    info: ScreenBuffer.ScreenInfo
    fullView?: string
  }

  export interface SemanticSnapshot extends TerminalSemantic.Snapshot {}

  export const CreateInput = z.object({
    name: z.string().optional(),
    sessionID: z.string(),
    purpose: Purpose.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    rows: z.number().optional(),
    cols: z.number().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  // Events
  export const Event = {
    Created: BusEvent.define(
      "agent-terminal.created",
      z.object({ info: Info })
    ),
    Updated: BusEvent.define(
      "agent-terminal.updated",
      z.object({ info: Info })
    ),
    Screen: BusEvent.define(
      "agent-terminal.screen",
      z.object({
        id: Identifier.schema("agt"),
        sessionID: z.string(),
        screen: z.string(),
        screenAnsi: z.string(),
        cursor: z.object({ row: z.number(), col: z.number() }),
      })
    ),
    /** 原始数据输出事件 - 用于前端 xterm 直接渲染和保持滚动历史 */
    Output: BusEvent.define(
      "agent-terminal.output",
      z.object({
        id: Identifier.schema("agt"),
        sessionID: z.string(),
        seq: z.number().int().nonnegative(),
        data: z.string(),
      })
    ),
    Exited: BusEvent.define(
      "agent-terminal.exited",
      z.object({ id: Identifier.schema("agt"), sessionID: z.string(), exitCode: z.number() })
    ),
    Closed: BusEvent.define(
      "agent-terminal.closed",
      z.object({ id: Identifier.schema("agt"), sessionID: z.string() })
    ),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: ScreenBuffer.Buffer
    rawBuffer: string
    profile: TerminalSemantic.ProfileDetection
    semanticState: TerminalSemantic.State
    transcriptPath: string
    transcriptStartOffset: number
    transcriptBytes: number
    transcriptUpdatedAt: number
    transcriptWriteChain: Promise<void>
    pendingCommandSignal?: TerminalSemantic.ProfileSignal
    pendingInputText: string
    lastSemanticSnapshot?: SemanticSnapshot
    outputSeq: number
    outputChunks: OutputChunk[]
    outputChunkBytes: number
    pendingOutput: string
    outputFlushTimer: ReturnType<typeof setTimeout> | null
    outputPublishChain: Promise<void>
    lastScreenUpdate: number
    screenUpdateTimer: ReturnType<typeof setTimeout> | null
    screenPublishChain: Promise<void>
    exitCleanupTimer: ReturnType<typeof setTimeout> | null
    closing: boolean
    closed: boolean
  }

  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      for (const session of sessions.values()) {
        terminateProcessTree(session)
        session.buffer.dispose()
        if (session.screenUpdateTimer) {
          clearTimeout(session.screenUpdateTimer)
        }
        if (session.outputFlushTimer) {
          clearTimeout(session.outputFlushTimer)
        }
        if (session.exitCleanupTimer) {
          clearTimeout(session.exitCleanupTimer)
        }
      }
      sessions.clear()
    }
  )

  /**
   * 列出所有活跃的 Agent 终端
   */
  export function list(sessionID?: string): Info[] {
    const all = Array.from(state().values()).map((s) => s.info)
    if (sessionID) {
      return all.filter((t) => t.sessionID === sessionID)
    }
    return all
  }

  /**
   * 获取指定终端信息
   */
  export function get(id: string, sessionID: string): Info | undefined {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    return session.info
  }

  function belongsToSession(session: ActiveSession, sessionID: string) {
    return session.info.sessionID === sessionID
  }

  function shellArgs(command: string, inputArgs?: string[]) {
    const args = [...(inputArgs ?? [])]
    if (args.length > 0) return args

    const basename = (process.platform === "win32" ? path.win32.basename(command) : path.basename(command))
      .toLowerCase()
      .replace(/\.exe$/, "")

    if (basename === "bash" || basename === "zsh") return ["-l", "-i"]
    if (basename === "sh" || basename === "dash") return ["-i"]
    return args
  }

  /**
   * 创建新的 Agent 终端
   */
  export async function create(input: CreateInput): Promise<Info> {
    const id = Identifier.create("agt", false)
    const command = input.command || Shell.preferred()
    const args = shellArgs(command, input.args)
    const purpose = input.purpose || "auto"
    const rows = input.rows || 24
    const cols = input.cols || 120

    const cwd = input.cwd || Instance.directory
    const transcriptPath = path.join(
      os.tmpdir(),
      "opencode-agent-terminals",
      Instance.project.id,
      input.sessionID,
      `${id}.log`,
    )
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
    await fs.writeFile(transcriptPath, "")
    const projectEnv = await ProjectEnvironment.getAll(Instance.project.id)
    const env = {
      ...process.env,
      ...projectEnv,
      ...input.env,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
      OPENCODE_AGENT_TERMINAL: "1",
    } as Record<string, string>

    log.info("creating agent terminal", { id, command, args, cwd, rows, cols })

    const spawn = await pty()
    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
      rows,
      cols,
    })

    const screenBuffer = new ScreenBuffer.Buffer({ rows, cols })
    const now = Date.now()
    const profile = TerminalSemantic.initialProfile({ purpose, command, args, now })

    const info: Info = {
      id,
      name: input.name || `Terminal ${id.slice(-4)}`,
      sessionID: input.sessionID,
      purpose,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
      rows,
      cols,
      createdAt: now,
      lastActivity: now,
      profile,
      semanticState: "ready",
      transcriptPath,
    }

    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: screenBuffer,
      rawBuffer: "",
      profile,
      semanticState: "ready",
      transcriptPath,
      transcriptStartOffset: 0,
      transcriptBytes: 0,
      transcriptUpdatedAt: now,
      transcriptWriteChain: Promise.resolve(),
      pendingInputText: "",
      outputSeq: 0,
      outputChunks: [],
      outputChunkBytes: 0,
      pendingOutput: "",
      outputFlushTimer: null,
      outputPublishChain: Promise.resolve(),
      lastScreenUpdate: 0,
      screenUpdateTimer: null,
      screenPublishChain: Promise.resolve(),
      exitCleanupTimer: null,
      closing: false,
      closed: false,
    }

    state().set(id, session)

    // 处理 PTY 输出
    ptyProcess.onData((data) => {
      if (session.closed) return
      session.info.lastActivity = Date.now()
      session.rawBuffer += data
      session.pendingOutput += data
      queueTranscriptWrite(session, data)

      // 保持原始缓冲区大小限制
      if (session.rawBuffer.length > BUFFER_LIMIT) {
        session.rawBuffer = session.rawBuffer.slice(-BUFFER_LIMIT)
      }

      scheduleOutputFlush(session)

      void session.buffer.write(data).then(
        () => scheduleScreenUpdate(session),
        (error) => log.warn("failed to write terminal screen buffer", { id, error }),
      )
    })

    // 处理退出
    ptyProcess.onExit(({ exitCode }) => {
      if (session.closed) return
      log.info("agent terminal exited", { id, exitCode })
      session.info.status = "exited"
      session.info.exitCode = exitCode
      session.semanticState = exitCode === 0 ? "completed" : "error"
      session.info.semanticState = session.semanticState

      if (session.screenUpdateTimer) {
        clearTimeout(session.screenUpdateTimer)
        session.screenUpdateTimer = null
      }
      if (session.outputFlushTimer) {
        clearTimeout(session.outputFlushTimer)
        session.outputFlushTimer = null
      }

      void Promise.all([flushOutput(session), session.transcriptWriteChain.catch(() => undefined)]).finally(() => {
        if (session.closed) return
        if (session.closing) {
          void finalizeClose(session)
          return
        }
        void updateSemanticSnapshot(session)
        Bus.publish(Event.Exited, { id, sessionID: session.info.sessionID, exitCode })
        session.exitCleanupTimer = setTimeout(() => {
          const current = state().get(id)
          if (!current || current.closed || current.info.status !== "exited") return
          current.closed = true
          current.buffer.dispose()
          state().delete(id)
        }, EXITED_RETAIN_MS)
      })
    })

    Bus.publish(Event.Created, { info })

    // 等待 shell 启动并发送初始屏幕
    await new Promise((resolve) => setTimeout(resolve, 300))
    await updateSemanticSnapshot(session)
    await publishScreen(session)

    return info
  }

  function transcriptRef(session: ActiveSession): TerminalSemantic.TranscriptReference {
    const endOffset = session.transcriptStartOffset + session.transcriptBytes
    const recentStartOffset = Math.max(session.transcriptStartOffset, endOffset - TRANSCRIPT_RECENT_BYTES)
    return {
      path: session.transcriptPath,
      startOffset: session.transcriptStartOffset,
      endOffset,
      recentStartOffset,
      recentEndOffset: endOffset,
      maxBytes: TRANSCRIPT_LIMIT,
      updatedAt: session.transcriptUpdatedAt,
    }
  }

  function queueTranscriptWrite(session: ActiveSession, data: string) {
    const bytes = Buffer.byteLength(data)
    session.transcriptBytes += bytes
    session.transcriptUpdatedAt = Date.now()
    session.transcriptWriteChain = session.transcriptWriteChain
      .then(async () => {
        await fs.appendFile(session.transcriptPath, data)
        if (session.transcriptBytes <= TRANSCRIPT_LIMIT) return

        const stat = await fs.stat(session.transcriptPath)
        if (stat.size <= TRANSCRIPT_LIMIT) {
          session.transcriptBytes = stat.size
          return
        }

        const tail = await readFileRange(session.transcriptPath, stat.size - TRANSCRIPT_LIMIT, TRANSCRIPT_LIMIT)
        await fs.writeFile(session.transcriptPath, tail)
        session.transcriptStartOffset += stat.size - tail.length
        session.transcriptBytes = tail.length
      })
      .catch((error) => {
        log.warn("failed to write terminal transcript", { id: session.info.id, error })
      })
  }

  async function readFileRange(filePath: string, offset: number, bytes: number): Promise<Buffer> {
    const handle = await fs.open(filePath, "r")
    try {
      const stat = await handle.stat()
      const start = Math.max(0, Math.min(offset, stat.size))
      const length = Math.max(0, Math.min(bytes, stat.size - start))
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return buffer
    } finally {
      await handle.close()
    }
  }

  function terminateProcessTree(session: ActiveSession, signal: NodeJS.Signals = "SIGTERM") {
    if (session.info.pid > 0 && process.platform !== "win32") {
      try {
        process.kill(-session.info.pid, signal)
      } catch {}
    }
    try {
      session.process.kill()
    } catch {}
  }

  async function finalizeClose(session: ActiveSession) {
    if (session.closed) return
    session.closed = true

    if (session.screenUpdateTimer) {
      clearTimeout(session.screenUpdateTimer)
      session.screenUpdateTimer = null
    }
    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer)
      session.outputFlushTimer = null
    }
    if (session.exitCleanupTimer) {
      clearTimeout(session.exitCleanupTimer)
      session.exitCleanupTimer = null
    }

    await Promise.all([
      flushOutput(session),
      session.buffer.flush().catch(() => undefined),
      session.transcriptWriteChain.catch(() => undefined),
    ])
    session.buffer.dispose()
    state().delete(session.info.id)
    await Bus.publish(Event.Closed, { id: session.info.id, sessionID: session.info.sessionID })
  }

  function addOutputChunk(session: ActiveSession, chunk: OutputChunk) {
    session.outputChunks.push(chunk)
    session.outputChunkBytes += chunk.data.length
    while (session.outputChunkBytes > BUFFER_LIMIT && session.outputChunks.length > 0) {
      const removed = session.outputChunks.shift()
      if (removed) session.outputChunkBytes -= removed.data.length
    }
  }

  function scheduleOutputFlush(session: ActiveSession) {
    if (session.pendingOutput.length >= OUTPUT_FLUSH_BYTES) {
      void flushOutput(session)
      return
    }
    if (session.outputFlushTimer) return
    session.outputFlushTimer = setTimeout(() => {
      session.outputFlushTimer = null
      void flushOutput(session)
    }, OUTPUT_FLUSH_INTERVAL)
  }

  async function flushOutput(session: ActiveSession) {
    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer)
      session.outputFlushTimer = null
    }
    if (!session.pendingOutput) return session.outputPublishChain

    const data = session.pendingOutput
    session.pendingOutput = ""
    const seq = ++session.outputSeq
    addOutputChunk(session, { seq, data })

    session.outputPublishChain = session.outputPublishChain.then(() =>
      Bus.publish(Event.Output, {
        id: session.info.id,
        sessionID: session.info.sessionID,
        seq,
        data,
      }).then(() => undefined),
    )
    session.outputPublishChain = session.outputPublishChain.catch((error) => {
      log.warn("failed to publish terminal output", { id: session.info.id, seq, error })
    })
    return session.outputPublishChain
  }

  /**
   * 调度屏幕更新事件（节流）
   */
  function scheduleScreenUpdate(session: ActiveSession) {
    if (session.screenUpdateTimer) return

    const timeSinceLastUpdate = Date.now() - session.lastScreenUpdate
    const delay = Math.max(0, SCREEN_UPDATE_THROTTLE - timeSinceLastUpdate)

    session.screenUpdateTimer = setTimeout(() => {
      session.screenUpdateTimer = null
      session.lastScreenUpdate = Date.now()
      session.screenPublishChain = session.screenPublishChain.then(() => publishScreen(session))
      session.screenPublishChain = session.screenPublishChain.catch((error) => {
        log.warn("failed to publish terminal screen", { id: session.info.id, error })
      })
    }, delay)
  }

  /**
   * 发布屏幕更新事件
   */
  async function publishScreen(session: ActiveSession) {
    await session.buffer.flush()
    const screen = session.buffer.getScreenText()
    const screenAnsi = session.buffer.getScreenAnsi()
    const cursor = session.buffer.getCursor()
    await Bus.publish(Event.Screen, {
      id: session.info.id,
      sessionID: session.info.sessionID,
      screen,
      screenAnsi,
      cursor,
    })
  }

  async function updateSemanticSnapshot(session: ActiveSession, windowLines = 80): Promise<SemanticSnapshot> {
    await session.buffer.flush()
    const screen = session.buffer.getScreenText()
    const fullView = session.buffer.getFullView(windowLines)
    const screenSignal = TerminalSemantic.detectScreenProfile([screen, fullView, session.rawBuffer.slice(-8192)].join("\n"))
    session.profile = TerminalSemantic.updateProfile({
      current: session.profile,
      commandSignal: session.pendingCommandSignal,
      screenSignal,
      purpose: session.info.purpose,
    })
    const snapshot = TerminalSemantic.createSnapshot({
      id: session.info.id,
      name: session.info.name,
      status: session.info.status,
      exitCode: session.info.exitCode,
      rows: session.info.rows,
      cols: session.info.cols,
      lastActivity: session.info.lastActivity,
      profile: session.profile,
      screenText: screen,
      fullView,
      rawTail: session.rawBuffer.slice(-TRANSCRIPT_RECENT_BYTES),
      transcript: transcriptRef(session),
      windowLines,
    })
    session.semanticState = snapshot.semanticState
    session.lastSemanticSnapshot = snapshot
    session.info.profile = session.profile
    session.info.semanticState = snapshot.semanticState
    session.info.transcriptPath = session.transcriptPath
    return snapshot
  }

  /**
   * 向终端发送输入
   */
  export function write(id: string, data: string, sessionID: string): boolean {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID) || session.info.status !== "running") {
      return false
    }
    session.process.write(data)
    session.info.lastActivity = Date.now()
    return true
  }

  export function getProfile(id: string, sessionID: string): ProfileDetection | undefined {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    return session.profile
  }

  export function getPendingInput(id: string, sessionID: string): string {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return ""
    return session.pendingInputText
  }

  export function observeInput(
    id: string,
    input: string,
    submitted: boolean,
    inputMode: "command" | "paste" | "literal",
    sessionID: string,
  ): boolean {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID) || session.info.status !== "running") {
      return false
    }

    if (inputMode === "command") {
      const combined = session.pendingInputText + input
      if (submitted) {
        const signal = TerminalSemantic.detectCommandProfile(combined)
        if (signal) {
          session.pendingCommandSignal = signal
          session.profile = TerminalSemantic.updateProfile({
            current: session.profile,
            commandSignal: signal,
            purpose: session.info.purpose,
          })
          session.info.profile = session.profile
        }
        session.pendingInputText = ""
      } else {
        session.pendingInputText = combined
      }
    } else if (submitted) {
      session.pendingInputText = ""
    }

    return true
  }

  /**
   * 获取当前屏幕内容
   */
  export async function getScreen(id: string, sessionID: string): Promise<string | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScreenText()
  }

  /**
   * 获取带 ANSI 转义序列的屏幕内容
   */
  export async function getScreenAnsi(id: string, sessionID: string): Promise<string | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScreenAnsi()
  }

  /**
   * 获取屏幕行数组
   */
  export async function getScreenLines(id: string, sessionID: string): Promise<string[] | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScreen()
  }

  /**
   * 获取滚动历史
   */
  export async function getScrollback(id: string, lines: number | undefined, sessionID: string): Promise<string[] | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScrollback(lines)
  }

  /**
   * 获取完整视图（历史 + 屏幕）
   */
  export async function getFullView(id: string, historyLines: number, sessionID: string): Promise<string | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getFullView(historyLines)
  }

  /**
   * 获取光标位置
   */
  export async function getCursor(id: string, sessionID: string): Promise<ScreenBuffer.CursorPosition | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getCursor()
  }

  /**
   * 获取终端详细信息
   */
  export async function getScreenInfo(id: string, sessionID: string): Promise<ScreenBuffer.ScreenInfo | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getInfo()
  }

  export async function getScreenSnapshot(
    id: string,
    sessionID: string,
    historyLines?: number,
  ): Promise<ScreenSnapshot | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return {
      sessionID: session.info.sessionID,
      screen: session.buffer.getScreenText(),
      screenAnsi: session.buffer.getScreenAnsi(),
      cursor: session.buffer.getCursor(),
      info: session.buffer.getInfo(),
      fullView: historyLines === undefined ? undefined : session.buffer.getFullView(historyLines),
    }
  }

  export async function getSemanticSnapshot(
    id: string,
    sessionID: string,
    options: { windowLines?: number } = {},
  ): Promise<SemanticSnapshot | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    return updateSemanticSnapshot(session, options.windowLines)
  }

  export async function readTranscript(
    id: string,
    sessionID: string,
    input: { offset?: number; bytes?: number } = {},
  ): Promise<{ text: string; range: { startOffset: number; endOffset: number }; transcript: TranscriptReference } | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.transcriptWriteChain.catch(() => undefined)
    const ref = transcriptRef(session)
    const requestedBytes = Math.max(0, Math.min(input.bytes ?? TRANSCRIPT_RECENT_BYTES, TRANSCRIPT_LIMIT))
    const requestedOffset = input.offset ?? Math.max(ref.startOffset, ref.endOffset - requestedBytes)
    const startOffset = Math.max(ref.startOffset, Math.min(requestedOffset, ref.endOffset))
    const length = Math.max(0, Math.min(requestedBytes, ref.endOffset - startOffset))
    const fileOffset = startOffset - ref.startOffset
    const data = await readFileRange(session.transcriptPath, fileOffset, length)
    return {
      text: TerminalSemantic.stripAnsi(data.toString("utf8")),
      range: {
        startOffset,
        endOffset: startOffset + data.length,
      },
      transcript: ref,
    }
  }

  /**
   * 等待特定模式出现
   */
  export async function waitFor(
    id: string,
    pattern: string | RegExp,
    timeout: number,
    sessionID: string,
  ): Promise<{ matched: boolean; timedOut: boolean; screen?: string }> {
    const result = await waitForSemantic(id, { pattern, timeout, sessionID })
    return {
      matched: result.matched,
      timedOut: result.timedOut,
      screen: result.snapshot?.recentWindow,
    }
  }

  export async function waitForSemantic(
    id: string,
    input: {
      sessionID: string
      state?: TerminalSemantic.State
      pattern?: string | RegExp
      timeout?: number
      pollMs?: number
      windowLines?: number
    },
  ): Promise<{
    matched: boolean
    timedOut: boolean
    stateMatched: boolean
    patternMatched: boolean
    snapshot?: SemanticSnapshot
  }> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, input.sessionID)) {
      return { matched: false, timedOut: false, stateMatched: false, patternMatched: false }
    }

    const timeout = input.timeout ?? 30000
    const pollMs = Math.max(25, input.pollMs ?? 250)
    const startTime = Date.now()
    const regex = input.pattern === undefined ? undefined : typeof input.pattern === "string" ? new RegExp(input.pattern) : input.pattern
    let snapshot: SemanticSnapshot | undefined

    while (Date.now() - startTime < timeout) {
      snapshot = await updateSemanticSnapshot(session, input.windowLines)
      const stateMatched = input.state === undefined || snapshot.semanticState === input.state
      let patternMatched = regex === undefined
      if (stateMatched && regex) {
        const transcript = await readTranscript(id, input.sessionID, { bytes: TRANSCRIPT_RECENT_BYTES })
        patternMatched = matchesPattern(regex, [snapshot.searchText, transcript?.text ?? ""].join("\n"))
      }
      if (stateMatched && patternMatched) {
        return { matched: true, timedOut: false, stateMatched, patternMatched, snapshot }
      }
      if (session.info.status === "exited" && input.state === undefined && regex === undefined) break
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }

    snapshot = snapshot ?? (await updateSemanticSnapshot(session, input.windowLines))
    const transcript = regex ? await readTranscript(id, input.sessionID, { bytes: TRANSCRIPT_RECENT_BYTES }) : undefined
    return {
      matched: false,
      timedOut: true,
      stateMatched: input.state === undefined || snapshot.semanticState === input.state,
      patternMatched: regex === undefined ? true : matchesPattern(regex, [snapshot.searchText, transcript?.text ?? ""].join("\n")),
      snapshot,
    }
  }

  function matchesPattern(regex: RegExp, text: string) {
    regex.lastIndex = 0
    return regex.test(text)
  }

  /**
   * 调整终端大小
   */
  export async function resize(id: string, rows: number, cols: number, sessionID: string): Promise<boolean> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID) || session.info.status !== "running") {
      return false
    }

    session.process.resize(cols, rows)
    await session.buffer.resize(rows, cols)
    session.info.rows = rows
    session.info.cols = cols

    Bus.publish(Event.Updated, { info: session.info })
    void publishScreen(session)
    return true
  }

  /**
   * 关闭终端
   */
  export async function close(id: string, sessionID: string): Promise<boolean> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) {
      return false
    }

    log.info("closing agent terminal", { id })
    if (session.closed) return true
    if (session.closing) {
      await finalizeClose(session)
      return true
    }
    session.closing = true
    if (session.info.status === "running") terminateProcessTree(session)
    await finalizeClose(session)
    return true
  }

  export async function closeSession(sessionID: string): Promise<number> {
    const terminals = Array.from(state().values()).filter((session) => belongsToSession(session, sessionID))
    let closed = 0
    for (const session of terminals) {
      if (await close(session.info.id, sessionID)) closed++
    }
    return closed
  }

  /**
   * 获取原始输出缓冲区
   */
  export async function getBuffer(id: string, afterSeq: number | undefined, sessionID: string): Promise<BufferSnapshot | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await flushOutput(session)

    const latestSeq = session.outputSeq
    const firstSeq = session.outputChunks[0]?.seq ?? latestSeq + 1
    if (afterSeq !== undefined) {
      const reset = afterSeq < firstSeq - 1
      return {
        buffer: reset ? session.rawBuffer : "",
        chunks: reset ? [] : session.outputChunks.filter((chunk) => chunk.seq > afterSeq),
        latestSeq,
        firstSeq,
        reset,
      }
    }

    return {
      buffer: session.rawBuffer,
      chunks: [],
      latestSeq,
      firstSeq,
      reset: true,
    }
  }
}
