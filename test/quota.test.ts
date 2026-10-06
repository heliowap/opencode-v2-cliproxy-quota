import { describe, expect, test } from "bun:test"
import { bar, footerText, formatReset, isProxyProvider, level, parseCredentials, parseProbe, probeTargets, providerForModel, summarize, windowsForModel } from "../src/quota.ts"

const now = Date.parse("2026-10-06T12:00:00Z")
const sec = (iso: string) => String(Date.parse(iso) / 1000)

describe("parseCredentials", () => {
  test("reads Codex windows by their window length", () => {
    expect(
      parseCredentials(
        {
          files: [
            {
              provider: "codex",
              auth_index: "c1",
              label: "me@example.com",
              disabled: false,
              quota: {
                observed_at: "2026-10-06T11:00:00Z",
                signals: {
                  "X-Codex-Primary-Used-Percent": "42",
                  "X-Codex-Primary-Window-Minutes": "300",
                  "X-Codex-Primary-Reset-At": sec("2026-10-06T14:30:00Z"),
                  "X-Codex-Secondary-Used-Percent": "18",
                  "X-Codex-Secondary-Window-Minutes": "10080",
                  "X-Codex-Secondary-Reset-After-Seconds": "86400",
                },
              },
            },
          ],
        },
        now,
      ),
    ).toEqual([
      {
        provider: "codex",
        label: "me@example.com",
        authIndex: "c1",
        observedAt: Date.parse("2026-10-06T11:00:00Z"),
        windows: [
          { kind: "5h", usedPercent: 42, resetAt: Date.parse("2026-10-06T14:30:00Z") },
          { kind: "week", usedPercent: 18, resetAt: Date.parse("2026-10-07T11:00:00Z") },
        ],
      },
    ])
  })

  test("falls back to primary as 5h and secondary as week when Codex omits window length", () => {
    expect(
      parseCredentials(
        {
          files: [
            {
              provider: "codex",
              name: "codex-a.json",
              quota: { signals: { "X-Codex-Primary-Used-Percent": "7", "X-Codex-Secondary-Used-Percent": "3" } },
            },
          ],
        },
        now,
      ),
    ).toEqual([
      {
        provider: "codex",
        label: "codex-a.json",
        authIndex: undefined,
        observedAt: undefined,
        windows: [
          { kind: "5h", usedPercent: 7, resetAt: undefined },
          { kind: "week", usedPercent: 3, resetAt: undefined },
        ],
      },
    ])
  })

  test("reads a weekly-only Codex primary window as week", () => {
    expect(
      parseCredentials(
        {
          files: [
            {
              provider: "codex",
              label: "pro",
              quota: {
                signals: { "X-Codex-Primary-Used-Percent": "51", "X-Codex-Primary-Window-Minutes": "10080" },
              },
            },
          ],
        },
        now,
      )[0]?.windows,
    ).toEqual([{ kind: "week", usedPercent: 51, resetAt: undefined }])
  })

  test("converts Claude utilization fractions to percent", () => {
    expect(
      parseCredentials(
        {
          files: [
            {
              provider: "claude",
              label: "claude",
              quota: {
                signals: {
                  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.25",
                  "Anthropic-Ratelimit-Unified-5h-Reset": sec("2026-10-06T15:00:00Z"),
                  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.69",
                  "Anthropic-Ratelimit-Unified-7d-Reset": sec("2026-10-10T00:00:00Z"),
                },
              },
            },
          ],
        },
        now,
      )[0]?.windows,
    ).toEqual([
      { kind: "5h", usedPercent: 25, resetAt: Date.parse("2026-10-06T15:00:00Z") },
      { kind: "week", usedPercent: 69, resetAt: Date.parse("2026-10-10T00:00:00Z") },
    ])
  })

  test("converts Devin remaining percent to used percent", () => {
    expect(
      parseCredentials(
        {
          files: [
            {
              provider: "devin",
              label: "devin",
              quota: {
                signals: {
                  daily_quota_remaining_percent: "80%",
                  daily_quota_reset_at: "2026-10-07T00:00:00Z",
                  weekly_quota_remaining_percent: "35%",
                },
              },
            },
          ],
        },
        now,
      )[0]?.windows,
    ).toEqual([
      { kind: "day", usedPercent: 20, resetAt: Date.parse("2026-10-07T00:00:00Z") },
      { kind: "week", usedPercent: 65, resetAt: undefined },
    ])
  })

  test("treats a recorded window whose reset time has passed as renewed", () => {
    expect(
      parseCredentials(
        {
          files: [
            {
              provider: "claude",
              label: "c",
              quota: {
                signals: {
                  "Anthropic-Ratelimit-Unified-5h-Utilization": "0.74",
                  "Anthropic-Ratelimit-Unified-5h-Reset": sec("2026-10-06T11:00:00Z"),
                  "Anthropic-Ratelimit-Unified-7d-Utilization": "0.5",
                  "Anthropic-Ratelimit-Unified-7d-Reset": sec("2026-10-08T00:00:00Z"),
                },
              },
            },
          ],
        },
        now,
      )[0]?.windows,
    ).toEqual([
      { kind: "5h", usedPercent: 0, resetAt: undefined },
      { kind: "week", usedPercent: 50, resetAt: Date.parse("2026-10-08T00:00:00Z") },
    ])
  })

  test("skips disabled credentials and credentials without quota windows", () => {
    expect(
      parseCredentials(
        {
          files: [
            { provider: "codex", label: "off", disabled: true, quota: { signals: { "X-Codex-Primary-Used-Percent": "1" } } },
            { provider: "antigravity", label: "ag", quota: { signals: {} } },
            { provider: "claude", label: "empty" },
          ],
        },
        now,
      ),
    ).toEqual([])
  })

  test("returns no accounts for a malformed body", () => {
    expect(parseCredentials({ error: "invalid management key" }, now)).toEqual([])
    expect(parseCredentials(null, now)).toEqual([])
  })
})

