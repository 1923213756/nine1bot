import { buildGitLabDiffManifest } from './diff-builder'
import { buildGitLabReviewIdempotencyKey } from './idempotency'
import type { GitLabRawChangesResponse, GitLabReviewTrigger } from './types'

export type GitLabReviewContext = {
  trigger: GitLabReviewTrigger
  idempotencyKey: string
  diff: ReturnType<typeof buildGitLabDiffManifest>
  contextBlocks: Array<{
    id: string
    layer: 'platform'
    source: string
    enabled: boolean
    priority: number
    lifecycle: 'turn'
    visibility: 'system-required'
    content: string
  }>
}

export function buildGitLabReviewContext(input: {
  trigger: GitLabReviewTrigger
  changes: GitLabRawChangesResponse
  maxDiffBytes?: number
  maxFiles?: number
}): GitLabReviewContext {
  const diff = buildGitLabDiffManifest(input.changes, {
    maxDiffBytes: input.maxDiffBytes,
    maxFiles: input.maxFiles,
  })
  return {
    trigger: input.trigger,
    idempotencyKey: buildGitLabReviewIdempotencyKey(input.trigger),
    diff,
    contextBlocks: [
      {
        id: 'gitlab-review-trigger',
        layer: 'platform',
        source: 'platform.gitlab.review.trigger',
        enabled: true,
        priority: 90,
        lifecycle: 'turn',
        visibility: 'system-required',
        content: renderTrigger(input.trigger),
      },
      {
        id: 'gitlab-review-diff-manifest',
        layer: 'platform',
        source: 'platform.gitlab.review.diff',
        enabled: true,
        priority: 88,
        lifecycle: 'turn',
        visibility: 'system-required',
        content: renderDiffManifest(diff),
      },
    ],
  }
}

function renderTrigger(trigger: GitLabReviewTrigger) {
  return [
    'GitLab review trigger',
    `Host: ${trigger.host}`,
    `Project: ${trigger.projectPath ?? trigger.projectId}`,
    `Object: ${trigger.objectType}`,
    trigger.objectIid ? `IID: ${trigger.objectIid}` : undefined,
    trigger.commitSha ? `Commit: ${trigger.commitSha}` : undefined,
    trigger.headSha ? `Head SHA: ${trigger.headSha}` : undefined,
    trigger.noteId ? `Note: ${trigger.noteId}` : undefined,
    trigger.userInstruction ? `User instruction: ${trigger.userInstruction}` : undefined,
    trigger.focusTags?.length ? `Focus tags: ${trigger.focusTags.join(', ')}` : undefined,
    trigger.instructionRisk ? `Instruction risk: ${trigger.instructionRisk}` : undefined,
    `Mode: ${trigger.mode}`,
  ].filter(Boolean).join('\n')
}

function renderDiffManifest(diff: GitLabReviewContext['diff']) {
  if (diff.blocked) return `Blocked: ${diff.blockReason ?? 'diff blocked'}`
  return [
    `Files included: ${diff.stats.includedFileCount}/${diff.stats.fileCount}`,
    `Skipped files: ${diff.stats.skippedFileCount}`,
    `Included bytes: ${diff.stats.includedBytes}`,
    '',
    ...diff.files.map((file) => `- ${file.newPath}${file.renamed ? ` (renamed from ${file.oldPath})` : ''}`),
  ].join('\n')
}
