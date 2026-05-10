import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  aggregateReviewFindings,
  buildGitLabDiffManifest,
  buildGitLabReviewContext,
  buildGitLabReviewIdempotencyKey,
  buildInitialGitLabReviewSubagentTasks,
  compileSubagentStageResults,
  defaultGitLabReviewSettings,
  parseGitLabWebhookEvent,
  parseReviewStageResult,
  publishGitLabReviewResult,
  renderBlockedDiffComment,
  renderReviewSummaryComment,
  validateGitLabInlinePosition,
  type GitLabRawChangesResponse,
  type GitLabReviewTrigger,
  type ReviewFinding,
  type SubagentTaskOutput,
} from '../src/review'

type DryRunMode = 'changes' | 'webhook'

const args = process.argv.slice(2)
const mode = parseMode(args)
const fixturePath = resolve(process.cwd(), parseFixturePath(args, mode))
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const runtimeOutputPath = parseFlagValue(args, '--runtime-output')
const subagentOutputPath = parseFlagValue(args, '--subagent-outputs')

if (mode === 'webhook') {
  await runWebhookDryRun(fixture)
} else {
  await runChangesDryRun(fixture as GitLabRawChangesResponse)
}

async function runChangesDryRun(changes: GitLabRawChangesResponse) {
  const trigger: GitLabReviewTrigger = {
    host: 'gitlab.example.com',
    projectId: 1,
    objectType: 'mr',
    objectIid: 10,
    headSha: changes.diff_refs?.head_sha ?? 'dry-run-head',
    mode: 'webhook',
    eventName: 'merge_request',
  }
  const manifest = buildGitLabDiffManifest(changes)
  const idempotencyKey = buildGitLabReviewIdempotencyKey(trigger)

  if (manifest.blocked) {
    print({
      mode: 'changes',
      idempotencyKey,
      blocked: true,
      comment: renderBlockedDiffComment(manifest.blockReason ?? 'Diff blocked.'),
    })
    return
  }

  const syntheticFindings = syntheticFindingsForManifest(manifest)
  const inline = validateGitLabInlinePosition(syntheticFindings[0]!, manifest.files, manifest.diffRefs)
  const findings = aggregateReviewFindings(syntheticFindings)
  const comment = renderReviewSummaryComment({
    summary: 'Dry-run completed without calling GitLab or Runtime.',
    findings,
    manifest,
    warnings: inline.ok ? [] : [inline.reason],
  })

  print({
    mode: 'changes',
    idempotencyKey,
    blocked: false,
    manifest,
    inline,
    comment,
  })
}

async function runWebhookDryRun(payload: unknown) {
  const parsed = parseGitLabWebhookEvent(payload, {
    ...defaultGitLabReviewSettings,
    enabled: true,
    webhookAutoReview: true,
    manualMentionTrigger: true,
    botMention: '@Nine1bot',
  })
  if (!parsed.ok) {
    print({ mode: 'webhook', accepted: false, reason: parsed.reason })
    return
  }

  const changes = extractChanges(payload)
  if (!changes) {
    print({
      mode: 'webhook',
      accepted: false,
      reason: 'fixture-missing-review-changes',
      trigger: parsed.trigger,
    })
    return
  }

  const context = buildGitLabReviewContext({
    trigger: parsed.trigger,
    changes,
  })

  if (context.diff.blocked) {
    print({
      mode: 'webhook',
      accepted: true,
      idempotencyKey: context.idempotencyKey,
      blocked: true,
      comment: renderBlockedDiffComment(context.diff.blockReason ?? 'Diff blocked.'),
      contextBlocks: context.contextBlocks,
    })
    return
  }

  const injectedStageResult = subagentOutputPath
    ? stageResultFromSubagentOutputs(readJsonFile(resolve(process.cwd(), subagentOutputPath)))
    : runtimeOutputPath
    ? extractRuntimeStageResult(readFileSync(resolve(process.cwd(), runtimeOutputPath), 'utf8'))
    : undefined
  const stageResult = injectedStageResult ?? {
    stage: 'closed',
    status: 'ok',
    summary: 'Dry-run webhook review completed without Runtime or GitLab network calls.',
    findings: syntheticFindingsForManifest(context.diff),
    nextActions: ['Use this fixture to debug PM prompt and publisher behavior locally.'],
  }
  const published = await publishGitLabReviewResult({
    client: mockGitLabClient(),
    projectId: parsed.trigger.projectId,
    objectType: parsed.trigger.objectType,
    objectId: parsed.trigger.objectType === 'mr' ? parsed.trigger.objectIid! : parsed.trigger.commitSha!,
    manifest: context.diff,
    summary: stageResult.summary,
    findings: stageResult.findings,
    inlineComments: true,
    warnings: stageResult.nextActions,
  })

  print({
    mode: 'webhook',
    accepted: true,
    idempotencyKey: context.idempotencyKey,
    trigger: parsed.trigger,
    contextBlocks: context.contextBlocks,
    stageResult,
    published,
  })
}

