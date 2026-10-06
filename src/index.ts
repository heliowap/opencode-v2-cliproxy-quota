import { Plugin } from "@opencode/plugin"
import { fetchOpenAIAccounts } from "./openai.ts"
import { QuotaRpc } from "./rpc.ts"

export default Plugin.define({
  id: "cliproxy.quota.server",
  async setup(context) {
    const registration = await context.rpc.register(QuotaRpc, {
      openai: async (_input, call) => {
        const connection = await context.integration.connection.active("openai").catch(() => undefined)
        if (connection?.type !== "credential" || connection.method !== "oauth") return { ok: true, accounts: [] }
        const credential = await context.integration.connection.resolve(connection).catch(() => undefined)
        if (!credential) return { ok: false, error: "Unable to resolve OpenAI OAuth connection" }
        return fetchOpenAIAccounts(connection, credential, Date.now(), undefined, call.signal)
      },
    })
    return () => registration.dispose()
  },
})