describe("providerForModel", () => {
  test("maps CLIProxyAPI model IDs to the credential provider that serves them", () => {
    expect(providerForModel("gpt-6.1-sol")).toBe("codex")
    expect(providerForModel("cpa-codex-gpt-6.1-sol(high)")).toBe("codex")
    expect(providerForModel("cpa-claude-opus-5-5")).toBe("claude")
    expect(providerForModel("claude-sonnet-5")).toBe("claude")
    expect(providerForModel("devin-swe-2")).toBe("devin")
    expect(providerForModel("devin/swe-2")).toBe("devin")
    expect(providerForModel("codex/gpt-6.1-sol")).toBe("codex")
    expect(providerForModel("glm-5.3-flash")).toBeUndefined()
  })
})

describe("providerForModel for Antigravity", () => {
  test("maps Gemini models to the Antigravity Gemini group", () => {
    expect(providerForModel("gemini-3.8-flash")).toBe("antigravity")
    expect(providerForModel("cpa-ag-gemini-3.8-flash-high(high)")).toBe("antigravity")
  })

  test("maps Antigravity Claude and GPT-OSS models to its third-party group", () => {
    expect(providerForModel("cpa-ag-claude-sonnet-4-6")).toBe("antigravity-3p")
    expect(providerForModel("gpt-oss-120b-medium")).toBe("antigravity-3p")
  })
})

describe("summarize", () => {
  const accounts = [
    {
      provider: "codex",
      label: "a",
      authIndex: undefined,
      observedAt: undefined,
      windows: [
        { kind: "5h" as const, usedPercent: 10, resetAt: 1 },
        { kind: "week" as const, usedPercent: 70, resetAt: 2 },
      ],
    },
    {
      provider: "codex",
      label: "b",
      authIndex: undefined,
      observedAt: undefined,
      windows: [
        { kind: "5h" as const, usedPercent: 40, resetAt: 3 },
        { kind: "week" as const, usedPercent: 20, resetAt: 4 },
      ],
    },
    { provider: "claude", label: "c", authIndex: undefined, observedAt: undefined, windows: [{ kind: "5h" as const, usedPercent: 99, resetAt: 5 }] },
  ]

  test("reports the least-used account per window, since the proxy rotates to available credentials", () => {
    expect(summarize(accounts, "codex")).toEqual([
      { kind: "5h", usedPercent: 10, resetAt: 1 },
      { kind: "week", usedPercent: 20, resetAt: 4 },
    ])
  })

  test("returns nothing for a provider without accounts", () => {
    expect(summarize(accounts, "devin")).toEqual([])
  })
})

