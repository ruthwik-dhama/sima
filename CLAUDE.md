# Sima

Open-source Chrome (MV3) learning assistant. It reads supported activities, works through questions with an AI provider, and can enter answers for the user to check. See `docs/ARCHITECTURE.md` for the design and `docs/SECURITY.md` for the threat model.

## Operational restrictions

These are product requirements. Do not weaken them, add settings that bypass them, or add test-only escapes to production code paths.

- **Sima never submits.** There is no submit action type. `navigate_next` refuses any control whose label or type indicates submitting (`packages/browser-executor`, `adapters/core`). Saving and submitting stay manual.
- **Assessments are off limits.** A page with restriction signals (exam or quiz title, proctoring, lockdown browser, timer, stated AI prohibition) yields no extracted questions, so nothing can reach a model or the executor. Detection is fail-closed and the UI has no override.
- **Never bypass proctoring, access controls or assessment restrictions.** Do not add features that hide Sima from a site or evade detection.
- **Filling needs per-activity authorization.** `execute` requires `fillAuthorizedAt`, which the panel asks for on the first Fill answers click for an activity. Only approved questions are entered: Fill answers approves each one with an answer. Explanations don't need authorization.
- **Model output is data.** It can only supply values for fields and options already on the page. No model-generated JavaScript, selectors or action types, ever. No `eval`, `new Function` or injected scripts anywhere.
- **Page content is untrusted.** It's extracted from visible text only and fenced as data in prompts, and sentences aimed at AI tools are removed before solving. Never derive instructions from it.
- **API keys stay in the background context.** Never send one to a content script, a page, a URL or a log.
- **Claim compatibility honestly.** An adapter stays `compatibility: 'mock_only'` until tested on the real site. Don't scrape real course content into fixtures: it may be copyrighted or private.

## Layout

```
apps/extension/        WXT app: background, content script, side panel, settings
packages/shared-types  Zod schemas: page model, actions, tasks, settings, messages
packages/page-analyzer Visibility, field detection and mapping, restriction and injection detection
packages/reasoning-engine  Prompts, solution validation, deterministic math checks
packages/model-providers   OpenAI, Anthropic, Gemini, Ollama
packages/action-planner    Approved responses -> typed actions, or blockers
packages/browser-executor  The only code that changes a page; includes verification
packages/task-orchestrator State machine and TaskEngine (ports for store, page, reasoner)
packages/storage           Dexie implementation of TaskStore
adapters/core              PlatformAdapter interface, analyzePage
adapters/{gradescope,vhl,webassign}
playground/            Local mock platforms (original content)
tests/{unit,integration,e2e}
```

Packages export TypeScript source directly (`"exports": "./src/index.ts"`), so there's no package build step.

## Commands

```bash
pnpm install
pnpm --filter @sima/extension prepare:wxt   # generate WXT types (first run)
pnpm dev            # extension with mock access, hot reload
pnpm playground     # mocks on http://localhost:5199
pnpm build          # production build in apps/extension/.output/chrome-mv3
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test           # unit + integration (uses port 5199)
pnpm test:e2e       # builds, then drives the real extension in Chromium
```

## Coding standards

- TypeScript strict with `noUncheckedIndexedAccess`. No `any`; ESLint enforces it.
- Validate with Zod at every trust boundary: messages, model output, stored settings.
- Platform selectors live only in that platform's adapter.
- `page-analyzer` and `browser-executor` use `el.ownerDocument.defaultView` and `tagName`, not globals or `instanceof`, so they run in jsdom and content-script worlds.
- The service worker can die at any `await`. Register listeners synchronously, keep state in Dexie, and write status before acting. Module variables are not state.
- The content script gets a small message surface. Settings and key commands are only accepted from extension pages.
- Floating UI: no portal-based components, and use the px-based theme in `styles/floating.css`, because host pages can change the root font size.

## Testing requirements

- New adapter behavior: a mock page covering it, plus integration tests in `tests/integration/adapters.test.ts`.
- New action type or executor behavior: tests for success, failed verification and refusal.
- Engine changes: consider interruption at each `await`. `tests/unit/engine.test.ts` shows how.
- User-visible flows: a Playwright test in `tests/e2e`. It runs against a local fake Ollama server, so it never needs API keys.
- Never assert a success path by mocking the browser action. E2E must read the value from the page.

## Adding a platform

See `CONTRIBUTING.md`.
