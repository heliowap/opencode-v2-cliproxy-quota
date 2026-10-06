# opencode-v2-cliproxy-quota

> [!NOTE]
> This is a community plugin. It is not built by the OpenCode team or the CLIProxyAPI team and is not affiliated with either.

Shows the quota of your [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) accounts inside the OpenCode 2 terminal UI.

- The prompt footer shows how much quota is left for the selected model, such as `5h 58% · wk 82% left`.
- The session sidebar lists every account for that provider, with a bar of the remaining quota and the time until each window resets.
- `/quota` refreshes the data now and shows the summary as a toast.

Percentages are the quota left, as in the CLIProxyAPI Management Center. A window turns yellow below 20% left and red below 5% left.

## Supported providers

| Provider | Windows | Source |
| --- | --- | --- |
| Codex | 5 hours and weekly | ChatGPT `wham/usage` |
| Claude | 5 hours, 7 days, and 7-day Fable | Anthropic `api/oauth/usage` |
| Devin | daily and weekly | Codeium `GetUserStatus` |
| Antigravity | 5 hours and weekly, per model group | Google `retrieveUserQuotaSummary` |

The Claude Fable window limits only Fable models, so the footer shows it only when a Fable model is selected. The sidebar always lists it. Other providers show nothing.

Antigravity splits its quota into a Gemini group and a group for Claude and GPT-OSS models. The plugin shows the group that serves the selected model.

The footer shows the account with the most quota left for each window, because CLIProxyAPI rotates requests to accounts that still have quota.

## Install

Requires OpenCode 2 and a running CLIProxyAPI with a management key (`remote-management.secret-key`).

```sh
opencode plugin add github:heliowap/opencode-v2-cliproxy-quota
```

The plugin runs inside the terminal UI, not the background service. Export your management key in the shell where you start `opencode`, for example in `~/.zshrc`:

```sh
export CLIPROXY_MANAGEMENT_KEY="your-management-key"
```

Then open a new terminal and start `opencode`. A terminal UI that was already running keeps its old environment.

## Configure

The plugin reads these settings, in order: plugin options, then environment variables, then defaults.

| Option | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `baseURL` | `CLIPROXY_URL` | `http://127.0.0.1:8317` | CLIProxyAPI address, without `/v1`. |
| `managementKey` | `CLIPROXY_MANAGEMENT_KEY` | none | Management key. Required. |
| `intervalSeconds` | none | `60` | Refresh interval. The minimum is 10. |
| `providers` | none | `[]` | OpenCode provider IDs to treat as CLIProxyAPI. |

The plugin also refreshes after every finished turn.

You usually do not need `providers`. The plugin treats any OpenCode provider whose `settings.baseURL` points at the same host and port as `baseURL` as CLIProxyAPI. List provider IDs only when the proxy sits behind another address.

Pass options with the object form in `opencode.jsonc`. Prefer the environment variable for the key so it stays out of the config file.

```jsonc
{
  "plugins": [
    {
      "package": "github:heliowap/opencode-v2-cliproxy-quota",
      "options": { "baseURL": "http://127.0.0.1:8317", "intervalSeconds": 30 }
    }
  ]
}
```

## How it works

The plugin calls `GET /v8/management/credentials` on CLIProxyAPI to list the accounts.

For each Claude, Codex, Devin, and Antigravity account, it then asks CLIProxyAPI's `POST /v8/management/requests/api-call` to call the upstream quota endpoint with each account's credential. These are the same requests the CLIProxyAPI Management Center makes, one per account on each refresh.

If a request fails, the plugin falls back to the `quota.signals` that CLIProxyAPI recorded from the Claude and Codex rate-limit headers. Those signals change only when CLIProxyAPI serves a request, so they go stale after a manual reset, and they never include the Fable window. A recorded window whose reset time has passed counts as renewed.

To pick the provider for the selected model, the plugin strips a `cpa-` prefix from the model ID and matches the rest in this order:

| Model ID | Provider |
| --- | --- |
| `ag-claude-`, `ag-gpt-oss`, `gpt-oss` | Antigravity, Claude and GPT group |
| `ag-`, `gemini-` | Antigravity, Gemini group |
| `codex-`, `gpt-`, `o<digit>` | Codex |
| `claude-` | Claude |
| `devin-`, `swe-` | Devin |

A `codex/`, `claude/`, or `devin/` prefix also works.

## Development

```sh
bun install
bun test
bun run typecheck
```

`script/fake-proxy.ts` serves fake recorded quota signals on port 18317 with the key `test-key`, for testing the UI without a real proxy:

```sh
bun script/fake-proxy.ts &
CLIPROXY_URL=http://127.0.0.1:18317 CLIPROXY_MANAGEMENT_KEY=test-key opencode --standalone
```

See [CODING_STANDARDS.md](CODING_STANDARDS.md) before changing the code.

## License

MIT
