# opencode-v2-cliproxy-quota

> [!NOTE]
> This is a community plugin. It is not built by the OpenCode team or the CLIProxyAPI team and is not affiliated with either.

Shows the quota of your [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) accounts inside the OpenCode 2 terminal UI.

- The prompt footer shows a short summary for the selected model, such as `5h 42% · wk 18%`.
- The session sidebar lists every account for that provider, with a usage bar and the time until each window resets.
- `/quota` refreshes the data now and shows the summary as a toast.

Usage turns yellow at 80% and red at 95%.

## Supported providers

CLIProxyAPI records quota windows from upstream responses for three providers:

| Provider | Windows |
| --- | --- |
| Codex | 5 hours and weekly |
| Claude | 5 hours and 7 days |
| Devin | daily and weekly |

Other providers, such as Antigravity and Gemini, show nothing. CLIProxyAPI only fills these values after it has served at least one request with that account.

The footer shows the least-used account for each window, because CLIProxyAPI rotates requests to accounts that still have quota.

## Install

Requires OpenCode 2 and a running CLIProxyAPI with a management key (`remote-management.secret-key`).

```sh
opencode plugin add github:heliowap/opencode-v2-cliproxy-quota
```

Then give the plugin your management key through the environment of the OpenCode process:

```sh
export CLIPROXY_MANAGEMENT_KEY="your-management-key"
```

Restart the service with `opencode service restart` if the footer stays empty.

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

The plugin calls `GET /v8/management/credentials` on CLIProxyAPI and reads each credential's `quota.signals`. CLIProxyAPI fills those signals from the rate-limit headers that Codex and Claude send, and from the Devin account status. The plugin does not call any upstream provider.

To pick the provider for the selected model, the plugin strips a `cpa-` prefix from the model ID. It then matches `gpt-`, `codex-`, and `o<digit>` to Codex, `claude-` to Claude, and `devin-` or `swe-` to Devin. A `codex/`, `claude/`, or `devin/` prefix also works.

## Development

```sh
bun install
bun test
bun run typecheck
```

`script/fake-proxy.ts` serves fake Codex and Devin quota data on port 18317 with the key `test-key`, for testing the UI without a real proxy:

```sh
bun script/fake-proxy.ts &
CLIPROXY_URL=http://127.0.0.1:18317 CLIPROXY_MANAGEMENT_KEY=test-key opencode --standalone
```

See [CODING_STANDARDS.md](CODING_STANDARDS.md) before changing the code.

## License

MIT
