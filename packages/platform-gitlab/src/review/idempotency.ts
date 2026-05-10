import type { GitLabReviewTrigger } from './types'

export function buildGitLabReviewIdempotencyKey(trigger: GitLabReviewTrigger): string {
  const base = [
    'gitlab',
    normalizePart(trigger.host),
    normalizePart(trigger.projectId),
  ]

  if (trigger.objectType === 'mr') {
    const mrIid = requiredPart(trigger.objectIid, 'MR IID')
    const headSha = requiredPart(trigger.headSha, 'MR head SHA')
    base.push('mr', mrIid, 'head_sha', headSha)
  } else {
    const commitSha = requiredPart(trigger.commitSha ?? trigger.headSha, 'commit SHA')
    base.push('commit', commitSha)
  }

  if (trigger.noteId !== undefined && trigger.noteId !== null) {
    base.push('note', normalizePart(trigger.noteId))
  } else {
    base.push('auto', normalizePart(trigger.eventName ?? trigger.mode))
  }

  return base.join(':')
}

function requiredPart(input: unknown, label: string) {
  const normalized = normalizePart(input)
  if (!normalized) throw new Error(`Cannot build GitLab review idempotency key without ${label}.`)
  return normalized
}

function normalizePart(input: unknown) {
  return String(input ?? '').trim().replaceAll(':', '%3A')
}
