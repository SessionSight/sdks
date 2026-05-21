# SessionSight for Claude Code

Drive SessionSight from inside your editor. Track conversion goals, run split tests, manage feature flags, query analytics — and wire any of it directly into your code — without leaving Claude Code.

## What it does

The plugin pairs Claude Code to your SessionSight account once via OAuth, then exposes ~170 tools over MCP. Ask in natural language:

```
/sessionsight:ai what are my goals?
/sessionsight:ai invite jane@example.com to the marketing team
/sessionsight:ai create a split test for the new pricing page
/sessionsight:ai what's my conversion this week?
/sessionsight:ai create a goal for revenue and wire it into checkout
```

When you ask Claude to wire a goal, split test, or feature flag into your code, the response includes the SDK install command, the init snippet, and the call-site snippet — Claude drops them in for you at the right place.

## Install

Two commands. Authentication happens on your first tool call.

```bash
/plugin marketplace add SessionSight/sdks
/plugin install sessionsight@sessionsight-sdks
```

Then ask the agent anything that needs SessionSight, e.g.:

```
/sessionsight:ai what are my goals?
```

The first time, your browser opens to the SessionSight consent screen. Pick the company you're pairing for, optionally narrow to specific properties, click Authorize. The bearer is cached at `~/.config/sessionsight/auth.json` (mode 0600). Every subsequent session reuses it without prompting.

If you're not signed in to the dashboard yet, the authorize page asks you to sign in in another tab and re-trigger the agent's request once.

## Property scope

When you authorize the plugin, you choose which properties it can touch. Defaults to "any property in this company" so every-day flows just work. Pick "specific properties only" to lock the install to a frozen subset. Re-pair from `/<companyId>/account/authorized-clients` in the dashboard to widen, narrow, or revoke.

## What it can't do

DELETE operations are not supported over MCP — the API rejects them at the credential layer. To delete data (goals, campaigns, properties, etc.), use the dashboard.

## Privacy + security

- Every action is attributed in your audit log with `source: "mcp"`, the tool name, and the client identifier.
- The plugin never reads or returns secret API keys. Server SDKs' secrets are only retrievable from the dashboard's API Keys page.
- The pair is bound to your company + property selection from consent. A pair scoped to "marketing-site" can never query "production-app" even if your team has access to both.
- Revoke at any time from `/account/authorized-clients`. Existing tokens die immediately.

## SDKs (for direct integration without the agent)

The agent picks the right SDK and drops the install for you, but you can also wire them by hand:

**Client-side** (use your public API key, `sessionsight_pub_...`)

- `@sessionsight/insights` — session replay, heatmaps, form analytics
- `@sessionsight/split-testing` — A/B testing, copy testing, JSON experiments

**Server-side** (use your secret API key, `sessionsight_sec_...`)

- `@sessionsight/goals` — goal and revenue tracking
- `@sessionsight/flags` — feature flags with segment targeting
- `@sessionsight/feedback` — bug reports, ratings, sentiment collection

## Troubleshooting

**`/sessionsight:ai ...` fails with "MCP token doesn't have analytics:read scope"**

The bearer was minted before the consent-time scope augmentation landed. Re-pair: delete `~/.config/sessionsight/auth.json` and run any `/sessionsight:ai` command — the next call walks back through consent.

**Browser opens to "Log in to SessionSight before continuing"**

You're not signed in to the dashboard. Open `https://sessionsight.com` in another tab, sign in, then re-trigger the agent's pair command.

**Tool calls fail with "session expired" or 404**

The upstream MCP session expired (one-hour TTL). Run any `/sessionsight:ai` command again — the shim re-initializes automatically.

## Support

- Issues / feature requests: https://github.com/SessionSight/sdks/issues
- Email: support@sessionsight.com
- Docs: https://sessionsight.com/docs

---

## For plugin developers

### Test locally

```bash
claude --plugin-dir ./packages/claude-code-plugin
claude plugin validate ./packages/claude-code-plugin
```

### Submit / update

There's no CLI publish command. Submit through:

- **Claude.ai users:** https://claude.ai/settings/plugins/submit
- **Console users:** https://platform.claude.com/plugins/submit

Provide the GitHub repository URL. Anthropic reviews. Once approved, bump `version` in `.claude-plugin/plugin.json` and push — updates auto-sync; users see "Update available" in `/plugin`.
