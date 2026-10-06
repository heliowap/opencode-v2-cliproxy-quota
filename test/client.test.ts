import { afterAll, describe, expect, test } from "bun:test"
import { fetchAccounts, resolveSettings } from "../src/client.ts"

const seen: { path: string; key: string | null }[] = []

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    seen.push({ path: url.pathname, key: request.headers.get("x-management-key") })
    if (request.headers.get("x-management-key") !== "secret") return Response.json({ error: "invalid management key" }, { status: 401 })
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
      accounts: [{ provider: "codex", label: "a", observedAt: undefined, windows: [{ kind: "5h", usedPercent: 12, resetAt: undefined }] }],
    })
    expect(seen.at(-1)).toEqual({ path: "/v8/management/credentials", key: "secret" })
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
