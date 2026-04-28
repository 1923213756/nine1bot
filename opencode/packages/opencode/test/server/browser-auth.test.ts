import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("browser relay auth boundary", () => {
  test("allows local extension bootstrap and websocket paths through basic auth", () => {
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1:4096")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "localhost:4096")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "[::1]:4096")).toBe(true)
  })

  test("keeps non-local browser relay requests behind basic auth", () => {
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "nine1bot.example.com")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "192.168.1.10:4096")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/session", "127.0.0.1:4096")).toBe(false)
  })
})
