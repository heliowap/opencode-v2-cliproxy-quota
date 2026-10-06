export type WindowKind = "5h" | "day" | "week"

export type Window = {
  readonly kind: WindowKind
  readonly usedPercent: number
  readonly resetAt: number | undefined
}

export type ApiCall = {
  readonly auth_index: string
  readonly method: "GET" | "POST"
  readonly url: string
  readonly header: Readonly<Record<string, string>>
  readonly data?: string
}

export type Account = {
  readonly provider: string
  readonly label: string
  readonly authIndex: string | undefined
  readonly observedAt: number | undefined
  readonly windows: readonly Window[]
}

type Signals = Readonly<Record<string, string>>

const KIND_ORDER: readonly WindowKind[] = ["5h", "day", "week"]

const KIND_LABEL: Record<WindowKind, string> = { "5h": "5h", day: "day", week: "wk" }

// CLIProxyAPI records passive quota signals only for these providers; each reports its windows differently.
const READERS: Record<string, (signals: Signals, base: number) => Window[]> = {
  codex: readCodex,
  claude: (signals) =>
    [
      toWindow("5h", fraction(signals["Anthropic-Ratelimit-Unified-5h-Utilization"]), unixSeconds(signals["Anthropic-Ratelimit-Unified-5h-Reset"])),
      toWindow("week", fraction(signals["Anthropic-Ratelimit-Unified-7d-Utilization"]), unixSeconds(signals["Anthropic-Ratelimit-Unified-7d-Reset"])),
    ].filter((item) => item !== undefined),
  devin: (signals) =>
    [
      toWindow("day", remaining(signals.daily_quota_remaining_percent), isoTime(signals.daily_quota_reset_at)),
      toWindow("week", remaining(signals.weekly_quota_remaining_percent), isoTime(signals.weekly_quota_reset_at)),
    ].filter((item) => item !== undefined),
}

// The plugin asks upstream through the proxy's api-call with the same requests as the CLIProxyAPI Management Center.
// CLIProxyAPI records no quota for Devin and Antigravity, and its Codex signals go stale after a manual reset.
const PROBES: Record<
  string,
  {
    readonly call: (file: Record<string, unknown>) => Omit<ApiCall, "auth_index"> | undefined
    readonly parse: (body: unknown) => { provider: string; windows: Window[] }[]
  }
> = {
  codex: {
    call: (file) => {
      const token = isRecord(file.id_token) ? file.id_token : {}
      const account = text(token.chatgpt_account_id) || text(file.chatgpt_account_id)
      return {
        method: "GET",
        url: "https://chatgpt.com/backend-api/wham/usage",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
          ...(account ? { "Chatgpt-Account-Id": account } : {}),
        },
      }
    },
    parse: (body) => {
      const limit = isRecord(body) && isRecord(body.rate_limit) ? body.rate_limit : {}
      const windows = [limit.primary_window, limit.secondary_window].flatMap((item): Window[] => {
        if (!isRecord(item)) return []
        const used = number(scalar(item.used_percent))
        if (used === undefined) return []
        const seconds = number(scalar(item.limit_window_seconds))
        return [{ kind: codexKind(seconds === undefined ? undefined : seconds / 60, 0), usedPercent: used, resetAt: unixSeconds(scalar(item.reset_at)) }]
      })
      return windows.length === 0 ? [] : [{ provider: "codex", windows }]
    },
  },
  devin: {
    call: () => ({
      method: "POST",
      url: "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      header: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      data: JSON.stringify({
        metadata: {
          ideName: "chisel",
          ideVersion: "3000.10.21",
          apiKey: "$TOKEN$",
          locale: "en",
          os: "darwin",
          extensionVersion: "3000.10.21",
          clientName: "chisel",
        },
      }),
    }),
    parse: (body) => {
      const windows = readDevinStatus(body)
      return windows.length === 0 ? [] : [{ provider: "devin", windows }]
    },
  },
  antigravity: {
    call: (file) => {
      const project = text(file.project_id)
      if (!project) return undefined
      return {
        method: "POST",
        url: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
        },
        data: JSON.stringify({ project }),
      }
    },
    parse: (body) => {
      if (!isRecord(body) || !Array.isArray(body.groups)) return []
      return body.groups.flatMap((group) => {
        if (!isRecord(group) || !Array.isArray(group.buckets)) return []
        const windows = group.buckets.flatMap(readAntigravityBucket)
        if (windows.length === 0) return []
        const gemini = group.buckets.some((bucket) => isRecord(bucket) && text(bucket.bucketId)?.startsWith("gemini-"))
        return [{ provider: gemini ? "antigravity" : "antigravity-3p", windows }]
      })
    },
  },
}

