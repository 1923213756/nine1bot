import { aggregateReviewFindings } from './finding-aggregator'
import { parseReviewStageResult, type ReviewStageResult } from './output-schema'
import type { AggregatedReviewFinding, ReviewFinding, SubagentFailureMode, SubagentTaskSpec } from './types'

export type SubagentTaskOutput = {
  taskId: string
  role?: string
  text?: string
  error?: string
  timedOut?: boolean
}

export type CompiledSubagentResult = {
  status: 'ok' | 'blocked' | 'failed'
  findings: AggregatedReviewFinding[]
  stageResults: Array<{
    taskId: string
    role?: string
    result: ReviewStageResult
  }>
  warnings: string[]
  failedTasks: Array<{
    taskId: string
    role?: string
    failureMode: SubagentFailureMode
    reason: string
  }>
}

export function compileSubagentStageResults(input: {
  specs: SubagentTaskSpec[]
  outputs: SubagentTaskOutput[]
}): CompiledSubagentResult {
  const specsById = new Map(input.specs.map((spec) => [spec.id, spec]))
  const findings: ReviewFinding[] = []
  const stageResults: CompiledSubagentResult['stageResults'] = []
  const warnings: string[] = []
  const failedTasks: CompiledSubagentResult['failedTasks'] = []
  let abortRun = false
  let blocked = false

  for (const output of input.outputs) {
    const spec = specsById.get(output.taskId)
    const failureMode = spec?.failureMode ?? 'fallback'
    const role = output.role ?? spec?.role
    const failureReason = subagentFailureReason(output)
    if (failureReason) {
      const decision = handleSubagentFailure({
        taskId: output.taskId,
        role,
        failureMode,
        reason: failureReason,
        warnings,
        failedTasks,
      })
      abortRun ||= decision.abortRun
      continue
    }

    const parsed = parseSubagentStageResult(output.text ?? '')
    if (!parsed) {
      const decision = handleSubagentFailure({
        taskId: output.taskId,
        role,
        failureMode,
        reason: 'missing-or-invalid-review-stage-result',
        warnings,
        failedTasks,
      })
      abortRun ||= decision.abortRun
      continue
    }

    stageResults.push({ taskId: output.taskId, role, result: parsed })
    if (parsed.status === 'blocked') blocked = true
    if (parsed.status === 'failed') {
      const decision = handleSubagentFailure({
        taskId: output.taskId,
        role,
        failureMode,
        reason: parsed.summary || 'subagent-returned-failed-status',
        warnings,
        failedTasks,
      })
      abortRun ||= decision.abortRun
    }
    findings.push(...parsed.findings.map((finding) => ({
      ...finding,
      source: finding.source ?? role ?? output.taskId,
    })))
    if (parsed.nextActions?.length) {
      warnings.push(...parsed.nextActions.map((action) => `${output.taskId}: ${action}`))
    }
  }

  return {
    status: abortRun ? 'failed' : blocked ? 'blocked' : 'ok',
    findings: aggregateReviewFindings(findings),
    stageResults,
    warnings: unique(warnings),
    failedTasks,
  }
}

export function parseSubagentStageResult(text: string): ReviewStageResult | undefined {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      return parseReviewStageResult(JSON.parse(candidate))
    } catch {
      continue
    }
  }
  return undefined
}

function subagentFailureReason(output: SubagentTaskOutput) {
  if (output.timedOut) return 'subagent-timeout'
  if (output.error) return output.error
  return undefined
}

function handleSubagentFailure(input: {
  taskId: string
  role?: string
  failureMode: SubagentFailureMode
  reason: string
  warnings: string[]
  failedTasks: CompiledSubagentResult['failedTasks']
}) {
  input.failedTasks.push({
    taskId: input.taskId,
    role: input.role,
    failureMode: input.failureMode,
    reason: input.reason,
  })

  if (input.failureMode === 'abort-run') {
    input.warnings.push(`${input.taskId} aborted the review run: ${input.reason}`)
    return { abortRun: true }
  }
  if (input.failureMode === 'ignore') {
    input.warnings.push(`${input.taskId} was ignored after failure: ${input.reason}`)
    return { abortRun: false }
  }
  input.warnings.push(`${input.taskId} used fallback after failure: ${input.reason}`)
  return { abortRun: false }
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fencePattern)) {
    const content = match[1]?.trim()
    if (content) candidates.push(stripOptionalTag(content))
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(stripOptionalTag(text.slice(firstBrace, lastBrace + 1).trim()))
  }
  return unique(candidates)
}

function stripOptionalTag(content: string) {
  return content.replace(/^GITLAB_REVIEW_RESULT\s*:?\s*/i, '').trim()
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}
