import { parseCredentials, type Account } from "./quota.ts"

export type Settings = { readonly baseURL: string; readonly managementKey: string }

export type FetchResult = { readonly ok: true; readonly accounts: Account[] } | { readonly ok: false; readonly error: string }

const DEFAULT_URL = "http://127.0.0.1:8317"
const DEFAULT_INTERVAL_MS = 60_000
const MIN_INTERVAL_MS = 10_000

export async function fetchAccounts(settings: Settings, now: number): Promise<FetchResult> {
  if (!settings.managementKey)
    return { ok: false, error: "Set the CLIPROXY_MANAGEMENT_KEY environment variable or the managementKey plugin option" }
  const response = await fetch(`${settings.baseURL}/v8/management/credentials`, {
    headers: { "X-Management-Key": settings.managementKey },
    signal: AbortSignal.timeout(10_000),
  }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
  if (response instanceof Error) return { ok: false, error: response.message }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${errorMessage(body) ?? response.statusText}` }
  return { ok: true, accounts: parseCredentials(body, now) }
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

function stringOption(value: unknown) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function errorMessage(body: unknown) {
  if (typeof body !== "object" || body === null || !("error" in body)) return undefined
  return typeof body.error === "string" ? body.error : undefined
}
