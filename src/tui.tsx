/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, Show } from "solid-js"
import { fetchAccounts, resolveSettings, type ProbeMemory } from "./client.ts"
import { bar, footerText, formatReset, isProxyProvider, level, providerForModel, windowsForModel, type Account, type Window } from "./quota.ts"

const LABEL = { "5h": "5h", day: "day", week: "week", fable: "fable" } as const

export default Plugin.define({
  id: "cliproxy.quota",
  setup(context) {
    const settings = resolveSettings(context.options, process.env)
    const [accounts, setAccounts] = createSignal<Account[]>([])
    const [error, setError] = createSignal<string>()
    const [now, setNow] = createSignal(Date.now())
    const memory: ProbeMemory = new Map()

    const refresh = async () => {
      const result = await fetchAccounts(settings, Date.now(), memory)
      setNow(Date.now())
      if (!result.ok) return setError(result.error)
      setError(undefined)
      setAccounts(result.accounts)
    }

    const provider = createMemo(() => {
      const model = context.ui.model.current()
      if (!model) return undefined
      const info = context.data.location.provider.list(context.location)?.find((item) => item.id === model.providerID)
      if (!isProxyProvider(info ?? { id: model.providerID }, settings.baseURL, settings.providers)) return undefined
      return providerForModel(model.modelID)
    })
    const windows = createMemo(() => {
      const model = context.ui.model.current()
      return provider() && model ? windowsForModel(accounts(), model.modelID) : []
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
            <Show when={error()}>
              <text fg={context.theme.text.feedback.error.base}>{error()}</text>
            </Show>
            <For each={accounts().filter((account) => account.provider === provider())}>
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
          title: "Refresh CLIProxyAPI quota",
          group: "CLIProxyAPI",
          palette: true,
          slash: { name: "quota" },
          run: async () => {
            await refresh()
            const message = error() ?? (footerText(windows()) || "No quota data for the selected model")
            context.ui.toast.show({ title: "Quota", message, variant: error() ? "error" : "info" })
          },
        },
      ],
    }))

    void context.data.location.provider.sync(context.location)
    void refresh()
    const timer = setInterval(() => void refresh(), settings.intervalMs)
    const stop = context.data.on("session.execution.succeeded", () => void refresh())
    return () => {
      clearInterval(timer)
      stop()
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
