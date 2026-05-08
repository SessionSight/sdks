---
description: Drive SessionSight from inside your editor. Track conversion goals, run split tests, invite teammates, query analytics, and wire any of it into your code without leaving Claude Code.
---

You can drive the user's SessionSight account directly via the SessionSight MCP server (registered alongside this plugin). Treat the user's request as a natural-language instruction and pick the right MCP tool.

Guidelines:

- **Confirm before any write.** Before calling any tool that mutates state (`create_*`, `update_*`, `start_*`, `stop_*`, `pause_*`, `complete_*`, `restore_*`, `restart_*`, `relaunch_*`, `launch_*`, `install_*`), restate what you're about to do (entity name, target property, key parameters) in one sentence and ask the user to confirm. Reads can run without confirmation. Deletes aren't supported via this server — point delete requests at the dashboard.
- **Don't bundle SDKs the user didn't ask for.** Insights is the install; everything else is opt-in based on a stated need. For non-JavaScript backends, the REST API docs at `https://sessionsight.com/docs/build/api-reference/authentication` replace any SDK install path.
- **Show the integration hint as code.** When a write tool returns an `integration` block, drop the SDK call into the right place in the user's repo and explain in one line what changed. Do not paste the snippet without placing it.
- **Property scope is set at pair time.** If a tool fails with a property-scope error, the user authorized this client for a narrower set of properties than the one you targeted. Tell them they can re-pair from `/account/authorized-clients` to widen scope, do not retry against a different property without their direction.
- **Run reads concurrently.** Multiple independent read calls (`list_*`, `get_*`) can be issued in one turn. Don't serialize when you don't have to.

## Setting up the SDKs

When the user asks to install, set up, wire up, or "add SessionSight" to this repo, treat it as a guided flow, not a tool dump. Open with a one-line statement of intent in your own words — signal that you'll go question-by-question and end with sessions visible in the dashboard. Drive one question at a time. Verify before declaring done.

1. **Start with `get_sdk_setup_guide`.** Single source of truth for install commands, snippets, consent options, and goal setup. Read every block in the response before pasting anything; the response's own `nextSteps` is the script.
2. **Bake in real values.** If the response carries `YOUR_PROPERTY_ID` or `YOUR_PUBLIC_KEY` placeholders: call `list_properties`, ask which property this repo maps to (one question, not a list of options), then re-call `get_sdk_setup_guide` with `propertyId`. If the response says no public API key exists, confirm with the user, call `create_public_api_key`, then re-call. Never paste a snippet with a placeholder still in it.
3. **Honor the response blocks before pasting:**
   - `goals.setupFlow` non-null means this is a fresh property. Ask one short question to pick the goal type (typically: paid flow vs. signup), phrased in your own words, then call `create_goal` and use the returned ID in the insights `usageSnippet`. Don't paste the snippet first and patch the goal ID later.
   - `consent` block: if the user runs a cookie banner or operates under GDPR/CCPA (ask if unclear), substitute the chosen strategy (`deferred`, `reactive`, or `googleConsentMode`) into the insights `initSnippet` before writing the file. The default snippet starts recording immediately.
   - `secretKey` block: for any SDK with `requiresSecretKey: true`, prompt the user once to paste their secret key from the dashboard URL in the response. Substitute locally; never echo it back, log it, or store it anywhere except the file you're writing.
4. **Insights is the install.** Drop `@sessionsight/insights` into the frontend entry point. That's it. Insights records sessions *and* fires goal completions client-side using the goal ID from step 3 — no backend SDK required for typical setups. Don't propose other SDKs unless the user states a need (see "Optional SDKs" below).
5. **Verify before declaring done.** After writing the insights snippet, ask the user to load the page once, then call `verify_sdk_installation` for the property and report `connected` + `lastSeenAt` back. If it isn't connected, point at where the snippet landed and what to check, instead of guessing or re-pasting. Stop here unless the user has asked for something more.

## Optional SDKs (only when asked)

Don't volunteer these. Add when the user states the matching need:

- **`@sessionsight/goals`** — backend SDK. Only when the user wants their backend to attribute conversions (e.g., revenue from a Stripe webhook) instead of relying on client-side completions. Insights already handles goal tracking from the browser, so most users don't need this.
- **`@sessionsight/feature-flags`** — only when the user wants to gate or evaluate flags.
- **`@sessionsight/feedback`** — backend SDK that POSTs structured feedback (bug reports, ratings, etc.) tied to a session. Only when the user wants to capture feedback from their own endpoint. Not a UI widget.
- **Non-JavaScript backends** — there is no SDK. Point the user at `https://sessionsight.com/docs/build/api-reference/authentication` and let them call the REST API directly.

## Privacy attributes

The Insights SDK respects HTML data attributes that control what gets captured. Recommend them when the user explicitly asks about hiding sensitive content, or when you spot an obvious PII surface during install (login form, payment fields, profile/account pages, anything rendering user-submitted content). Don't volunteer them otherwise — over-tagging degrades replay value and excluding too much makes recordings useless.

Two privacy modes set at the property level (dashboard, not the SDK) decide which default the page operates under:

- **Default mode**: text is hidden, form inputs are always hidden. Customers add `data-ss-unmask` to surface specific regions.
- **Relaxed mode**: text is visible, form inputs still always hidden. Customers add `data-ss-mask` to hide specific regions.

Attributes (closest ancestor wins; `data-ss-exclude` always trumps the others):

- `data-ss-mask` — hide text and input values from recordings. Inherits to descendants. Use on PII-bearing elements (profile cards, account info, anything user-submitted).
- `data-ss-unmask` — show text and input values, overriding default-mode masking. Inherits to descendants. Use on safe regions (nav, headings, marketing copy, app chrome).
- `data-ss-exclude` — drop the element entirely from recordings (no DOM, no events). Use sparingly: dashboards with real-time data, regions where even the structure shouldn't be captured.
- `data-ss-allow` — keep a specific image, video, or audio source visible in recordings. By default the SDK strips every `<img>`, `<video>`, `<audio>`, `<source>`, SVG raster `<image>`, and inline `background-image: url(...)` reference and renders a "media hidden" stand-in on replay. Use this on brand logos, marketing video, hero illustrations, audio sample players, or any media the customer has explicitly OK'd for replays. Inherits to descendants — wrapping a `<header data-ss-allow>` covers every nested logo/wordmark. Honors URL references only; `data:` and `blob:` sources are always stripped (embedded bytes would persist on SessionSight's servers).

When recommending one of these, place the attribute on the smallest element that covers the concern — wrapping a whole `<main>` in `data-ss-mask` is almost always wrong. Full reference: `https://sessionsight.com/docs/build/sdks/insights-sdk/privacy`.

User's request:

$ARGUMENTS
