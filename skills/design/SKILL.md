---
name: design
description: Find more style options for the framed page's Studio (the design scout), and build the design the user saved there. In an existing app, restyle only its theme layer (colour variables, fonts, corners), after one consent gate that lists exactly which files change; then branch, change, check, PR. In a folder with no code, start the new app on the design and write .framed/design.md, which every later build follows. Use when the user asks for more design options or looks for their app ("find designs for…", "more options"), or says "build my design", "apply the design", "restyle the app with the Studio design", or starts a new app from the saved design. Also /framed:design.
---

# framed: design

The Studio tier from the design doc (§19). The person picked a look on the page; this builds it. One gate, before anything changes; after the yes, no more questions, and the PR review is where a person looks again. The same rules as patch hold: every step ends, the git rules are a hook, never change the machine to get past an environment problem.

`FRAMED` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/framed.js"`, run from the repo root.

## More options: the design scout

When the person asks for more or different looks ("find designs for a bakery", "more options", "something warmer"), before or instead of building: spawn the `framed:design-scout` agent with this prompt, filling the placeholders:

> Repo root: `<absolute path>`. Brief: `<their words, or "none">`. Make 6 styles. `FRAMED` is `node "${CLAUDE_PLUGIN_ROOT}/scripts/framed.js"`. Write `.framed/design/options.json` as your instructions say, then reply with three lines.

Show its three lines and say the new looks are on the Studio page, at the front, marked "design scout"; they pick one there and save it. Nothing is built until they say "build my design". Do not edit `options.json` yourself. A new scout run replaces it.

## 0. The saved design

`FRAMED page open --reason design` first (the Studio page; nothing when the person turned the page off). Then run `FRAMED design choice`. If it fails, show its message as it is and stop: there is no saved design, or it is not valid, and the fix is on the page, not here. The output has `style` (the tokens), `mode` (`brownfield` or `greenfield`) and, for a restyle, `target` (the app, its UI libraries and its theme files).

Then follow the section for the mode. Never switch modes: a folder with code is never rebuilt from scratch, and a new project is never "restyled".

## Existing app (brownfield): consent first, theme layer only

The rule: a restyle changes the theme layer and nothing else. The theme layer is the files `target.themeFiles` lists, plus the one place fonts are loaded (`index.html` or the root layout) when the fonts change. Components, screens and their class names are never edited, even where they use fixed colours.

1. **Clean tree, branch.** The working tree must be clean; if not, stop and ask to commit or stash. Branch: if the user gave a ticket, the config's `branchPattern` with that ticket and the slug `restyle`; otherwise `framed-design`. Create it from the default branch.
2. **Work out the change, write nothing yet.**
   - Read each theme file in `target.themeFiles`. Find where each colour, the radius and the font are declared, in light and in dark (`.dark`, `[data-theme=dark]`, `@media (prefers-color-scheme: dark)`).
   - The new values come from `FRAMED design css --names shadcn` when the app's variables are shadcn's names (`--background`, `--primary`, `--muted-foreground`, …), else from `FRAMED design css --names generic`, matched to the app's own variable names. Keep the app's variable names and its colour notation; only the values change. A variable the app does not have is not added, except the font variable when there is none.
   - A theme file that is a shared package other apps also import (it lives outside `target.dir`) changes those apps too. List every app that imports it under what changes.
   - Run `FRAMED design hardcoded`. These are colours fixed in components, which the theme change does not reach.
3. **The gate.** Show three lines and ask one question:
   - **What changes**: each file, and per file the values before → after (background, text, accent, borders, radius, font, and spacing or motion where the app declares them), light and dark. Every other app the change reaches.
   - **What stays**: every component and screen. From `hardcoded`: "N files set their own colours (e.g. `<file>`), so those parts keep today's look; restyling them is screen-by-screen work, outside this change."
   - **Unsure**: anything you could not map, e.g. a colour the design has no slot for.
   - Then: "Yes = I'll change these N files, check the app still builds, and open a PR. No changes anything until you say yes. Or tell me what to change."

   A change request ("keep the old font", "don't touch shared-ui") revises the plan; show the gate again. "No" ends it with nothing changed: delete the branch if it has no commits.