describe("footerText", () => {
  test("shows the remaining percent in a fixed order, like the CLIProxyAPI Management Center", () => {
    expect(
      footerText([
        { kind: "week", usedPercent: 18.4, resetAt: undefined },
        { kind: "5h", usedPercent: 42, resetAt: undefined },
      ]),
    ).toBe("5h 58% · wk 82% left")
  })

  test("is empty without windows", () => {
    expect(footerText([])).toBe("")
  })
})

describe("formatReset", () => {
  test("formats the time left until reset", () => {
    expect(formatReset(now + 65 * 60_000, now)).toBe("in 1h 5m")
    expect(formatReset(now + 3 * 86_400_000 + 4 * 3_600_000, now)).toBe("in 3d 4h")
    expect(formatReset(now + 30_000, now)).toBe("in <1m")
  })

  test("handles a reset that already passed or is unknown", () => {
    expect(formatReset(now - 1, now)).toBe("reset due")
    expect(formatReset(undefined, now)).toBe("")
  })
})

describe("windowsForModel", () => {
  const accounts = [
    {
      provider: "claude",
      label: "c",
      authIndex: "c1",
      observedAt: undefined,
      windows: [
        { kind: "5h" as const, usedPercent: 34, resetAt: undefined },
        { kind: "week" as const, usedPercent: 61, resetAt: undefined },
        { kind: "fable" as const, usedPercent: 0, resetAt: undefined },
      ],
    },
  ]

  test("includes the Fable window only for Fable models", () => {
    expect(footerText(windowsForModel(accounts, "claude-fable-5-1"))).toBe("5h 66% · wk 39% · fable 100% left")
    expect(footerText(windowsForModel(accounts, "cpa-claude-opus-5-5"))).toBe("5h 66% · wk 39% left")
  })

  test("returns nothing for a model no provider serves", () => {
    expect(windowsForModel(accounts, "glm-5.3-flash")).toEqual([])
  })
})

describe("level", () => {
  test("grades usage for coloring", () => {
    expect([0, 79, 80, 94, 95, 100].map(level)).toEqual(["ok", "ok", "warning", "warning", "error", "error"])
  })
})

describe("bar", () => {
  test("draws a ten cell usage bar", () => {
    expect(bar(0)).toBe("░░░░░░░░░░")
    expect(bar(42)).toBe("████░░░░░░")
    expect(bar(100)).toBe("██████████")
    expect(bar(140)).toBe("██████████")
  })
})

describe("isProxyProvider", () => {
  const proxy = "http://127.0.0.1:8317"

  test("matches a provider whose baseURL points at the proxy", () => {
    expect(isProxyProvider({ id: "cli_proxy_openai", settings: { baseURL: "http://127.0.0.1:8317/v1" } }, proxy, [])).toBe(true)
    expect(isProxyProvider({ id: "x", settings: { baseURL: "http://localhost:8317/v1" } }, proxy, [])).toBe(true)
  })

  test("rejects a provider on another host or without a baseURL", () => {
    expect(isProxyProvider({ id: "openai", settings: { baseURL: "https://api.openai.com/v1" } }, proxy, [])).toBe(false)
    expect(isProxyProvider({ id: "anthropic" }, proxy, [])).toBe(false)
  })

  test("matches a provider listed explicitly in options", () => {
    expect(isProxyProvider({ id: "remote" }, proxy, ["remote"])).toBe(true)
  })
})