const MODEL_PROVIDERS: readonly (readonly [RegExp, string])[] = [
  [/^(ag-claude-|ag-gpt-oss|gpt-oss)/, "antigravity-3p"],
  [/^(ag-|gemini-)/, "antigravity"],
  [/^(codex-|gpt-|o\d)/, "codex"],
  [/^claude-/, "claude"],
  [/^(devin-|swe-)/, "devin"],
]

export function parseCredentials(body: unknown, now: number): Account[] {
  if (!isRecord(body) || !Array.isArray(body.files)) return []
  return body.files.flatMap((file) => {
    if (!isRecord(file) || file.disabled === true) return []
    const provider = text(file.provider)?.toLowerCase() ?? ""
    const reader = READERS[provider]
    const quota = isRecord(file.quota) ? file.quota : undefined
    if (!reader || !quota || !isRecord(quota.signals)) return []
    const observedAt = isoTime(quota.observed_at)
    const windows = reader(stringSignals(quota.signals), observedAt ?? now).map((item) =>
      item.resetAt !== undefined && item.resetAt <= now ? { kind: item.kind, usedPercent: 0, resetAt: undefined } : item,
    )
    if (windows.length === 0) return []
    return [{ provider, label: text(file.label) || text(file.name) || provider, authIndex: text(file.auth_index), observedAt, windows }]
  })
}

export function probeTargets(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.files)) return []
  return body.files.flatMap((file) => {
    if (!isRecord(file) || file.disabled === true) return []
    const provider = text(file.provider)?.toLowerCase() ?? ""
    const authIndex = text(file.auth_index)
    const call = PROBES[provider]?.call(file)
    if (!authIndex || !call) return []
    return [{ provider, label: text(file.label) || text(file.name) || provider, authIndex, call: { auth_index: authIndex, ...call } }]
  })
}

export function parseProbe(provider: string, body: unknown) {
  return PROBES[provider]?.parse(body) ?? []
}

export function providerForModel(modelID: string) {
  const id = modelID.toLowerCase().replace(/^cpa-/, "")
  const prefix = id.split("/")[0]
  if (id.includes("/") && prefix && prefix in READERS) return prefix
  return MODEL_PROVIDERS.find((entry) => entry[0].test(id))?.[1]
}

export function isProxyProvider(
  provider: { readonly id: string; readonly settings?: Readonly<Record<string, unknown>> },
  proxyURL: string,
  explicit: readonly string[],
) {
  if (explicit.includes(provider.id)) return true
  const baseURL = provider.settings?.baseURL
  if (typeof baseURL !== "string" || !URL.canParse(baseURL) || !URL.canParse(proxyURL)) return false
  const target = new URL(baseURL)
  const proxy = new URL(proxyURL)
  return target.port === proxy.port && loopback(target.hostname) === loopback(proxy.hostname)
}

export function summarize(accounts: readonly Account[], provider: string) {
  const windows = accounts.filter((account) => account.provider === provider).flatMap((account) => account.windows)
  return KIND_ORDER.flatMap((kind) => {
    const best = windows
      .filter((item) => item.kind === kind)
      .reduce<Window | undefined>((min, item) => (min && min.usedPercent <= item.usedPercent ? min : item), undefined)
    return best ? [best] : []
  })
}

export function footerText(windows: readonly Window[]) {
  const parts = KIND_ORDER.flatMap((kind) => windows.filter((item) => item.kind === kind)).map(
    (item) => `${KIND_LABEL[item.kind]} ${Math.round(100 - item.usedPercent)}%`,
  )
  return parts.length === 0 ? "" : `${parts.join(" · ")} left`
}

