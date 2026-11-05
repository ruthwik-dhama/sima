# Security and privacy

## Threat model

Webpages are untrusted, including course content that an instructor or another party could have edited. Model output is also untrusted, because page content can influence it. The trusted parties are the user and the extension's own pages.

| Threat                                 | Mitigation                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden text instructs the model        | Extraction reads rendered text only, excluding hidden, zero-size, transparent and off-screen content                                                                   |
| Visible text instructs the model       | The prompt fences page text as data, delimiter look-alikes are stripped, and sentences aimed at AI tools are removed before the model reads them and shown to the user |
| Injected model output tries to act     | Output is limited to values for fields and options on the page. It can't name selectors, actions or URLs                                                               |
| Model output is malformed              | Zod rejects it, and it's shown as an error                                                                                                                             |
| Model output contains markup           | React renders it as text. Nothing uses `dangerouslySetInnerHTML`                                                                                                       |
| Selector now points at another element | Element fingerprint check before every action                                                                                                                          |
| Submit control presented as "Next"     | Label and type are checked at analysis and again at execution                                                                                                          |
| Page reads stored data                 | `storage.local` is locked to trusted contexts, and Dexie is opened only from the worker                                                                                |
| Compromised content script             | Settings commands are rejected unless sent from an extension page                                                                                                      |
| Settings point Sima at another server  | The Ollama address must be `http://localhost` or `http://127.0.0.1`, checked by Zod in the worker                                                                      |
| A page detects Sima                    | No web-accessible resources. The floating UI's host element is still visible to the page                                                                               |

Injection defenses reduce the risk but can't eliminate it: visible text can still sway an answer. Sentence-level detection misses phrasing it doesn't recognize, and Fill answers enters answers without a review step. The worst a successful injection can do is put a wrong value in a field on that page, which the user can see and change before submitting.

## Academic integrity

Sima enforces what it can see, and stays off on anything that looks like an assessment. It can't know a course's full policy, so it asks the user to confirm for each activity before filling. A missed detection doesn't make use permitted. Sima has no mechanisms for hiding from a site, and none should be added.

## Data handling

- **Stored locally:** extracted questions, responses, explanations and action logs in IndexedDB; preferences in `chrome.storage.local`. There are no API keys, and the worker deletes any an earlier build saved.
- **Sent externally:** nothing Sima reads. Question text goes only to Ollama on this computer. There's no Sima backend and no analytics.
- **Deleting:** Settings can delete saved activities. Removing the extension deletes everything.

## Page layout captures

**Save page layout** creates a file on the user's computer and sends nothing. It's built from an allowlist of structural details, not by removing things from a copy of the page, so text, values, links, titles and data attribute values have no path into it. Numbers in identifiers become `#`. Pages that look like assessments are refused. A class or field name could still contain a personal word, which is why users should check the file before sharing it. `tests/integration/capture.test.ts` plants secrets in every place a page can hold them.

## Permissions

| Permission                         | Why                                       |
| ---------------------------------- | ----------------------------------------- |
| `storage`                          | Preferences                               |
| Host access to the three platforms | Reading and filling activities            |
| Host access to `localhost`         | Reaching Ollama, the only model Sima uses |

## Known gaps

- Restriction detection is heuristic and only sees the current page.
- Page content is treated as trusted by the user when they review it: Sima shows extracted text, not a guarantee of what it means.

Report vulnerabilities privately to the maintainers rather than in a public issue.
