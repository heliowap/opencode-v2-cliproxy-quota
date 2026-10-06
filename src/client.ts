import { mergeAccounts, parseCredentials, parseProbe, probeTargets, type Account } from "./quota.ts"

export type Settings = { readonly baseURL: string; readonly managementKey: string }

export type FetchResult = { readonly ok: true; readonly accounts: Account[] } | { readonly ok: false; readonly error: string }

export type ProbeMemory = Map<string, { readonly attemptedAt: number; readonly live: readonly Account[] }>

const DEFAULT_URL = "http://127.0.0.1:8317"
const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 10_000

// Anthropic allows a few oauth/usage requests per token every few minutes and answers 429 with Retry-After: 0.
const PROBE_INTERVAL_MS: Readonly<Record<string, number>> = { claude: 300_000 }

export async function fetchAccounts(settings: Settings, now: number, memory: ProbeMemory = new Map()): Promise<FetchResult> {
  if (!settings.managementKey)
    return { ok: false, error: "Set the CLIPROXY_MANAGEMENT_KEY environment variable or the managementKey plugin option" }
  const response = await management(settings, "/v8/management/credentials")
  if (!response.ok) return response
  const live = (
    await Promise.all(
      probeTargets(response.body).map(async (target) => {
        const previous = memory.get(target.authIndex)
        if (previous && now - previous.attemptedAt < (PROBE_INTERVAL_MS[target.provider] ?? 0)) return previous.live
        memory.set(target.authIndex, { attemptedAt: now, live: previous?.live ?? [] })
        const probe = await management(settings, "/v8/management/requests/api-call", target.call)
        const results = probe.ok ? parseProbe(target.provider, await upstreamBody(probe.body)) : []
        if (results.length === 0) return previous?.live ?? []
        const accounts = results.map((result) => ({
          provider: result.provider,
          label: target.label,
          authIndex: target.authIndex,
          observedAt: now,
          windows: result.windows,
        }))
        memory.set(target.authIndex, { attemptedAt: now, live: accounts })
        return accounts
      }),
    )
  ).flat()
  return { ok: true, accounts: mergeAccounts(parseCredentials(response.body, now), live, now) }
}

export function resolveSettings(
  options: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
) {
  const seconds = typeof options.intervalSeconds === "number" ? options.intervalSeconds : undefined
  return {
    baseURL: (stringOption(options.baseURL) ?? env.CLIPROXY_URL ?? DEFAULT_URL).replace(/\/+$/, ""),
    managementKey: stringOption(options.managementKey) ?? env.CLIPROXY_MANAGEMENT_KEY ?? "",
    intervalMs: seconds === undefined ? DEFAULT_INTERVAL_MS : Math.max(MIN_INTERVAL_MS, seconds * 1000),
    providers: Array.isArray(options.providers)
      ? options.providers.filter((item): item is string => typeof item === "string")
      : [],
  }
}

async function management(settings: Settings, path: string, body?: object) {
  const response = await fetch(`${settings.baseURL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Management-Key": settings.managementKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error) return { ok: false as const, error: response.message }
  const json: unknown = await response.json().catch(() => undefined)
  if (!response.ok) return { ok: false as const, error: `HTTP ${response.status}: ${errorMessage(json) ?? response.statusText}` }
  return { ok: true as const, body: json }
}

async function upstreamBody(value: unknown): Promise<unknown> {
  if (typeof value !== "object" || value === null || !("status_code" in value) || !("body" in value)) return undefined
  if (value.status_code !== 200 || typeof value.body !== "string") return undefined
  return new Response(value.body).json().catch(() => undefined)
}

function stringOption(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function errorMessage(body: unknown) {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined
  return typeof body.error === "string" ? body.error : undefined
}