export function formatReset(resetAt: number | undefined, now: number) {
  if (resetAt === undefined) return ""
  const minutes = Math.floor((resetAt - now) / 60_000)
  if (resetAt <= now) return "reset due"
  if (minutes < 1) return "in <1m"
  if (minutes < 60) return `in ${minutes}m`
  if (minutes < 24 * 60) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
}

export function level(usedPercent: number) {
  if (usedPercent >= 95) return "error"
  if (usedPercent >= 80) return "warning"
  return "ok"
}

export function bar(usedPercent: number) {
  const filled = Math.min(10, Math.max(0, Math.round(usedPercent / 10)))
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

function readDevinStatus(body: unknown): Window[] {
  const status = isRecord(body) && isRecord(body.userStatus) ? body.userStatus.planStatus : undefined
  if (!isRecord(status)) return []
  return (
    [
      ["day", status.dailyQuotaRemainingPercent, status.dailyQuotaResetAtUnix],
      ["week", status.weeklyQuotaRemainingPercent, status.weeklyQuotaResetAtUnix],
    ] as const
  ).flatMap((entry) => {
    const resetAt = unixSeconds(scalar(entry[2]))
    // Protobuf JSON omits zero values, so a window with a reset time but no percent has none left.
    const remainingPercent = number(scalar(entry[1])) ?? (resetAt === undefined ? undefined : 0)
    if (remainingPercent === undefined) return []
    return [{ kind: entry[0], usedPercent: 100 - remainingPercent, resetAt }]
  })
}

function readAntigravityBucket(bucket: unknown): Window[] {
  if (!isRecord(bucket)) return []
  const kind = bucket.window === "5h" ? "5h" : bucket.window === "weekly" ? "week" : undefined
  if (!kind) return []
  // Protobuf JSON omits zero values, so a bucket without remainingFraction has none left.
  const remainingFraction = number(scalar(bucket.remainingFraction)) ?? 0
  return [{ kind, usedPercent: Math.round((1 - remainingFraction) * 10_000) / 100, resetAt: isoTime(bucket.resetTime) }]
}

function loopback(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "loopback" : hostname
}

function readCodex(signals: Signals, base: number) {
  const slots = (["Primary", "Secondary"] as const).flatMap((slot, index) => {
    const used = number(signals[`X-Codex-${slot}-Used-Percent`])
    if (used === undefined) return []
    const minutes = number(signals[`X-Codex-${slot}-Window-Minutes`])
    const after = number(signals[`X-Codex-${slot}-Reset-After-Seconds`])
    return [
      {
        kind: codexKind(minutes, index),
        usedPercent: used,
        resetAt: unixSeconds(signals[`X-Codex-${slot}-Reset-At`]) ?? (after === undefined ? undefined : base + after * 1000),
      },
    ]
  })
  return slots.filter((item, index) => slots.findIndex((other) => other.kind === item.kind) === index)
}

function codexKind(minutes: number | undefined, index: number): WindowKind {
  if (minutes === undefined) return index === 0 ? "5h" : "week"
  if (minutes <= 300) return "5h"
  if (minutes <= 1440) return "day"
  return "week"
}

function toWindow(kind: WindowKind, usedPercent: number | undefined, resetAt: number | undefined) {
  if (usedPercent === undefined) return undefined
  return { kind, usedPercent, resetAt }
}

function fraction(value: string | undefined) {
  const parsed = number(value)
  return parsed === undefined ? undefined : Math.round(parsed * 10_000) / 100
}

function remaining(value: string | undefined) {
  const parsed = number(value?.replace("%", ""))
  return parsed === undefined ? undefined : 100 - parsed
}

function unixSeconds(value: string | undefined) {
  const parsed = number(value)
  return parsed === undefined ? undefined : parsed * 1000
}

function isoTime(value: unknown) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

function number(value: string | undefined) {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function scalar(value: unknown) {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined
}

function stringSignals(value: Record<string, unknown>): Signals {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
