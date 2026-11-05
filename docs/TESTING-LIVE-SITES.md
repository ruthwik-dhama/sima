# Testing on real sites

Sima's adapters don't understand the real Gradescope, VHL Central or WebAssign pages yet. Building them starts with learning how those pages are structured, using your own account.

## Rules

- **Use your own account, on ungraded work.** Entered answers can count as real work: on some platforms, a saved answer is what gets graded. A sandbox course or practice assignment from an instructor is best.
- **Don't open real exams or quizzes for testing.** Opening one can start a timer or log an attempt.
- **Check the rules that apply to you.** A platform's terms or your school's policy may limit automated tools.
- **Don't commit real course content or pages from your account.** Rebuild the structure in a mock with original questions.

## 1. Capture a page

1. Install Sima, and open a practice activity on a supported site.
2. Click the Sima icon. If it says "Sima can't read this page yet", click **Save page layout**.
3. A `sima-page-….json` file goes to your Downloads. Nothing is sent anywhere.

Capture one of each kind of page you can find: multiple choice, select-all, typed answers, dropdowns, matching, written responses, multi-part questions and multi-page activities. Sima refuses pages that look like exams, and this can also catch something harmless, like a homework titled "Final Project".

## 2. Check the file before sharing it

The file records how the page is built: element types, class names, field names with numbers replaced by `#`, and how many inputs and frames there are. It leaves out question text, answers, names, links and page titles.

**A site could still put something personal in a class or field name, and automated checks can't rule that out.** Before sharing the file, open it and search for your name, email, student ID, school and course. If anything turns up, don't share the file: open an issue describing what you found instead.

## 3. Use it

Share the file with whoever is building the adapter. For each platform, it shows:

- which elements wrap each question and answer field
- which control is Next and which is Submit
- whether questions sit inside an iframe (`counts` shows `iframe:same-origin` or `iframe:cross-origin`), a shadow root, or a rich-text editor

Sima can't read questions inside a cross-origin iframe yet, so the capture records only that frame's hostname.

## 4. Verify a platform

Once an adapter exists, test it on each page type, then mark it `compatibility: 'verified_live'` only if all of these pass:

| Check         | What to confirm                                            |
| ------------- | ---------------------------------------------------------- |
| Reading       | Every question and answer box is found, with nothing extra |
| Filling       | Answers stay after a reload and after moving between pages |
| Submitting    | Sima never presses Submit, however the button is labeled   |
| Blocking      | Exam-style pages in a sandbox course stay off              |
| Other content | Other subjects, textbooks and courses work too             |

Sites change without notice, so a platform that passes today can break later. Recheck after a site redesign, and treat a beta group across different courses and schools as part of the test.
