import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("browser relay auth boundary", () => {
  test("allows loopback and intranet extension bootstrap and websocket paths through basic auth", () => {
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "::1")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "::ffff:127.0.0.1")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "192.168.1.10")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "10.0.0.12")).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      "x-forwarded-for": "127.0.0.1",
    })).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      forwarded: "for=\"[::1]\";proto=http",
    })).toBe(true)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "192.168.1.10", {
      "x-forwarded-for": "192.168.1.11",
    })).toBe(true)
  })

  test("keeps public browser relay requests and other routes behind basic auth", () => {
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "203.0.113.10")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "8.8.8.8")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/session", "127.0.0.1")).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", undefined)).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      "x-forwarded-for": "203.0.113.10",
    })).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/extension", "127.0.0.1", {
      forwarded: "for=203.0.113.10;proto=https",
    })).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      "x-forwarded-for": "127.0.0.1, 203.0.113.10",
    })).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      "x-forwarded-for": "unknown",
    })).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      forwarded: "for=unknown;proto=https",
    })).toBe(false)
    expect(Server.isLocalBrowserRelayAuthBypass("/browser/bootstrap", "127.0.0.1", {
      forwarded: "",
    })).toBe(false)
  })
})
