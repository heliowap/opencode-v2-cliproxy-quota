import { afterAll, describe, expect, test } from "bun:test"
import { fetchAccounts, resolveSettings } from "../src/client.ts"

const seen: { path: string; key: string | null }[] = []
const probes: unknown[] = []

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    seen.push({ path: url.pathname, key: request.headers.get("x-management-key") })
    if (request.headers.get("x-management-key") !== "secret") return Response.json({ error: "invalid management key" }, { status: 401 })
    if (url.pathname === "/failing/v8/management/credentials")
      return Response.json({
        files: [{ provider: "codex", auth_index: "x1", label: "x", quota: { signals: { "X-Codex-Primary-Used-Percent": "9" } } }],
      })
    if (url.pathname === "/failing/v8/management/requests/api-call") return Response.json({ status_code: 401, header: {}, body: "{}" })
    if (url.pathname.endsWith("/v8/management/requests/api-call")) {
      const body = await request.json()
      probes.push(body)
      return Response.json({
        status_code: 200,
        header: {},
        body: JSON.stringify({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 75, weeklyQuotaRemainingPercent: 40 } } }),
      })
    }
    if (url.pathname === "/devin/v8/management/credentials")
      return Response.json({ files: [{ provider: "devin", auth_index: "d1", label: "dev", quota: { signals: {} } }] })
    return Response.json({
      files: [{ provider: "codex", label: "a", quota: { signals: { "X-Codex-Primary-Used-Percent": "12" } } }],
    })
  },
})

afterAll(() => server.stop(true))

describe("fetchAccounts", () => {
  test("reads credentials from the v8 management API with the management key", async () => {
    expect(await fetchAccounts({ baseURL: server.url.origin, managementKey: "secret" }, 0)).toEqual({
      ok: true,
      accounts: [{ provider: "codex", label: "a", authIndex: undefined, observedAt: undefined, windows: [{ kind: "5h", usedPercent: 12, resetAt: undefined }] }],
    })
    expect(seen.at(-1)).toEqual({ path: "/v8/management/credentials", key: "secret" })
  })

  test("probes Devin credentials without quota signals through the proxy's api-call", async () => {
    const result = await fetchAccounts({ baseURL: `${server.url.origin}/devin`, managementKey: "secret" }, 0)
    expect(result).toEqual({
      ok: true,
      accounts: [
        {
          provider: "devin",
          label: "dev",
          authIndex: "d1",
          observedAt: 0,
          windows: [
            { kind: "day", usedPercent: 25, resetAt: undefined },
            { kind: "week", usedPercent: 60, resetAt: undefined },
          ],
        },
      ],
    })
    expect(probes).toEqual([
      {
        auth_index: "d1",
        method: "POST",
        url: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
        header: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        data: JSON.stringify({ metadata: { ideName: "chisel", ideVersion: "3000.10.21", apiKey: "$TOKEN$", locale: "en", os: "darwin", extensionVersion: "3000.10.21", clientName: "chisel" } }),
      },
    ])
  })

  test("keeps the recorded signals of a credential whose probe fails", async () => {
    expect(await fetchAccounts({ baseURL: `${server.url.origin}/failing`, managementKey: "secret" }, 0)).toEqual({
      ok: true,
      accounts: [
        { provider: "codex", label: "x", authIndex: "x1", observedAt: undefined, windows: [{ kind: "5h", usedPercent: 9, resetAt: undefined }] },
      ],
    })
  })

  test("reports the proxy's error message on a rejected key", async () => {
    expect(await fetchAccounts({ baseURL: server.url.origin, managementKey: "wrong" }, 0)).toEqual({
      ok: false,
      error: "HTTP 401: invalid management key",
    })
  })

  test("reports a missing key without calling the proxy", async () => {
    const before = seen.length
    expect(await fetchAccounts({ baseURL: server.url.origin, managementKey: "" }, 0)).toEqual({
      ok: false,
      error: "Set the CLIPROXY_MANAGEMENT_KEY environment variable or the managementKey plugin option",
    })
    expect(seen.length).toBe(before)
  })

  test("reports an unreachable proxy", async () => {
    const result = await fetchAccounts({ baseURL: "http://127.0.0.1:1", managementKey: "secret" }, 0)
    expect(result.ok).toBe(false)
  })
})

describe("resolveSettings", () => {
  test("prefers plugin options over the environment and trims a trailing slash", () => {
    expect(
      resolveSettings({ baseURL: "http://proxy:9000/", managementKey: "opt" }, { CLIPROXY_MANAGEMENT_KEY: "env" }),
    ).toEqual({ baseURL: "http://proxy:9000", managementKey: "opt", intervalMs: 60_000, providers: [] })
  })

  test("falls back to the environment and the default local proxy", () => {
    expect(resolveSettings({}, { CLIPROXY_MANAGEMENT_KEY: "env", CLIPROXY_URL: "http://127.0.0.1:8400" })).toEqual({
      baseURL: "http://127.0.0.1:8400",
      managementKey: "env",
      intervalMs: 60_000,
      providers: [],
    })
    expect(resolveSettings({}, {})).toEqual({ baseURL: "http://127.0.0.1:8317", managementKey: "", intervalMs: 60_000, providers: [] })
  })

  test("accepts a refresh interval in seconds with a 10 second floor", () => {
    expect(resolveSettings({ intervalSeconds: 30 }, {}).intervalMs).toBe(30_000)
    expect(resolveSettings({ intervalSeconds: 1 }, {}).intervalMs).toBe(10_000)
    expect(resolveSettings({ intervalSeconds: "x" }, {}).intervalMs).toBe(60_000)
  })
})

describe("resolveSettings providers", () => {
  test("defaults to no explicit providers and accepts a list", () => {
    expect(resolveSettings({}, {}).providers).toEqual([])
    expect(resolveSettings({ providers: ["proxy", 3, "cpa"] }, {}).providers).toEqual(["proxy", "cpa"])
  })
})
