import { describe, expect, test } from "bun:test"
import path from "path"
import { RuntimeContextEvents } from "../../src/runtime/context/events"
import { RuntimePlatformAdapterRegistry } from "../../src/runtime/platform/adapter"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("platform page context registry", () => {
  test("normalizes page payload and emits stable blocks through registered platform adapter", () => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimePlatformAdapterRegistry.register({
      id: "test-platform",
      matchPage: (page) => page.platform === "test-platform",
      normalizePage: (page) => ({
        ...page,
        pageType: "test-mr",
        objectKey: "test-platform:project!42",
      }),
      blocksFromPage: (page, observedAt) => [
        {
          id: "platform:test-platform",
          layer: "platform",
          source: "page-context.test-platform",
          content: `Platform: ${page.platform}`,
          lifecycle: "turn",
          visibility: "developer-toggle",
          enabled: true,
          priority: 65,
          mergeKey: "test-platform:project!42",
          observedAt,
        },
        {
          id: "page:test-mr",
          layer: "page",
          source: "page-context.test-platform",
          content: "Object key: test-platform:project!42",
          lifecycle: "turn",
          visibility: "developer-toggle",
          enabled: true,
          priority: 62,
          mergeKey: "test-platform:project!42",
          observedAt,
        },
      ],
    })
    const payload = RuntimeContextEvents.normalizePagePayload({
      platform: "test-platform",
      url: "https://example.test/nine1/nine1bot/-/merge_requests/42",
      title: "Improve runtime",
      selection: "selected MR line",
      visibleSummary: "MR overview",
    })

    expect(payload).toMatchObject({
      platform: "test-platform",
      pageType: "test-mr",
      objectKey: "test-platform:project!42",
    })

    const blocks = RuntimeContextEvents.blocksFromPagePayload(payload, 1_000)
    expect(blocks.map((block) => block.id)).toEqual([
      "platform:test-platform",
      "page:test-mr",
    ])
    expect(blocks[1]?.content).toEqual(expect.stringContaining("Object key: test-platform:project!42"))
    RuntimePlatformAdapterRegistry.clearForTesting()
  })

  test("deduplicates same-page events and records page transitions, content changes, and selection updates", async () => {
    RuntimePlatformAdapterRegistry.clearForTesting()
    RuntimePlatformAdapterRegistry.register({
      id: "test-platform",
      matchPage: (page) => page.platform === "test-platform",
      normalizePage: (page) => ({
        ...page,
        objectKey: page.objectKey ?? page.url,
      }),
    })
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sessionID = `test_gitlab_${Date.now()}`
        const projectID = `project_${sessionID}`
        await RuntimeContextEvents.removeAll({ sessionID, projectID })

        const repo = {
          platform: "test-platform",
          url: "https://example.test/nine1/nine1bot",
          title: "nine1bot",
          pageType: "test-repo",
          objectKey: "test-platform:repo",
          visibleSummary: "Repository overview",
        }
        const mr = {
          platform: "test-platform",
          url: "https://example.test/nine1/nine1bot/-/merge_requests/42",
          title: "Improve runtime",
          pageType: "test-mr",
          objectKey: "test-platform:mr:42",
          visibleSummary: "MR overview",
        }

        const enterRepo = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page: repo })
        expect(enterRepo?.event?.type).toBe("page-enter")
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: enterRepo! })

        const sameRepo = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page: repo })
        expect(sameRepo?.deduped).toBe(true)
        expect(sameRepo?.event).toBeUndefined()

        const enterMr = await RuntimeContextEvents.preparePageEvent({ sessionID, projectID, page: mr })
        expect(enterMr?.event?.type).toBe("page-enter")
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: enterMr! })

        const updatedMr = await RuntimeContextEvents.preparePageEvent({
          sessionID,
          projectID,
          page: {
            ...mr,
            visibleSummary: "MR overview with new discussion",
          },
        })
        expect(updatedMr?.event?.type).toBe("page-update")
        await RuntimeContextEvents.commitPageEvent({ sessionID, projectID, prepared: updatedMr! })

        const selectedMr = await RuntimeContextEvents.preparePageEvent({
          sessionID,
          projectID,
          page: {
            ...mr,
            visibleSummary: "MR overview with new discussion",
            selection: "review this line",
          },
        })
        expect(selectedMr?.event?.type).toBe("selection-update")
        expect(selectedMr?.event?.blocks.map((block) => block.id)).toEqual([
          expect.stringMatching(/^page:selection:/),
        ])

        await RuntimeContextEvents.removeAll({ sessionID, projectID })
      },
    })
    RuntimePlatformAdapterRegistry.clearForTesting()
  })
})
