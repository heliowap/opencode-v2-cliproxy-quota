export type WindowKind = "5h" | "day" | "week"

export type Window = {
  readonly kind: WindowKind
  readonly usedPercent: number
  readonly resetAt: number | undefined
}

export type Account = {
  readonly provider: string
  readonly label: string
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

const MODEL_PROVIDERS: readonly (readonly [RegExp, string])[] = [
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
    const windows = reader(stringSignals(quota.signals), observedAt ?? now)
    if (windows.length === 0) return []
    return [{ provider, label: text(file.label) || text(file.name) || provider, observedAt, windows }]
  })
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
  return KIND_ORDER.flatMap((kind) => windows.filter((item) => item.kind === kind))
    .map((item) => `${KIND_LABEL[item.kind]} ${Math.round(item.usedPercent)}%`)
    .join(" · ")
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

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined
}

function stringSignals(value: Record<string, unknown>): Signals {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
