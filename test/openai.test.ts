import { afterAll, describe, expect, test } from "bun:test"
import { fetchOpenAIAccounts } from "../src/openai.ts"

const seen: { authorization: string | null; account: string | null }[] = []
const server = Bun.serve({
  port: 0,
  fetch(request) {
    seen.push({ authorization: request.headers.get("authorization"), account: request.headers.get("chatgpt-account-id") })
    const path = new URL(request.url).pathname
    if (path === "/rejected") return Response.json({ error: "expired" }, { status: 401 })
    if (path === "/html") return new Response("<html>login</html>")
    if (path === "/empty") return Response.json({ rate_limit: null })
    if (path === "/weekly")
      return Response.json({ rate_limit: { primary_window: { used_percent: 29, limit_window_seconds: 604800, reset_at: 1791589256 }, secondary_window: null } })
    return Response.json({
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1791298800 },
        secondary_window: { used_percent: 86, limit_window_seconds: 604800, reset_at: 1791589256 },
      },
    })
  },
})

afterAll(() => server.stop(true))

const connection = { id: "native-1", label: "ChatGPT Pro" }
const credential = { type: "oauth" as const, methodID: "chatgpt-browser", access: "native-token", metadata: { accountID: "acct-native" } }
const now = 1791288000_000

describe("fetchOpenAIAccounts", () => {
  test("reads native OAuth quota with the resolved token and account, without a proxy key", async () => {
    expect(await fetchOpenAIAccounts(connection, credential, now, server.url.href)).toEqual({
      ok: true,
      accounts: [{
        provider: "codex",
        label: "ChatGPT Pro",
        authIndex: "openai:native-1",
        observedAt: 1791288000_000,
        windows: [
          { kind: "5h", usedPercent: 42, resetAt: 1791298800_000 },
          { kind: "week", usedPercent: 86, resetAt: 1791589256_000 },
        ],
      }],
    })
    expect(seen.at(-1)).toEqual({ authorization: "Bearer native-token", account: "acct-native" })
  })

  test("reads a weekly-only native plan without inventing a five-hour allowance", async () => {
    expect(await fetchOpenAIAccounts(connection, { ...credential, methodID: "chatgpt-headless", metadata: {} }, now, `${server.url.origin}/weekly`)).toEqual({
      ok: true,
      accounts: [{ provider: "codex", label: "ChatGPT Pro", authIndex: "openai:native-1", observedAt: 1791288000_000,
        windows: [{ kind: "week", usedPercent: 29, resetAt: 1791589256_000 }] }],
    })
    expect(seen.at(-1)).toEqual({ authorization: "Bearer native-token", account: null })
  })

  test("does not send API keys, disconnected credentials, or token-sharing grants to Codex", async () => {
    const before = seen.length
    expect(await fetchOpenAIAccounts(connection, { ...credential, methodID: "chatgpt-token-sharing" }, now, server.url.href)).toEqual({
      ok: false, error: "Manage ChatGPT token sharing usage at https://chatgpt.com/settings/usage",
    })
    expect(await fetchOpenAIAccounts(connection, { type: "key" }, now, server.url.href)).toEqual({ ok: true, accounts: [] })
    expect(await fetchOpenAIAccounts(connection, undefined, now, server.url.href)).toEqual({ ok: true, accounts: [] })
    expect(await fetchOpenAIAccounts(undefined, credential, now, server.url.href)).toEqual({ ok: true, accounts: [] })
    expect(seen.length).toBe(before)
  })

  test("reports failed or malformed upstream answers instead of keeping another account's quota", async () => {
    expect(await fetchOpenAIAccounts(connection, credential, now, `${server.url.origin}/rejected`)).toEqual({ ok: false, error: "OpenAI quota: HTTP 401" })
    expect(await fetchOpenAIAccounts(connection, credential, now, `${server.url.origin}/html`)).toEqual({ ok: false, error: "OpenAI returned no quota data" })
    expect(await fetchOpenAIAccounts(connection, credential, now, `${server.url.origin}/empty`)).toEqual({ ok: false, error: "OpenAI returned no quota data" })
  })

  test("returns a safe error for unreachable or cancelled upstream requests", async () => {
    expect(await fetchOpenAIAccounts(connection, credential, now, "http://127.0.0.1:1")).toEqual({ ok: false, error: "Unable to fetch OpenAI quota" })
    expect(await fetchOpenAIAccounts(connection, credential, now, server.url.href, AbortSignal.abort())).toEqual({ ok: false, error: "Unable to fetch OpenAI quota" })
  })
})
