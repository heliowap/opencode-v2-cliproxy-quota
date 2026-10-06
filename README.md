# opencode-v2-cliproxy-quota

> [!NOTE]
> This is a community plugin. It is not built by the OpenCode team or the CLIProxyAPI team and is not affiliated with either.

Shows the quota of your [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) accounts and native OpenAI OAuth connection inside the OpenCode 2 terminal UI.

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

Native OpenAI OAuth works with the **Codex browser (legacy)** and **Codex device code (legacy)** connections in OpenCode. It reads the active account directly, without CLIProxyAPI or a management key. Some plans have only a weekly window; the plugin shows only the windows the account reports. Native quota and proxy quota stay separate, even when both serve GPT models.

The newer **Sign in with ChatGPT** token-sharing connection has no documented quota endpoint. For that connection, `/quota` and the sidebar point to [ChatGPT usage settings](https://chatgpt.com/settings/usage) instead of showing Codex quota. API-key connections show no native subscription quota.

The Claude Fable window limits only Fable models, so the footer shows it only when a Fable model is selected. The sidebar always lists it. Other providers show nothing.

Antigravity splits its quota into a Gemini group and a group for Claude and GPT-OSS models. The plugin shows the group that serves the selected model.

The footer shows the account with the most quota left for each window, because CLIProxyAPI rotates requests to accounts that still have quota.

## Install

Requires OpenCode 2. CLIProxyAPI quota additionally requires a running proxy with a management key (`remote-management.secret-key`).

```sh
opencode plugin add github:heliowap/opencode-v2-cliproxy-quota
```

For native OpenAI OAuth, connect OpenAI in OpenCode; no additional configuration is needed. Its credentials are resolved and refreshed by the OpenCode server and never sent to the terminal UI.

For CLIProxyAPI, export your management key in the shell where you start `opencode`, for example in `~/.zshrc`:

```sh
export CLIPROXY_MANAGEMENT_KEY="your-management-key"
```

Then open a new terminal and start `opencode`. A terminal UI that was already running keeps its old environment.

### Update an existing installation

OpenCode checks for GitHub plugin updates but does not install them automatically. To use newly published readers:

```sh
opencode plugin update github:heliowap/opencode-v2-cliproxy-quota
```

Then reopen the OpenCode terminal UI. Changes in a local checkout do not update a plugin installed from GitHub.

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

For native OpenAI OAuth, a server-side plugin method resolves the active OpenAI connection through OpenCode's integration API and calls ChatGPT `wham/usage`. Only quota data is returned to the terminal. The plugin refreshes when the active credential changes, as well as on the regular refresh interval and after a finished turn.

For proxy accounts, the terminal plugin calls `GET /v8/management/credentials` on CLIProxyAPI to list the accounts.

For each Claude, Codex, Devin, and Antigravity account, it then asks CLIProxyAPI's `POST /v8/management/requests/api-call` to call the upstream quota endpoint with each account's credential. These are the same requests the CLIProxyAPI Management Center makes, one per account on each refresh. Claude accounts are the exception: Anthropic rate-limits its usage endpoint, so each OpenCode window asks about a Claude account at most once every five minutes.

The plugin also reads the `quota.signals` that CLIProxyAPI recorded from the Claude and Codex rate-limit headers. Those signals change only when CLIProxyAPI serves a request, so they go stale after a manual reset, and they never include the Fable window. Each window shows whichever of the two was observed last.

If a request fails, the plugin keeps the last answer it got for that account, Fable included. It shows only the recorded signals until the first answer arrives. A window whose reset time has passed counts as renewed.

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

`bun test` reports coverage and fails below 95% of lines or functions. `bun script/check-tests.ts` fails if any test still passes when every source function returns `undefined`. CI runs the type check, the tests, and that check in parallel on every push and pull request.

`script/fake-proxy.ts` serves fake recorded quota signals on port 18317 with the key `test-key`, for testing the UI without a real proxy:

```sh
bun script/fake-proxy.ts &
CLIPROXY_URL=http://127.0.0.1:18317 CLIPROXY_MANAGEMENT_KEY=test-key opencode --standalone
```

See [CODING_STANDARDS.md](CODING_STANDARDS.md) before changing the code.

## License

MIT
