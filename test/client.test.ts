import { afterAll, describe, expect, test } from "bun:test"
import { fetchAccounts, resolveSettings } from "../src/client.ts"
import type { Account } from "../src/quota.ts"

const seen: { path: string; key: string | null }[] = []
const probes: unknown[] = []
const claude = { status: 200, probes: 0, observedAt: "2026-10-06T12:00:00Z", fiveHour: "0.2", sevenDay: "0.4" }
const claudeSettings = () => ({ baseURL: `${server.url.origin}/claude`, managementKey: "secret" })

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
    if (url.pathname === "/claude/v8/management/credentials")
      return Response.json({
        files: [
          {
            provider: "claude",
            auth_index: "c1",
            label: "claude-a",
            quota: {
              observed_at: claude.observedAt,
              signals: {
                "Anthropic-Ratelimit-Unified-5h-Utilization": claude.fiveHour,
                "Anthropic-Ratelimit-Unified-5h-Reset": "1791298800",
                "Anthropic-Ratelimit-Unified-7d-Utilization": claude.sevenDay,
                "Anthropic-Ratelimit-Unified-7d-Reset": "1791514800",
              },
            },
          },
        ],
      })
    if (url.pathname === "/claude/v8/management/requests/api-call") {
      claude.probes++
      if (claude.status === 429)
        return Response.json({
          status_code: 429,
          header: { "Retry-After": ["0"] },
          body: JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }),
        })
      return Response.json({
        status_code: 200,
        header: {},
        body: JSON.stringify({
          five_hour: { utilization: 34, resets_at: "2026-10-06T15:00:00Z" },
          seven_day: { utilization: 61, resets_at: "2026-10-09T03:00:00Z" },
          limits: [{ kind: "weekly_scoped", percent: 25, resets_at: "2026-10-06T13:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: true }],
        }),
      })
    }
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

  test("keeps the last live Claude windows, including Fable, when a later probe is rate limited", async () => {
    Object.assign(claude, { status: 200, probes: 0, observedAt: "2026-10-06T12:00:00Z", fiveHour: "0.2", sevenDay: "0.4" })
    const memory = new Map()
    const live: Account = {
      provider: "claude",
      label: "claude-a",
      authIndex: "c1",
      observedAt: 1791288600_000,
      windows: [
        { kind: "5h", usedPercent: 34, resetAt: 1791298800_000 },
        { kind: "week", usedPercent: 61, resetAt: 1791514800_000 },
        { kind: "fable", usedPercent: 25, resetAt: 1791291600_000 },
      ],
    }
    expect(await fetchAccounts(claudeSettings(), 1791288600_000, memory)).toEqual({ ok: true, accounts: [live] })
    claude.status = 429
    expect(await fetchAccounts(claudeSettings(), 1791288900_000, memory)).toEqual({ ok: true, accounts: [live] })
    expect(claude.probes).toBe(2)
  })

  test("asks Anthropic about a Claude credential at most once every five minutes", async () => {
    Object.assign(claude, { status: 200, probes: 0, observedAt: "2026-10-06T12:00:00Z", fiveHour: "0.2", sevenDay: "0.4" })
    const memory = new Map()
    const counts: number[] = []
    for (const now of [1791288600_000, 1791288660_000, 1791288899_000, 1791288900_000]) {
      await fetchAccounts(claudeSettings(), now, memory)
      counts.push(claude.probes)
    }
    expect(counts).toEqual([1, 1, 1, 2])
  })

  test("shows each Claude window from its newest observation and keeps Fable from the last probe", async () => {
    Object.assign(claude, { status: 200, probes: 0, observedAt: "2026-10-06T12:00:00Z", fiveHour: "0.2", sevenDay: "0.4" })
    const memory = new Map()
    await fetchAccounts(claudeSettings(), 1791288600_000, memory)
    Object.assign(claude, { observedAt: "2026-10-06T12:12:00Z", fiveHour: "0.5", sevenDay: "0.62" })
    expect(await fetchAccounts(claudeSettings(), 1791288780_000, memory)).toEqual({
      ok: true,
      accounts: [
        {
          provider: "claude",
          label: "claude-a",
          authIndex: "c1",
          observedAt: 1791288720_000,
          windows: [
            { kind: "5h", usedPercent: 50, resetAt: 1791298800_000 },
            { kind: "week", usedPercent: 62, resetAt: 1791514800_000 },
            { kind: "fable", usedPercent: 25, resetAt: 1791291600_000 },
          ],
        },
      ],
    })
  })

  test("treats a kept live window whose reset time has passed as renewed", async () => {
    Object.assign(claude, { status: 200, probes: 0, observedAt: "2026-10-06T12:00:00Z", fiveHour: "0.2", sevenDay: "0.4" })
    const memory = new Map()
    await fetchAccounts(claudeSettings(), 1791288600_000, memory)
    claude.status = 429
    const later = await fetchAccounts(claudeSettings(), 1791295800_000, memory)
    expect(later.ok && later.accounts.map((account) => account.windows)).toEqual([
      [
        { kind: "5h", usedPercent: 34, resetAt: 1791298800_000 },
        { kind: "week", usedPercent: 61, resetAt: 1791514800_000 },
        { kind: "fable", usedPercent: 0, resetAt: undefined },
      ],
    ])
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
