import type { FetchResult } from "./client.ts"
import { codexUsageCall, mergeAccounts, parseProbe } from "./quota.ts"

type Credential = {
  readonly type: string
  readonly methodID?: string
  readonly access?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export async function fetchOpenAIAccounts(
  connection: { readonly id: string; readonly label: string } | undefined,
  credential: Credential | undefined,
  now: number,
  usageURL?: string,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (!connection || credential?.type !== "oauth") return { ok: true, accounts: [] }
  // SIWC grants target the public API, not Codex's backend; OpenAI documents usage settings instead of a quota API.
  if (credential.methodID === "chatgpt-token-sharing")
    return { ok: false, error: "Manage ChatGPT token sharing usage at https://chatgpt.com/settings/usage" }
  if (!credential.access || !["chatgpt-browser", "chatgpt-headless"].includes(credential.methodID ?? "")) return { ok: true, accounts: [] }
  const account = credential.metadata?.accountID
  const call = codexUsageCall(typeof account === "string" ? account : undefined)
  const response = await fetch(usageURL ?? call.url, {
    method: call.method,
    headers: { ...call.header, Authorization: `Bearer ${credential.access}` },
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
  }).catch(() => undefined)
  if (!response) return { ok: false, error: "Unable to fetch OpenAI quota" }
  if (!response.ok) return { ok: false, error: `OpenAI quota: HTTP ${response.status}` }
  const body: unknown = await response.json().catch(() => undefined)
  const accounts = parseProbe("codex", body).map((result) => ({
    ...result,
    label: connection.label,
    authIndex: `openai:${connection.id}`,
    observedAt: now,
  }))
  if (accounts.length === 0) return { ok: false, error: "OpenAI returned no quota data" }
  return { ok: true, accounts: mergeAccounts([], accounts, now) }
}
