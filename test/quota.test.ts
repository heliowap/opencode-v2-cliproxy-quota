import { describe, expect, test } from "bun:test"
import { bar, footerText, formatReset, isProxyProvider, level, parseCredentials, providerForModel, summarize } from "../src/quota.ts"

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
    expect(providerForModel("gemini-3.8-flash")).toBeUndefined()
  })
})

describe("summarize", () => {
  const accounts = [
    {
      provider: "codex",
      label: "a",
      observedAt: undefined,
      windows: [
        { kind: "5h" as const, usedPercent: 10, resetAt: 1 },
        { kind: "week" as const, usedPercent: 70, resetAt: 2 },
      ],
    },
    {
      provider: "codex",
      label: "b",
      observedAt: undefined,
      windows: [
        { kind: "5h" as const, usedPercent: 40, resetAt: 3 },
        { kind: "week" as const, usedPercent: 20, resetAt: 4 },
      ],
    },
    { provider: "claude", label: "c", observedAt: undefined, windows: [{ kind: "5h" as const, usedPercent: 99, resetAt: 5 }] },
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
  test("joins windows in a fixed order", () => {
    expect(
      footerText([
        { kind: "week", usedPercent: 18.4, resetAt: undefined },
        { kind: "5h", usedPercent: 42, resetAt: undefined },
      ]),
    ).toBe("5h 42% · wk 18%")
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
