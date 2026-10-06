# Coding standards

These rules follow the [OpenCode style guide](https://github.com/anomalyco/opencode/blob/dev/AGENTS.md), adapted to this plugin.

## Architecture

- `src/quota.ts` holds every quota rule as pure functions: parsing the management API response, mapping a model to a provider, summarizing, and formatting. It does no I/O and takes `now` as an argument.
- `src/client.ts` is the only code that talks to CLIProxyAPI. It returns a `FetchResult` union instead of throwing. A live probe result replaces the recorded signals of the same credential; a failed probe falls back to them.
- `src/tui.tsx` is a thin adapter. It reads OpenCode state, calls the functions above, and renders slots. Keep logic out of it.
- `index.ts` and `tui.tsx` at the root are entry points. OpenCode resolves a local plugin directory by looking for `index` (or `server`) and `tui` files at its root, not through `package.json` `exports`.
- `src/index.ts` is an empty server plugin. OpenCode loads a package's TUI entry only when the package also has a server entry.
- Add a provider with recorded signals to `READERS`, or one that needs an upstream request through the proxy's `api-call` to `PROBES`. Add its model pattern to `MODEL_PROVIDERS`, which is ordered, so put specific patterns before general ones. Every change ships with tests.
- Windows store `usedPercent`. The UI shows `100 - usedPercent` as the quota left, matching the CLIProxyAPI Management Center.

## Style

- Prefer `const`, early returns, and no `else`.
- Prefer `flatMap`, `filter`, and `map` over loops.
- Do not alias imports or use star imports.
- Avoid `any`, `try`/`catch`, and destructuring that drops context.
- Keep one function unless a helper is reused or names a real concept.
- Comments explain a non-obvious why, such as a host quirk. Do not narrate the code.
- All user-visible text is English.

## Tests

- Write the failing test first, run it to see it fail, then implement.
- Test behavior: call the exported functions the way `src/tui.tsx` does and assert literal values with `toEqual` or `toBe`.
- Do not mock. `test/client.test.ts` runs a real `Bun.serve` server.
- `bun test` and `bun run typecheck` pass before every commit.

## End-to-end checks

Unit tests cannot see the TUI. After changing `src/tui.tsx`, check a real terminal:

1. Run `bun script/fake-proxy.ts` in the background.
2. In a temporary git repository with at least one commit, write an `opencode.jsonc` that lists this directory in `plugins`. Add a provider whose `baseURL` is `http://127.0.0.1:18317/v1` and a model ID starting with `codex/`.
3. Start `opencode --standalone` inside `tmux` with `CLIPROXY_URL=http://127.0.0.1:18317` and `CLIPROXY_MANAGEMENT_KEY=test-key`.
4. Read the screen with `tmux capture-pane -p`. The footer must show `5h 58% · wk 14% left`. After you send a message, the sidebar must list `conta-1`.
