# Local AI

Sima works through questions with a model running on your own computer, through the free app [Ollama](https://ollama.com). There are no online AI providers, no accounts and no API keys, so question text never leaves your computer.

## Setup

Click the Sima icon on any site. Until local AI is ready, setup is the only thing Sima shows, and it moves along by itself:

1. **Install Ollama.** Sima links to the download. Once Ollama is open, Sima notices within a few seconds.
2. **Allow Sima, if Ollama asks.** By default, Ollama refuses requests from Chrome extensions. If it refuses Sima, setup shows one command to paste into Terminal (Command Prompt on Windows), then you restart Ollama. The command uses Ollama's `OLLAMA_ORIGINS` setting and lists only Sima's extension ID, so other extensions stay blocked. On a Mac the setting lasts until the computer restarts, so you may need to repeat it. Sima doesn't remove or change the origin it sends to get around this.
3. **Download the model.** If Ollama has no model yet, one click downloads `qwen2.5:7b`, about 5 GB. The download runs in Sima's background, so you can close the dropdown, and it resumes if it's interrupted.

If Ollama already has models, Sima uses `qwen2.5:7b` when it's there, or otherwise the first one that can answer questions, with no clicks. You can change the model and Ollama's address in Settings. Only `localhost` and `127.0.0.1` addresses are accepted. Larger models are usually more accurate but slower.

## Requests

Sima sends a page's questions together in one request, or several on a very long page, with temperature 0 and a JSON schema as Ollama's `format`. It validates the result with Zod, then checks each answer against the fields and options on the page. Only questions that fail a check are asked again.

If Ollama is busy with another request, Sima waits and retries twice, then shows a plain message. Clicking the button again solves whatever is left.