function stageResultFromSubagentOutputs(input: unknown) {
  if (!Array.isArray(input)) {
    throw new Error('Subagent output fixture must be an array.')
  }
  const compiled = compileSubagentStageResults({
    specs: buildInitialGitLabReviewSubagentTasks(),
    outputs: input.map(parseSubagentTaskOutput),
  })
  return {
    stage: 'closed',
    status: compiled.status,
    summary: `Compiled ${compiled.stageResults.length} subagent result(s), ${compiled.failedTasks.length} failure(s).`,
    findings: compiled.findings,
    nextActions: compiled.warnings,
  }
}

function parseSubagentTaskOutput(input: unknown): SubagentTaskOutput {
  if (!isRecord(input)) throw new Error('Subagent output item must be an object.')
  return {
    taskId: stringValue(input.taskId, 'taskId'),
    role: optionalString(input.role),
    text: optionalString(input.text),
    error: optionalString(input.error),
    timedOut: input.timedOut === true,
  }
}

function extractRuntimeStageResult(text: string) {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      return parseReviewStageResult(JSON.parse(candidate))
    } catch {
      continue
    }
  }
  throw new Error('No valid GITLAB_REVIEW_RESULT payload found in runtime output.')
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fencePattern)) {
    const content = match[1]?.trim()
    if (content) candidates.push(stripGitLabReviewResultTag(content))
  }
  const tagged = /GITLAB_REVIEW_RESULT\s*:?\s*(\{[\s\S]*\})/i.exec(text)
  if (tagged?.[1]) candidates.push(tagged[1].trim())
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim())
  }
  return [...new Set(candidates)]
}

function stripGitLabReviewResultTag(content: string) {
  return content.replace(/^GITLAB_REVIEW_RESULT\s*:?\s*/i, '').trim()
}

function syntheticFindingsForManifest(manifest: ReturnType<typeof buildGitLabDiffManifest>): ReviewFinding[] {
  const firstFile = manifest.files[0]
  if (!firstFile) return []
  return [{
    title: 'Dry-run changed line',
    body: 'Synthetic finding generated by the local GitLab review dry-run harness.',
    severity: 'major',
    category: 'dry-run',
    file: firstFile.newPath,
    newLine: firstChangedNewLine(firstFile.diff),
    source: 'dry-run',
  }]
}

function firstChangedNewLine(diff: string) {
  const header = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(diff)
  let current = header ? Number(header[1]) : 1
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) continue
    if (line.startsWith('+') && !line.startsWith('+++')) return current
    if (!line.startsWith('-')) current += 1
  }
  return undefined
}

function mockGitLabClient() {
  const calls: Array<Record<string, unknown>> = []
  return {
    calls,
    async createDiscussion(input: Record<string, unknown>) {
      calls.push({ type: 'discussion', ...input })
      return { id: calls.length }
    },
    async createNote(input: Record<string, unknown>) {
      calls.push({ type: 'note', ...input })
      return { id: calls.length }
    },
  }
}

function extractChanges(payload: unknown): GitLabRawChangesResponse | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (isRecord(record.review_changes)) return record.review_changes as GitLabRawChangesResponse
  if (isRecord(record.changes)) return record.changes as GitLabRawChangesResponse
  return undefined
}

function parseMode(args: string[]): DryRunMode {
  return args.includes('--webhook') ? 'webhook' : 'changes'
}

function parseFixturePath(args: string[], mode: DryRunMode) {
  const flagIndex = args.indexOf('--webhook')
  if (flagIndex >= 0) return args[flagIndex + 1] ?? 'fixtures/review/sample-webhook-mr-note.json'
  return args[0] ?? (mode === 'webhook' ? 'fixtures/review/sample-webhook-mr-note.json' : 'fixtures/review/sample-mr-changes.json')
}

function parseFlagValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function readJsonFile(filepath: string) {
  return JSON.parse(readFileSync(filepath, 'utf8'))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input))
}

function stringValue(input: unknown, field: string) {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${field} must be a non-empty string.`)
  return input
}

function optionalString(input: unknown) {
  return typeof input === 'string' ? input : undefined
}

function print(input: unknown) {
  console.log(JSON.stringify(input, null, 2))
}
