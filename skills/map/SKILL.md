---
name: map
description: Build or refresh the repo map for an existing codebase (brownfield init). Scans the code mechanically, asks only what the code can't tell, runs one budgeted model pass, commits the map on the framed-init branch. Use when the user says "set up framed", "map this repo", "init framed here", /framed:map, or asks to fix a bug in a repo the framed status says is uninitialized (no .framed/map.md yet).
---

# framed: map

Brownfield init from the design doc, section 13: scan, map, ask gaps, work. Every step below ends on its own. If something fails, stop, say what happened in plain words, and ask. Do not improvise around it.

`FRAMED` below means `node "${CLAUDE_PLUGIN_ROOT}/scripts/framed.js"`. Run it from the repo root.

## 0. Preconditions

- Must be a git repo with a clean working tree. Ignore `.framed/scan.json`: it is framed's own cache from an earlier scan, and step 2 overwrites it. If there is any other uncommitted change, stop and ask the user to commit or stash it first.
- Branch: the map lands on the `framed-init` branch and goes to the default branch by PR, like everything else. If the current branch is not `framed-init`, create it from the current branch: `git checkout -b framed-init`. If it already exists, check it out.
- `FRAMED page open --reason setup`: the page opens on the Map page, which fills in once the map is written. Does nothing when the person turned the page off; never let it stop the setup.

## 1. Config

Run `FRAMED config`. Three outcomes:

- **Valid**: continue to step 2.
- **Missing**: the repo has no `.framed/config.json`. Do the scan first (step 2), then come back and ask the gap questions in step 1a, because the scan tells you most of the answers.
- **Invalid**: show the errors as printed and ask the user to fix the file. Stop.

### 1a. Gap questions (only when config is missing)

Ask only what the code can't tell you. Detect first, then confirm. Run `FRAMED detect`. It proposes every value from the repo's own branches, commit messages and project files, with the evidence. Then one message, three questions, all at once:

1. **Test commands.** `detect` proposes a command only where a test runner is really set up, with the number of test files it would run (`evidence.testsFound`).
   - If `tests` has entries: show them as "folder: command (n test files)", one per line. Ask: "Are these right? Add, remove or change any."
   - If `tests` is empty and `evidence.testFilesNothingRuns` is empty: don't ask. Say it plainly: "This repo has no unit tests yet" plus the reasons from `evidence.noTestRunner`. Add: "That's fine. The first fix in each project will offer to add a small test project for it."
   - If `evidence.testFilesNothingRuns` has entries, whatever `tests` holds: framed found test files it has no runner for. Show each as "n .ext test files, e.g. <example>" and ask: "What command runs these, and from which folder? Say none if they don't run." Add the answer to `tests` as given; "none" adds nothing. This is the one place a command comes from the user instead of the repo.
   - Either way, list `testsSkipped` with their reason, e.g. "Tests/UI-Automation needs the running app, so framed won't run it."
   - If the user doesn't know: keep the detected list as it is. **Never move a skipped suite into `tests`**, and never swap in a command of your own.
2. **Ticket boards and branch names.** Show `ticketPrefixes` with their ticket counts from the evidence, and `branchPattern` with an example, e.g. `bugfix/PROJ-123-fix-invoice-total`. A `"#"` entry means numbered tickets (GitHub issues, Azure Boards work items); show it as "numbered work items or issues, like 1234" with the example `bugfix/1234-fix-invoice-total`. If `evidence.branchPattern.convention` is false, say the repo has no clear branch convention, so framed will use its own. Ask to confirm.
   - If `ticketPrefixes` is empty, ask instead: "I found no ticket numbers in branch names or commits. Where does this team track work: Jira (tell me the key, like ABC), or numbered work items or issues in Azure Boards or GitHub?" A Jira key goes in as given, upper-case. Numbered work items or issues go in as `"#"`.
3. **Anything I shouldn't touch?** Paths, folders, or generated code. Optional; an empty answer is fine.

Then write `.framed/config.json` with the **Write tool**, never a shell heredoc or `echo` (one quote in a value breaks the shell's quoting). It holds `tests` (`[]` if none), `ticketPrefixes`, `branchPattern`, `defaultBranch` and `protectedPaths` (empty array if none), as confirmed. Leave the other fields out so defaults apply. Run `FRAMED config` again to confirm it validates. Do not ask follow-up rounds.

## 2. Scan

```
FRAMED map scan --root . --out .framed/scan.json
```

Takes seconds to a minute. Prints stats to stderr and JSON stats to stdout; read the one-line summary. If it fails, show the error and stop.

Then make sure `.framed/scan.json` is in `.gitignore` (append a line if not). It is a regenerable cache, not an artifact.

## 3. Model pass

Read `models.mapPass` and `budgets.mapPass` from the `FRAMED config` output. Spawn the `framed:map-builder` subagent with that model, with this prompt, filling the placeholders:

> Repo root: `<absolute path>`. Budget: `<budgets.mapPass>` tool calls, counted from your first. Config: `.framed/config.json` (read `tests` for the Watch out section and `protectedPaths` for the hand-maintained section). Scan summary command: `FRAMED map summary --root "<absolute path>"`. Write `.framed/map.md` as your instructions say, then reply with the three gate-card lines.

Wait for it. Its reply is three lines.

Then check the file yourself, whatever the agent said: `FRAMED map check`. If it fails, do not show a gate card. Tell the user the map builder did not produce a usable map, show the check's errors, and stop. Do not write the map yourself.

## 4. Gate

Show the user the three lines as the map builder wrote them, then ask one question:

> Map written to `.framed/map.md`. Commit it on `framed-init`?

If no: stop. The file stays in the working tree for them to edit or discard.

## 5. Commit

```
git add .framed/config.json .framed/map.md .gitignore
git commit -m "framed: map init"
```

(Only `.gitignore` if you changed it.) Then tell the user, in one line each: the commit is on `framed-init`; the hand-maintained section at the bottom of the map is theirs to fill in; opening the PR to the default branch is the next step and is done the normal way.

## What this skill never does

- Rebuild the map in full later. That is reconcile, v2. Running this again overwrites `map.md` only after the gate says yes.
- Push, merge, or open the PR by itself.
- Write anything outside `.framed/` and `.gitignore`.
