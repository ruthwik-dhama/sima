<p align="center">
  <img src="docs/logo.png" alt="Sima logo" width="128" height="128">
</p>

<h1 align="center">Sima</h1>

<h3 align="center">Your AI learning assistant in Chrome</h3>

<p align="center">
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-black?style=flat-square"></a>
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-black?style=flat-square">
  <img alt="TypeScript 6" src="https://img.shields.io/badge/TypeScript-6-black?style=flat-square">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-black?style=flat-square">
  <img alt="WXT 0.21" src="https://img.shields.io/badge/WXT-0.21-black?style=flat-square">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-black?style=flat-square">
  <img alt="shadcn/ui Radix" src="https://img.shields.io/badge/shadcn%2Fui-Radix-black?style=flat-square">
  <img alt="Zustand 5" src="https://img.shields.io/badge/Zustand-5-black?style=flat-square">
  <img alt="Zod 4" src="https://img.shields.io/badge/Zod-4-black?style=flat-square">
  <img alt="Dexie 4" src="https://img.shields.io/badge/Dexie-4-black?style=flat-square">
  <img alt="Vitest 5" src="https://img.shields.io/badge/Vitest-5-black?style=flat-square">
  <img alt="Playwright 1.64" src="https://img.shields.io/badge/Playwright-1.64-black?style=flat-square">
  <img alt="pnpm 12" src="https://img.shields.io/badge/pnpm-12-black?style=flat-square">
  <img alt="Node 22+" src="https://img.shields.io/badge/Node-22%2B-black?style=flat-square">
</p>

Sima is an open-source Chrome extension that helps you understand learning activities. It reads the questions on a supported page, works through them with an AI model running on your own computer, and explains its reasoning. It needs no account or API key, and question text never leaves your computer. If your course allows it, Sima can also enter the answers for you to check before you submit.

**Status: early development.** VHL Central now handles real activities, but it has only been tried on a few. Gradescope and WebAssign have only been tested against local mock pages. See [Known limitations](#known-limitations).

## What Sima won't do

- **It never submits work.** Saving and submitting are always yours to do.
- **It stays off on exams and quizzes.** It also stays off on proctored or timed activities, and on activities that say AI isn't allowed. There's no override.
- **It doesn't enter anything unasked.** The first time you click **Fill answers** on an activity, Sima asks you to confirm that AI help is allowed there. Your answer lasts for that whole activity.

You're responsible for following your course's academic integrity policy. If you're unsure whether AI help is allowed, ask your instructor first.

## Install

You need Chrome 127 or newer. Sima isn't on the Chrome Web Store, so you install it in Developer mode.

1. Download the latest `.zip` from the [Releases page](https://github.com/ruthwik-dhama/sima/releases/latest).
2. Unzip it, and put the folder somewhere permanent. Chrome loads Sima from this folder, so deleting or moving it removes the extension.
3. Go to `chrome://extensions` and turn on **Developer mode** at the top right.
4. Click **Load unpacked** and choose the unzipped folder.
5. Click the puzzle-piece icon in the toolbar, then pin Sima.

**Set up local AI:** click the Sima icon on any site. Setup is the first thing it shows: install the free [Ollama](https://ollama.com/download) app and open it, paste one command if Ollama asks you to allow Sima, then click to download the AI model (about 5 GB). Sima notices each step by itself. See the [local AI guide](docs/LOCAL-AI.md) and [privacy terms](docs/PRIVACY.md).

**Use it:** open an activity on a supported site, click the Sima icon, and click **Fill answers** or **Explain only**.

**Update it:** download the new `.zip`, replace the contents of the same folder, and click the reload arrow on the Sima card at `chrome://extensions`. Updates aren't automatic, so watch the repository's releases to hear about new versions.

If you see "Sima can't read this page yet", Sima doesn't understand that page's layout. You can help add support: see [Testing on real sites](docs/TESTING-LIVE-SITES.md). The downloaded version can't open the mock activities, so to try those, build from source and follow [Try it on the mock platforms](#try-it-on-the-mock-platforms).

## Build from source

You need Node.js 22 or newer and Chrome 127 or newer.

```bash
corepack enable
pnpm install
pnpm --filter @sima/extension prepare:wxt
pnpm build
```

Then load it in Chrome:

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `apps/extension/.output/chrome-mv3`.
3. Click the Sima icon in the toolbar and follow the local AI setup. See [docs/LOCAL-AI.md](docs/LOCAL-AI.md).

## Try it on the mock platforms

The production build doesn't run on localhost pages, so use the development build:

```bash
pnpm playground
```

```bash
pnpm build:e2e
```

Load `apps/extension/.output-e2e/chrome-mv3` as above, then open http://localhost:5199.

## Development

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

```bash
pnpm test:e2e
```

End-to-end tests need Chromium once: `pnpm exec playwright install chromium`. They use a local fake Ollama server, so no model is needed.

## Known limitations

- **Live support is limited.** VHL Central has been tried on only a few real activities, so other layouts may not work. Gradescope and WebAssign adapters only understand the local mock pages, so their real pages show "Sima can't read this page yet". See [Testing on real sites](docs/TESTING-LIVE-SITES.md).
- **Answers can be wrong, so check them.** Accuracy depends on the model you run. The default, `qwen2.5:7b`, got 14 of 24 on a local test set, and larger models usually do better. These are small tests, not a guarantee.
- **Local AI needs a capable computer.** The default model needs about 5 GB of disk space and enough memory to run it, and answers are slower than online AI, especially without a fast graphics chip.
- **Ollama may need one setting.** By default it refuses Chrome extensions, so setup asks you to paste a command, and on a Mac you repeat it after restarting the computer.
- **Restriction detection is a heuristic.** It reads titles and visible text, so it can miss a restriction stated elsewhere, such as in a syllabus, or block a legitimate activity. A miss doesn't change your obligation to follow course rules.
- **Images aren't sent to models.** Only their descriptions are, and confidence is capped when a description is missing.
- **Only top-level documents are read.** Questions inside iframes aren't detected, and rich-text editors built on iframes can't be filled.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Privacy terms](docs/PRIVACY.md)
- [Security](docs/SECURITY.md)
- [Local AI](docs/LOCAL-AI.md)
- [Testing on real sites](docs/TESTING-LIVE-SITES.md)
- [Contributing](CONTRIBUTING.md)

MIT licensed. Not affiliated with Gradescope, Vista Higher Learning, WebAssign or Cengage.
