export type GitLabWebhookValidation = {
  ok: boolean
  reason?: string
}

export function validateGitLabWebhookToken(input: {
  expectedSecret?: string
  receivedToken?: string | null
}): GitLabWebhookValidation {
  if (!input.expectedSecret) return { ok: false, reason: 'missing-webhook-secret' }
  if (!input.receivedToken) return { ok: false, reason: 'missing-x-gitlab-token' }
  return timingSafeEqualString(input.expectedSecret, input.receivedToken)
    ? { ok: true }
    : { ok: false, reason: 'invalid-x-gitlab-token' }
}

function timingSafeEqualString(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  let diff = leftBytes.length ^ rightBytes.length
  const max = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < max; index++) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return diff === 0
}
