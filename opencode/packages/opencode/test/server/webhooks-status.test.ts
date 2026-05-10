import { describe, expect, test } from "bun:test"
import {
  gitLabReviewPublishStatus,
  gitLabReviewRetryPatch,
  publicGitLabReviewRun,
  webhookLocalOrigin,
} from "../../src/server/routes/webhooks"

describe("webhook status URL selection", () => {
  test("uses configured local URL when provided", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096/",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("strips repeated trailing slashes from configured local URL", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096///",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("replaces loopback browser origin with a reachable LAN IPv4", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      interfaces: {
        Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
        Ethernet: [{ address: "192.168.53.6", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("keeps non-loopback origins unchanged", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://192.168.53.6:4096",
      interfaces: {
        Ethernet: [{ address: "10.0.0.12", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("omits heavy GitLab review context from list records", () => {
    expect(publicGitLabReviewRun({
      id: "run_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      context: {
        diff: {
          files: [{ diff: "large diff" }],
        },
      },
    } as any)).toEqual({
      id: "run_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
    })
  })

  test("maps GitLab review publish failures to specific HTTP statuses", () => {
    expect(gitLabReviewPublishStatus("review_run_not_found")).toBe(404)
    expect(gitLabReviewPublishStatus("review_run_already_published")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_already_active")).toBe(409)
    expect(gitLabReviewPublishStatus("gitlab_api_publish_failed:403:Forbidden")).toBe(502)
    expect(gitLabReviewPublishStatus("invalid_stage_result")).toBe(400)
  })

  test("clears stale GitLab review failure and session metadata on retry", () => {
    const patch = gitLabReviewRetryPatch({
      id: "run_1",
      platform: "gitlab",
      status: "failed",
      createdAt: 1,
      updatedAt: 2,
      retryCount: 1,
      error: "gitlab_review_result_missing",
      sessionId: "session_old",
      turnSnapshotId: "turn_old",
      failureNotifiedAt: 123,
      warnings: ["old warning"],
    })

    expect(patch).toMatchObject({
      status: "accepted",
      error: undefined,
      sessionId: undefined,
      turnSnapshotId: undefined,
      failureNotifiedAt: undefined,
      retryCount: 2,
      publishedAt: undefined,
      warnings: [
        "old warning",
        "Review run manually retried from stored GitLab context.",
      ],
    })
  })
})
