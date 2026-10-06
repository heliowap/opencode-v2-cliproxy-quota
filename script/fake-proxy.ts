const now = Math.floor(Date.now() / 1000)
Bun.serve({
  port: 18317,
  fetch(request) {
    if (request.headers.get("x-management-key") !== "test-key") return Response.json({ error: "invalid management key" }, { status: 401 })
    return Response.json({
      files: [
        {
          provider: "devin",
          label: "devin-conta",
          quota: {
            signals: {
              daily_quota_remaining_percent: "75%",
              daily_quota_reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
              weekly_quota_remaining_percent: "40%",
              weekly_quota_reset_at: new Date(Date.now() + 4 * 86400_000).toISOString(),
            },
          },
        },
        {
          provider: "codex",
          label: "conta-1",
          quota: {
            observed_at: new Date().toISOString(),
            signals: {
              "X-Codex-Primary-Used-Percent": "42",
              "X-Codex-Primary-Window-Minutes": "300",
              "X-Codex-Primary-Reset-At": String(now + 9000),
              "X-Codex-Secondary-Used-Percent": "86",
              "X-Codex-Secondary-Window-Minutes": "10080",
              "X-Codex-Secondary-Reset-At": String(now + 3 * 86400),
            },
          },
        },
      ],
    })
  },
})
