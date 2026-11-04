# Contributing

Read the operational restrictions in `CLAUDE.md` first. Changes that weaken them won't be accepted.

Before opening a pull request, run:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e
```

## Adding a platform

1. **Build a mock.** Add `playground/<platform>/` with original content that reproduces the real layout's structure, including a restricted page. Update `playground/index.html`.
2. **Write the adapter.** Create `adapters/<platform>` implementing `PlatformAdapter`, with every selector inside it. Set `compatibility: 'mock_only'`. Add any assessment markers the platform has to `platformRestrictions` and `detectPage`.
3. **Register it.** Add it to `apps/extension/services/adapters.ts`, and add its hosts to `host_permissions` in `wxt.config.ts` and to `matches` in `entrypoints/content/index.tsx`. Keep hosts as narrow as you can.
4. **Test it.** Add extraction and restriction cases to `tests/integration/adapters.test.ts`, and a flow to `tests/e2e/extension.spec.ts`.
5. **Mark live verification honestly.** Only use `verified_live` after testing on the real site with your own account, and record what you tested in the pull request.

Don't commit real course content or pages from your account. Rebuild the structure in a mock with original questions.
