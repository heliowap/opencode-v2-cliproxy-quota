import { Plugin } from "@opencode/plugin"

// OpenCode 2.0.24 skips a configured plugin directory that has no server entry, so its TUI entry never loads.
export default Plugin.define({
  id: "cliproxy.quota.server",
  setup() {},
})
