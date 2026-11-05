# Privacy terms

Sima has no servers and no accounts, and collects no analytics. It uses AI only through Ollama on your own computer, so nothing Sima reads is sent anywhere.

## What stays on your computer

Everything. These stay in your browser and are never sent to the Sima project or anyone else:

- activities Sima has read, answers, explanations and logs
- your settings: the Ollama address and model, and which platforms Sima works on

When you click **Fill answers** or **Explain only**, Sima sends the question text, tables, image descriptions, field labels, the activity's directions, and any example or word list on the page to Ollama at a `localhost` or `127.0.0.1` address. Sima refuses any other address.

## What leaves your computer

Nothing that Sima reads. The only internet traffic Sima starts is downloading Ollama's model, when you ask it to during setup, which comes from Ollama's model library. Opening the Ollama download page is a normal visit to ollama.com.

Earlier builds could use online providers with an API key. Sima now deletes any key those builds saved.

## Deleting your data

In Settings, **Delete saved activities** removes saved activities, answers and logs. Removing the extension deletes everything Sima stored. Models you downloaded stay in Ollama until you remove them there.