4. **After yes.** Change the values in the theme files and nothing else. Then check: the app's build or type-check script from its `package.json` (`build`, else `typecheck`/`tsc`), and its tests from `.framed/config.json` if it has any. If something cannot run on this machine, it is not fixed by changing the machine (§9): the PR is a draft with "For the reviewer: <check> was not run on this machine: <why>". A build that fails because of the change is fixed in the theme files only; if it can't be, stop and report.
5. **Commit and PR.** One commit, `design: restyle <app> to <style name>` (with the ticket in front if there is one). PR exactly as patch's pr step does it (push only to a real remote; `gh` or `az`; by hand otherwise). Title `Restyle <app>: <style name>`. Body: For the reviewer items first if any, then the before → after table, what stays and the hardcoded count, the checks run. Draft when there are reviewer items.
6. Tell the user in three lines: the PR (or where the title and body are), what changed, what the reviewer should look at first.

## New project (greenfield): the design is the foundation

1. **Git and branch.** If the folder is not a git repo, `git init` (this folder is the user's new project; say so on the gate). Work on the branch `framed-design`.
2. **The gate.** One question, three lines:
   - **What I'll build**: an app shell on the design. React + Vite + TypeScript by default: the theme as CSS variables in `src/styles/tokens.css` (from `FRAMED design css --names generic`, light and dark), base styles that use only those variables, fonts loaded once, and a first screen (navigation, a header, cards, a table, a form) showing the design. Plus `.framed/design.md`.
   - **What it decides**: the stack, the folder layout, the token names.
   - **Unsure**: nothing, unless the user has said what the app is for; then the first screen is shaped for that.
   - Then: "Yes = I'll set this up and commit it on framed-design. Or tell me a different stack (plain HTML and CSS, Next.js, …) or anything to change."
3. **After yes.** Scaffold with the stack's own tool in this folder (`npm create vite@latest . -- --template react-ts`, then `npm install` in the folder; never a global install). Write the tokens and styles. Every colour, radius, font, shadow, spacing step and transition in the code reads a variable; no colour is typed into a component.
4. **`.framed/design.md`**, the durable artifact every later build reads (§8):
   ```
   # Design: <style name>
   Saved in Studio on <date>. <vibe>
   ## Tokens
   | token | light | dark | used for |
   (one row per colour slot, then radius, spacing, shadow, motion)
   ## Fonts
   headings <font>, text <font>, code <font>; loaded in <file>
   ## Where it lives
   src/styles/tokens.css (variables), src/styles/base.css (elements)
   ## Rules
   - Components use the variables, never a typed colour, size or font.
   - <one line per readability note: e.g. the accent is a fill behind accentInk text; links on cards use the text colour, underlined in the accent, when the accent is too light for text>
   - New screens follow the spacing (<density>, `--spacing`) and corners (<radius>px).
   - Transitions use `--duration` and `--ease` (<motion>ms), never a typed duration. They stop when the system asks for reduced motion (`tokens.css` does this).
   ```
   Fill the readability notes from the tokens: text on background, quiet text on cards, button text, links on cards, each with its contrast ratio; any below 4.5 gets a rule saying what to use instead.
5. **Check and commit.** Run the dev build (`npm run build`). Commit `design: start <app> on <style name>`. There is usually no remote yet: say the work is on `framed-design` and how to merge it when they are happy.
6. Tell the user in three lines: what was built, where the design rules are (`.framed/design.md`), how to run it (`npm run dev`).

## What this skill never does

- Edit components or screens in an existing app. That is work per screen, and it goes through patch, one ticket at a time.
- Ask after the yes. Surprises become "For the reviewer" items and a draft PR.
- Change the machine: no global installs, no PATH or runtime changes.
- Push to the default branch or merge.
