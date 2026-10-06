/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, Show } from "solid-js"
import { fetchAccounts, resolveSettings, type FetchResult, type ProbeMemory } from "./client.ts"
import { bar, footerText, formatReset, level, providerForModel, quotaSource, windowsForModel, type Account, type Window } from "./quota.ts"
import { QuotaRpc } from "./rpc.ts"

const LABEL = { "5h": "5h", day: "day", week: "week", fable: "fable" } as const

export default Plugin.define({
  id: "cliproxy.quota",
  setup(context) {
    const settings = resolveSettings(context.options, process.env)
    const rpc = context.client.rpc(QuotaRpc)
    const [proxyAccounts, setProxyAccounts] = createSignal<Account[]>([])
    const [proxyError, setProxyError] = createSignal<string>()
    const [openai, setOpenAI] = createSignal<FetchResult>({ ok: true, accounts: [] })
    const [now, setNow] = createSignal(Date.now())
    const memory: ProbeMemory = new Map()
    let revision = 0

    const refresh = async () => {
      const current = ++revision
      await Promise.all([
        fetchAccounts(settings, Date.now(), memory).then((result) => {
          if (!result.ok) return setProxyError(result.error)
          setProxyError(undefined)
          setProxyAccounts(result.accounts)
        }),
        rpc.openai({}, { location: context.location })
          .catch(() => ({ ok: false, error: "Unable to read OpenAI quota from the OpenCode server" }))
          .then((result) => {
            if (current !== revision) return
            setOpenAI(result as FetchResult)
          }),
      ])
      setNow(Date.now())
    }

    const source = createMemo(() => {
      const model = context.ui.model.current()
      if (!model) return undefined
      const info = context.data.location.provider.list(context.location)?.find((item) => item.id === model.providerID)
      return quotaSource(info ?? { id: model.providerID }, settings)
    })
    const quota = createMemo(() => {
      if (source() !== "openai") return { accounts: proxyAccounts(), error: proxyError() }
      const current = openai()
      if (!current.ok) return { accounts: [], error: current.error }
      return { accounts: current.accounts, error: undefined }
    })
    const provider = createMemo(() => {
      const model = context.ui.model.current()
      if (source() === "openai") return quota().accounts.length > 0 || quota().error ? "codex" : undefined
      return source() && model ? providerForModel(model.modelID) : undefined
    })
    const windows = createMemo(() => {
      const model = context.ui.model.current()
      return provider() && model ? windowsForModel(quota().accounts, model.modelID) : []
    })

    context.ui.slot({
      append: "prompt.footer.status",
      render: () => (
        <Show when={windows().length > 0}>
          <box flexShrink={0}>
            <text fg={color(context, Math.max(...windows().map((item) => item.usedPercent)))}>{footerText(windows())}</text>
          </box>
        </Show>
      ),
    })

    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={provider()}>
          <box flexDirection="column">
            <text fg={context.theme.text.base}>
              <b>Quota</b>
            </text>
            <Show when={quota().error}>
              <text fg={context.theme.text.feedback.error.base}>{quota().error}</text>
            </Show>
            <For each={quota().accounts.filter((account) => account.provider === provider())}>
              {(account) => (
                <box flexDirection="column">
                  <text fg={context.theme.text.muted}>{account.label}</text>
                  <For each={account.windows}>{(item) => <WindowRow context={context} item={item} now={now()} />}</For>
                </box>
              )}
            </For>
          </box>
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "cliproxy.quota.refresh",
          title: "Refresh quota",
          group: "Quota",
          palette: true,
          slash: { name: "quota" },
          run: async () => {
            await refresh()
            const message = quota().error ?? (footerText(windows()) || "No quota data for the selected model")
            context.ui.toast.show({ title: "Quota", message, variant: quota().error ? "error" : "info" })
          },
        },
      ],
    }))

    void context.data.location.provider.sync(context.location)
    void refresh()
    const timer = setInterval(() => void refresh(), settings.intervalMs)
    const stop = context.data.on("session.execution.succeeded", () => void refresh())
    const stopCredential = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID !== "openai") return
      setOpenAI({ ok: true, accounts: [] })
      void refresh()
    })
    return () => {
      revision++
      clearInterval(timer)
      stop()
      stopCredential()
    }
  },
})

function WindowRow(props: { context: Context; item: Window; now: number }) {
  return (
    <text fg={color(props.context, props.item.usedPercent)}>
      {`${LABEL[props.item.kind].padEnd(6)}${bar(100 - props.item.usedPercent)} ${String(Math.round(100 - props.item.usedPercent)).padStart(3)}% left ${formatReset(props.item.resetAt, props.now)}`}
    </text>
  )
}

function color(context: Context, usedPercent: number) {
  const current = level(usedPercent)
  if (current === "ok") return context.theme.text.muted
  return context.theme.text.feedback[current].base
}
