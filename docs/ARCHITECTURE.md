# Architecture

## Pipeline

```
content script                     background worker                    dropdown
--------------                     -----------------                    ----------
adapter.detectPage                 TaskEngine
adapter.extractQuestions  --PAGE_READY-->  persist analysis  --STATE_CHANGED-->  render
restriction scan                                             <--SOLVE-----------
                                   Reasoner -> provider (HTTP)
                                   Zod parse, validateSolution
                                   persist solution, unapproved
                                                             <--edit/approve----
                                                             <--EXECUTE---------
                                   buildPlan -> typed actions
executeAction  <--EXECUTE_ACTION-- journal "started"
verify by read-back  --result-->   journal "verified"/"failed"
```

The stages are kept apart on purpose. Reasoning produces values for known field keys and never touches the DOM. The executor takes typed actions and knows nothing of models.

## Package changes from the original outline

`question-extractor`, `field-detector` and `field-mapper` are one package, `page-analyzer`. Each was a few functions used only by the others, and mapping can't be scored without the detection context. `verification-engine` is part of `browser-executor`, because verification must read the same element right after the write. Everything else matches.

## Adapters

`PlatformAdapter` (`adapters/core`) is the only platform-specific surface: matching, readiness, page detection, restrictions, question containers and the next control. `analyzePage` composes it with the generic analyzer. A restricted page returns no questions at all, which is what makes the block hold downstream.

## Field mapping

`detectFields` scores each control. An explicit label scores 0.95 or higher, and a lone control in a question 0.92. Several unlabeled blanks score 0.85: each is marked in the question text (`[blank_a]`), so the model places answers using the words around it. Choices with unreadable labels score 0.4, and below 0.8 the planner returns a blocker until the user confirms.

## Actions and verification

`BrowserActionSchema` is a closed union: `fill_text`, `select_option`, `select_radio`, `set_checkbox`, `navigate_next`. For each action, the executor:

1. Re-validates the action, and re-checks restrictions on the live page.
2. Resolves the selector, and compares the element's tag, type and name with the fingerprint.
3. Applies the change with native setters and real events, so framework-controlled inputs see it.
4. Waits, then reads the value back. Controlled components can revert values on their next render.

## Task state and recovery

`TaskEngine` takes `TaskStore`, `PagePort` and `Reasoner` ports, so interruption can be tested without Chrome. State lives in IndexedDB and the worker is treated as disposable.

- **Status** is written before each step. On worker start, `recover()` treats any in-flight status as interrupted.
- **Action ids** are deterministic hashes of task, page, question, field and value. If a journal entry exists for an id, the engine reads the page before acting, so a value already entered is not entered again, and a value the page lost can be re-entered.
- **Retries** happen at most once, and only for failures a fresh read can fix (stale target, not persisted, no response). A disabled control isn't retried.
- **Navigation** is journaled, then confirmed by the next `PAGE_READY` having a different page key. Otherwise the content script reports a timeout. It's never retried automatically.
- **Pause and stop** are checked between actions and survive reloads.

## Extension surfaces

- **Floating pill:** React in a Shadow DOM, with bundled CSS and a px-based theme so host pages can't affect it. Clicking it opens the dropdown (Chrome 127 or newer).
- **Toolbar dropdown:** main workspace, using a Zustand store over background commands. It closes when the user clicks away, so all state lives in the background and a running fill continues without it.
- **Settings:** options page in its own tab, because a permission prompt would close the dropdown. Provider host permissions are requested here, when the user tests a connection.

Dexie is opened only from the background. A content script's IndexedDB would belong to the website's origin.