describe("probeTargets", () => {
  test("builds a Codeium GetUserStatus call for every enabled Devin credential", () => {
    expect(
      probeTargets({
        files: [
          { provider: "devin", auth_index: "a1", label: "me@example.com", quota: { signals: {} } },
          { provider: "devin", auth_index: "a2", label: "off", disabled: true },
          { provider: "kimi", auth_index: "a4", label: "kimi" },
          { provider: "devin", label: "no index" },
        ],
      }),
    ).toEqual([
      {
        provider: "devin",
        label: "me@example.com",
        authIndex: "a1",
        call: {
          auth_index: "a1",
          method: "POST",
          url: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
          header: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
          data: '{"metadata":{"ideName":"chisel","ideVersion":"3000.10.21","apiKey":"$TOKEN$","locale":"en","os":"darwin","extensionVersion":"3000.10.21","clientName":"chisel"}}',
        },
      },
    ])
  })

  test("builds a quota summary call for Antigravity credentials with a project", () => {
    expect(
      probeTargets({
        files: [
          { provider: "antigravity", auth_index: "g1", label: "me@example.com", project_id: "aicode-consumers", quota: { signals: {} } },
          { provider: "antigravity", auth_index: "g2", label: "no project" },
        ],
      }),
    ).toEqual([
      {
        provider: "antigravity",
        label: "me@example.com",
        authIndex: "g1",
        call: {
          auth_index: "g1",
          method: "POST",
          url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
          header: {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
          },
          data: '{"project":"aicode-consumers"}',
        },
      },
    ])
  })
})

describe("probeTargets for Codex", () => {
  test("builds an oauth/usage call for Claude credentials", () => {
    expect(probeTargets({ files: [{ provider: "claude", auth_index: "k1", label: "me@example.com" }] })).toEqual([
      {
        provider: "claude",
        label: "me@example.com",
        authIndex: "k1",
        call: {
          auth_index: "k1",
          method: "GET",
          url: "https://api.anthropic.com/api/oauth/usage",
          header: {
            "User-Agent": "claude-cli/2.1.280 (external, cli)",
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "anthropic-beta": "oauth-2025-04-20",
          },
        },
      },
    ])
  })

  test("builds a wham/usage call with the ChatGPT account from the ID token", () => {
    expect(
      probeTargets({
        files: [
          {
            provider: "codex",
            auth_index: "c1",
            label: "me@example.com",
            id_token: { chatgpt_account_id: "acct-1", plan_type: "pro" },
            quota: { signals: { "X-Codex-Primary-Used-Percent": "5" } },
          },
        ],
      }),
    ).toEqual([
      {
        provider: "codex",
        label: "me@example.com",
        authIndex: "c1",
        call: {
          auth_index: "c1",
          method: "GET",
          url: "https://chatgpt.com/backend-api/wham/usage",
          header: {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
            "Chatgpt-Account-Id": "acct-1",
          },
        },
      },
    ])
  })
})

