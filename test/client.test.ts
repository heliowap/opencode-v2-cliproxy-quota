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
    if (url.pathname === "/broken/v8/management/credentials") return new Response("upstream exploded", { status: 502, statusText: "Bad Gateway" })
    if (url.pathname === "/html/v8/management/credentials")
      return Response.json({
        files: [{ provider: "codex", auth_index: "h1", label: "h", quota: { signals: { "X-Codex-Primary-Used-Percent": "3" } } }],
      })
    if (url.pathname === "/html/v8/management/requests/api-call") return Response.json({ status_code: 200, header: {}, body: "<html>login</html>" })
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

  test("probes each Devin credential through the proxy's api-call and reads the answer", async () => {
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
    expect(probes.map((probe) => (probe as { auth_index: string }).auth_index)).toEqual(["d1"])
  })

  test("keeps the recorded signals of a credential whose probe fails", async () => {
    expect(await fetchAccounts({ baseURL: `${server.url.origin}/failing`, managementKey: "secret" }, 0)).toEqual({
      ok: true,
      accounts: [
        { provider: "codex", label: "x", authIndex: "x1", observedAt: undefined, windows: [{ kind: "5h", usedPercent: 9, resetAt: undefined }] },
      ],
    })
  })

  test("reports the HTTP status when the proxy answers with something other than JSON", async () => {
    expect(await fetchAccounts({ baseURL: `${server.url.origin}/broken`, managementKey: "secret" }, 0)).toEqual({
      ok: false,
      error: "HTTP 502: Bad Gateway",
    })
  })

  test("keeps the recorded signals when the upstream answers a probe with something other than JSON", async () => {
    expect(await fetchAccounts({ baseURL: `${server.url.origin}/html`, managementKey: "secret" }, 0)).toEqual({
      ok: true,
      accounts: [
        { provider: "codex", label: "h", authIndex: "h1", observedAt: undefined, windows: [{ kind: "5h", usedPercent: 3, resetAt: undefined }] },
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

  test("reports an unreachable proxy with the runtime's connection error", async () => {
    expect(await fetchAccounts({ baseURL: "http://127.0.0.1:1", managementKey: "secret" }, 0)).toEqual({
      ok: false,
      error: "Unable to connect. Is the computer able to access the url?",
    })
  })
})

describe("resolveSettings", () => {
  test("prefers plugin options over the environment and trims a trailing slash", () => {
    const env = { CLIPROXY_MANAGEMENT_KEY: "env", CLIPROXY_URL: "http://env:1" }
    const settings = resolveSettings({ baseURL: "http://proxy:9000/", managementKey: "opt" }, env)
    expect([settings.baseURL, settings.managementKey]).toEqual(["http://proxy:9000", "opt"])
  })

  test("falls back to the environment when options are missing or blank", () => {
    const settings = resolveSettings({ managementKey: "  " }, { CLIPROXY_MANAGEMENT_KEY: "env", CLIPROXY_URL: "http://127.0.0.1:8400" })
    expect([settings.baseURL, settings.managementKey]).toEqual(["http://127.0.0.1:8400", "env"])
  })

  test("converts the refresh interval from seconds and clamps it to a 10 second floor", () => {
    expect(resolveSettings({ intervalSeconds: 30 }, {}).intervalMs).toBe(30_000)
    expect(resolveSettings({ intervalSeconds: 1 }, {}).intervalMs).toBe(10_000)
  })

  test("keeps only the string provider IDs", () => {
    expect(resolveSettings({ providers: ["proxy", 3, "cpa"] }, {}).providers).toEqual(["proxy", "cpa"])
  })
})
