import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("browser relay auth boundary", () => {
  test("allows loopback extension bootstrap and websocket paths through basic auth", () => {
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "::1")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "::ffff:127.0.0.1")).toBe(true)
  })

  test("keeps non-local browser relay requests behind basic auth", () => {
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "192.168.1.10")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "10.0.0.12")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/session", "127.0.0.1")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", undefined)).toBe(false)
  })
})