describe("parseProbe", () => {
  test("reads Codex windows from wham/usage", () => {
    expect(
      parseProbe("codex", {
        rate_limit: {
          primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1791300570 },
          secondary_window: { used_percent: 26, limit_window_seconds: 604800, reset_at: 1791887370 },
        },
      }),
    ).toEqual([
      {
        provider: "codex",
        windows: [
          { kind: "5h", usedPercent: 0, resetAt: 1791300570_000 },
          { kind: "week", usedPercent: 26, resetAt: 1791887370_000 },
        ],
      },
    ])
  })

  test("reads a weekly-only Codex plan", () => {
    expect(
      parseProbe("codex", {
        rate_limit: { primary_window: { used_percent: 26, limit_window_seconds: 604800, reset_at: 1791589256 }, secondary_window: null },
      }),
    ).toEqual([{ provider: "codex", windows: [{ kind: "week", usedPercent: 26, resetAt: 1791589256_000 }] }])
  })

  test("reads the Devin daily and weekly windows", () => {
    expect(
      parseProbe("devin", {
        userStatus: {
          planStatus: {
            dailyQuotaRemainingPercent: 100,
            weeklyQuotaRemainingPercent: 44,
            dailyQuotaResetAtUnix: "1791360000",
            weeklyQuotaResetAtUnix: "1791705600",
          },
        },
      }),
    ).toEqual([
      {
        provider: "devin",
        windows: [
          { kind: "day", usedPercent: 0, resetAt: 1791360000_000 },
          { kind: "week", usedPercent: 56, resetAt: 1791705600_000 },
        ],
      },
    ])
  })

  test("treats an omitted Devin percent as exhausted, since protobuf JSON drops zero values", () => {
    expect(
      parseProbe("devin", {
        userStatus: { planStatus: { weeklyQuotaRemainingPercent: 10, dailyQuotaResetAtUnix: "1791360000", weeklyQuotaResetAtUnix: "1791705600" } },
      }),
    ).toEqual([
      {
        provider: "devin",
        windows: [
          { kind: "day", usedPercent: 100, resetAt: 1791360000_000 },
          { kind: "week", usedPercent: 90, resetAt: 1791705600_000 },
        ],
      },
    ])
  })

  test("splits Antigravity groups into the Gemini and third-party providers", () => {
    expect(
      parseProbe("antigravity", {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-10-10T06:57:56Z", remainingFraction: 0.8347489 },
              { bucketId: "gemini-5h", window: "5h", resetTime: "2026-10-06T11:48:46Z", remainingFraction: 0.9501475 },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-10-10T21:08:05Z", remainingFraction: 1 },
              { bucketId: "3p-5h", window: "5h", resetTime: "2026-10-06T15:24:16Z" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        provider: "antigravity",
        windows: [
          { kind: "week", usedPercent: 16.53, resetAt: Date.parse("2026-10-10T06:57:56Z") },
          { kind: "5h", usedPercent: 4.99, resetAt: Date.parse("2026-10-06T11:48:46Z") },
        ],
      },
      {
        provider: "antigravity-3p",
        windows: [
          { kind: "week", usedPercent: 0, resetAt: Date.parse("2026-10-10T21:08:05Z") },
          { kind: "5h", usedPercent: 100, resetAt: Date.parse("2026-10-06T15:24:16Z") },
        ],
      },
    ])
  })

  test("reads the Claude 5h, 7-day, and Fable windows from oauth/usage", () => {
    expect(
      parseProbe("claude", {
        five_hour: { utilization: 34.0, resets_at: "2026-10-06T11:40:00.338870+00:00" },
        seven_day: { utilization: 61.0, resets_at: "2026-10-09T03:00:00.338891+00:00" },
        iguana_necktie: { utilization: 100.0, resets_at: "2026-11-05T07:59:00+00:00" },
        limits: [
          { kind: "weekly_all", percent: 61, resets_at: "2026-10-09T03:00:00Z", scope: null },
          { kind: "weekly_scoped", percent: 0, resets_at: "2026-10-09T03:00:00.339148+00:00", scope: { model: { display_name: "Fable" } }, is_active: false },
        ],
      }),
    ).toEqual([
      {
        provider: "claude",
        windows: [
          { kind: "5h", usedPercent: 34, resetAt: Date.parse("2026-10-06T11:40:00.338Z") },
          { kind: "week", usedPercent: 61, resetAt: Date.parse("2026-10-09T03:00:00.338Z") },
          { kind: "fable", usedPercent: 0, resetAt: Date.parse("2026-10-09T03:00:00.339Z") },
        ],
      },
    ])
  })

  test("falls back to iguana_necktie for the Claude Fable window, as the Management Center does", () => {
    expect(
      parseProbe("claude", {
        five_hour: { utilization: 10, resets_at: null },
        iguana_necktie: { utilization: 40, resets_at: "2026-10-09T03:00:00Z" },
      }),
    ).toEqual([
      {
        provider: "claude",
        windows: [
          { kind: "5h", usedPercent: 10, resetAt: undefined },
          { kind: "fable", usedPercent: 40, resetAt: Date.parse("2026-10-09T03:00:00Z") },
        ],
      },
    ])
  })

  test("returns nothing for an unknown provider or a malformed body", () => {
    expect(parseProbe("kimi", {})).toEqual([])
    expect(parseProbe("claude", {})).toEqual([])
    expect(parseProbe("codex", {})).toEqual([])
    expect(parseProbe("devin", "nope")).toEqual([])
    expect(parseProbe("antigravity", { groups: "nope" })).toEqual([])
  })
})
