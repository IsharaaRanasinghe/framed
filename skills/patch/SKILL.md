---
name: patch
description: Fix one bug in an existing repo without breaking what depends on the changed code. Steps find → blame → one gate → test → fix → suite → PR, one working file as the checkpoint, a commit at the end of every step. The user is asked once, at the gate, before any code changes; after their yes it runs to the PR without further questions. Use whenever the user describes a bug, pastes a ticket, asks for a fix, or says "continue" on a task, in a repo the framed status says is ready or has a task in progress. Also /framed:patch.
---

# framed: patch

The patch tier from the design doc (§6, §20). One bug, small change, full safety: know what depends on the code before touching it, pin current behaviour in tests before changing it, run the whole suite after, deliver by PR. The person decides once, on the plan; the rest is automatic, and the PR review is where a person looks again.

`FRAMED` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/framed.js"`, run from the repo root.

## The rules that hold for every step

- **Every step ends.** It ends done, failed, or blocked. It never keeps going because it is "nearly there".
- **End of step = update the working file, then commit.** Also when the step failed or is blocked. The commit message is `<TICKET> [<step>] <one line>`. Steps that change no code commit the working file alone. The row's `commit` cell cannot hold its own sha (the commit happens after the write): leave it blank, fill it in when you write the next row. The frontmatter `step:` is the step whose row you are writing.
- **The working file is the only state.** If the session dies, the next one runs this skill again; it reads the file and continues from the last row. Never restart from scratch.
- **One gate, before any code changes.** It comes at the end of the blame step. Everything that needs a person is found before it: where the bug is, what depends on it, comments that say the code is deliberate, whether the test project runs. A "no" is never the end: the person says what is wrong, you change the Plan and show the gate again, as many rounds as it takes.
- **After the yes, no more questions.** Something that turns up later and needs a person's decision (a fix that puts back recently removed code, an existing test that now fails because of the change, a test project that could not be created) does not stop the task and is not asked. Add it to Open questions as "For the reviewer: <what, and your reading of it>", continue, and open the PR as a draft. A step that cannot continue at all (the code does not build, the bug test cannot be made to pass) writes what happened in its row, sets `status: blocked`, commits, and reports in a three-line card without a question. The branch and working file stay; "continue" resumes it.
- **Never change the machine to get past an environment problem.** No drive mappings (`subst`), no global installs or uninstalls, no PATH, registry or system settings, no SDK or runtime switching. And never change the repo to suit this machine: a test project targets the same framework and version as the project it tests, even when this machine cannot run it. When something cannot run here (a missing runtime, a path too long, a tool missing), the tests are still written and committed, and Open questions gets "For the reviewer: <tests> were not run on this machine: <why>". Any choice made because of this machine rather than the repo is a "For the reviewer" item, never just a Decision. Either way the PR opens as a draft.
- **Failure paths (§16) before the gate** stop and ask: write what happened in the step's row, set `status: blocked`, add an Open question, commit, show a three-line card, stop. Do not improvise around a failure.
- **The ticket is the scope.** Change only the behaviour the ticket asks about. Every other behaviour stays exactly as it is, even when it looks stale, odd or unreachable. When you notice one, write it as a Decisions line, "Left as is: <what it does today> (`<file>:<line>`), outside the ticket", so the reviewer sees it in the PR, and move on. Each one is checked against the code before the gate (blame step). Comments that your change makes untrue are part of the change: update them.
- **Settle it yourself before asking.** The gate's question is the only one, and its unsure line is information, not a second question. Ask something there only when the rules here and the code cannot settle it: the ticket does not say what should happen in a case your change affects, the evidence conflicts, or a comment says the code is deliberate. "Should I also change X?" is never a question; the scope rule answers it.
- **Follow the design when there is one.** If `.framed/design.md` exists, a change that touches the UI follows its rules: colours, fonts and corners come from its variables, never typed in.
- **Cards are three lines**: what changed, what was decided, what is unsure. Written for a non-coder.
- **Git rules are enforced by a hook**, not by you. If a git command is blocked, do not try another form of it. Read the reason and do what it says.

## Start or resume

Input: whatever the user wrote or pasted, in their own words. Take from it a ticket key (its prefix is one of the config's `ticketPrefixes`, e.g. `PROJ-412`) and a one-line title in plain words. No key in it: ask once, "What's the ticket number?" A key with any other prefix: stop and ask; do not add prefixes to the config yourself. The rest of what they wrote goes into Task as given.

**Numbered tickets.** When `ticketPrefixes` has `"#"`, a work item or issue number is a ticket too: `1234`, `#1234`, `AB#1234`, or a work item or issue URL ending in the number all give `1234`. `<TICKET>` is then written two ways:
- the bare number, `1234`, in the branch name, the working file name and its frontmatter `ticket:` (a `#` would start a comment there);
- `#1234` in commit messages and the PR title. Azure Repos and GitHub turn it into a link to the work item or issue.

1. `FRAMED config` must be valid and `.framed/map.md` must exist. If the map is missing, say "run /framed:map first" and stop.
   Then `FRAMED page open --reason <TICKET>`, for a new task or a resumed one. It starts the page if it isn't running and opens the browser once per ticket; when the person has turned the page off it does nothing. Pass on its one line if it prints one; never let it stop the task.
2. **Resume check**: `FRAMED task`. Exit 0 with a task for the current branch means resume: read that working file and continue from its last row. A `running` row means its work is uncommitted in the working tree, so look at `git status` and `git diff` first. A `suite | running` row saying "touched files temporarily at base" means a session died mid-check: run `git restore --worktree -- <those files>` before anything else. A last row `blame | blocked` waiting at the gate means show the gate again. Skip the rest of this section. Exit 1 with "no working file for branch" is the normal new-task case.
3. **New task**: the working tree must be clean; if it is not, stop and ask the user to commit or stash. Then `git checkout <defaultBranch>` and `git pull --ff-only`. If the pull fails (diverged, conflicts, no remote), stop and ask; do not merge or rebase on the user's behalf.
4. Branch: the config's `branchPattern` with `{ticket}` as the key and `{slug}` as the title, lower-case, hyphens, at most 40 characters. E.g. `bugfix/{ticket}-{slug}` gives `bugfix/PROJ-412-invoice-total-ignores-credit`. `git checkout -b <branch>`.
5. Regenerate the scan now, every time: `FRAMED map scan --root . --out .framed/scan.json`. Seconds, and the pull may have changed the code it describes.
6. Create `.framed/tasks/<TICKET>.md` from `${CLAUDE_PLUGIN_ROOT}/templates/working-file.md`. Fill the frontmatter (`tier: patch`, `status: in-progress`, `step: find`). Delete the HTML comment blocks and the example bullets; they are guidance for you, not content. Keep the headings and the empty Steps table.

## Step: find

Goal: know where the bug is, what depends on that code, and what you intend to change. No code changes in this step.

1. **Task**: the bug in the reporter's words, repro steps, and the reported cases (record ids, names, dates) if the ticket has them.
2. **Locate**: read the map's Modules and Watch out sections to pick the module, then search the code. Stop looking after about 20 tool calls. If you have not found the cause by then, write what you have and what you ruled out, and go to the failure path.
3. **Blast radius**: for every file you intend to change, run `FRAMED deps <path>`. Then read the map's How they connect and Hand-maintained sections for that file's module and add anything manual there (source `manual`). Write `touches:` and the dependents list with a **proposed verdict** per dependent: `updated` or `no change` plus why, in one phrase. A dependent you have not looked at gets `check at fix` for now. If `deps` says HUB, or the file is listed under the map's Watch out hubs, say so in the Plan and expect the full suite to matter.
4. **Plan**: ordered, one line per intended change, each naming the file and the function or line range it touches. One line is fine. Each line must be needed for what the ticket asks; anything else you found goes under Decisions as "Left as is" (see the scope rule).
   **Scope check.** Under the Plan, list every case the changed code tells apart (its inputs or states), one line each: `<case>: today <result> -> after <result>`, and mark the cases the ticket describes. A case the ticket does not describe must have the same result after as today. If a Plan line changes one, narrow that line until it doesn't. Do not reason that the ticket "implies" it, that the case "can't happen", or that the old behaviour is stale; that is the "Left as is" note, not a change.
5. **Where the tests go.** For each file you will change, find the config `tests` entry whose `path` contains it. If none does, that project has no unit tests yet (§10). Add a first Plan line: "Add the first test project for <project>: <how>". When another project of the same stack in this repo already has tests (any config `tests` entry, or a test project or test config the scan sees), copy its tool and setup: the same runner, version, assertion and mocking libraries, and the same layout (Vitest next to Vitest, xUnit with FluentAssertions next to xUnit with FluentAssertions). Name the project you copied in the Plan line. Only when the repo has none for that stack, the stack's own standard setup: for .NET, an xUnit project next to it (`dotnet new xunit`); for JS/TS, the workspace's own test generator, or Vitest for a plain package. Never put tests into a suite the config lists as needing a running app.
6. Steps row `find | done`, commit `<TICKET> [find] <where the bug is, in one line>`. Continue straight to blame; there is no gate here.

## Step: blame

Goal: do not undo what was deliberate (§11), and know before the gate that the tests can run. Then the gate.

**Commit and PR messages are context, never evidence.** Many say only "fix", and one PR title often covers several unrelated changes. What decides is in the code: a comment that explains the lines (this step), lines a recent commit removed coming back (the fix step), and an existing test that pins the behaviour (the suite step).

1. For each existing file in the Plan, run `FRAMED why <file> <first>-<last>` on the function or block that will change. It prints the comments in and right above the block, and the commits that last touched it, with what each recent one actually changed there and the merge that brought it in. New files have nothing to check; say so in the row.
2. Read the comments. A block is **protected** when a comment explains *why* the code is the way it is: a reason, a rule, an order that matters, a "keep", "must" or "do not", a ticket. A comment that only labels what the code does ("calculate total") does not protect it. Quote each protecting comment in the row note, with file and line. It goes on the gate card.
3. **The test project, once, as it is.** If the Plan uses an existing `tests` entry, build and run it now, before anything is written. If it does not build or run at all, the Plan changes: put the new tests in a new test project instead (a Plan line like step 5 of find), and say why on the gate card. A project that needs a new test project and already has one planned needs nothing here.
4. **Check the notes.** Notes written while searching can be wrong. For every "Left as is" line in Decisions and every line of the scope check, open the code it names and read it again: does the case exist, and is today's result what the line says? Correct a line that is wrong, delete one whose case does not exist, and add a place to one that has none. Only checked lines reach the gate and the PR.
5. Row `blame | blocked`, note "waiting at the gate" and how many notes the check corrected, `status: blocked`, commit `<TICKET> [blame] <protected or not, test project ok or not>`.
6. **The gate.** Three lines:
   1. Where the bug is and what you will touch. If the Plan adds a test project, say it plainly: "<project> has no tests yet, so I'll add a small test project for it."
   2. What you decided: the cases that change, in plain words, from the scope check.
   3. What you are unsure of. If a comment protects code you will change, quote it and say why the change goes against it.
   Then: "Yes = I'll fix it, test it and open the PR, and won't ask you anything else. Or tell me what to change."
7. **The answer.** Record it under Open questions as given, ticked.
   - **Yes**: `status: in-progress`, append `blame | done` with "gate: yes", commit, go to test. From here on, no questions (see the rules).
   - **Yes, but no test project**: remove that Plan line and add "verify by hand" plus the exact manual check (what to open or call, what the right result is) as the last Plan line. Then as yes.
   - **Anything else** is a change request: change the Plan, Blast radius and scope check to match, append a `find` row "revised: <what changed>", commit, and run this step again from 1 for the files that changed. Then the gate again.
   - **The behaviour is deliberate, don't change it**: the task **closes with no change**. Write the explanation under Changes and Decisions, set `status: closed`, commit `<TICKET> [blame] closed, behaviour is deliberate`. Print Changes and Decisions as the text for the ticket comment. Then `git rm` the working file, commit `<TICKET> [close] working file removed`, and stop. No PR.

## Step: test

Goal: pin what must not change, and prove the bug (§10). The framework has no opinion on test tooling: use what the repo uses, placed where its tests already live.

**Existing suites may be unfinished: skipped tests, placeholders, tests already failing, thin coverage. Leave them as they are.** Never un-skip, complete, rewrite, fix or delete a test you were not asked about. Only add new tests for the behaviour this change touches. Filling in the rest is a project, not a fix (§10).

0. If the Plan adds the first test project: create it with the stack's own tool, targeting the same framework and version as the project under test (see the machine rule), reference the project under test, add it to the solution or workspace, and append `{ "path": "<its folder or the solution's>", "command": "<its test command>" }` to `.framed/config.json` `tests`. All of that goes in this step's commit. Record it in Decisions. If it cannot be created (the install fails, the tool is missing), undo what it left half done, switch the Plan to "verify by hand" with the exact manual check, add "For the reviewer: the test project could not be created (<first error>); the fix is verified by hand" to Open questions, and continue. If the Plan says "verify by hand", write no tests: Evidence gets "No automated test: to verify by hand: <the exact check>" in place of both lines, row `test | done`, note "no tests: manual verification", commit, go to fix.
1. Find the nearest existing tests to the touched files; copy their style, fixtures and location. If the test project has no tests yet, follow the framework's default layout for that runner.
2. Write **characterization tests** for the surrounding behaviour that must keep working. They must pass now.
3. Write **at least one failing test for the bug**. It must fail now, for the right reason. Run it and read the failure. If the same cause has an obvious sibling case, one more test is fine.
   **Evidence, before.** Under the working file's Evidence, "Before the fix:" gets the bug test's full name and the runner's own lines that say what was expected and what came instead, copied as printed, in a code block, at most about 10 lines. If the test cannot run on this machine: "Before the fix: not run on this machine: <why>". Never write output that no run printed.
   Making a function reachable for tests (an export, an internal visibility change) is allowed in this step; note it in Decisions.
4. Run the tests you wrote, from the folder of the `tests` entry that contains them, narrowed to them if the runner allows it (e.g. `dotnet test --filter`, `npx jest <path>`, `npx vitest run <path>`); otherwise run that entry's command.
5. Row `test | done`, note what was pinned and what fails, commit `<TICKET> [test] <n> characterization, 1 failing for the bug`.

## Step: fix

Goal: the Plan, and the dependents.

1. Make the change. Keep to the Plan and its scope check. If the Plan turns out wrong in a way that stays inside the ticket, change the Plan first and say so in Decisions. If the only fix would change a case the ticket does not describe, do not make it: stop as blocked (see the rules) and report why.
2. **Confirm every dependent's verdict.** Each `check at fix` becomes `updated` or `no change` plus why. A dependent you had to change is appended to `touches:` as `<file> (added at fix)`. The step cannot end while a dependent has no verdict.
3. **Revert check**, before committing anything: `FRAMED reverts`. It compares the uncommitted change with the last 12 months of history.
   - Exit 0: the change puts back nothing that was recently removed. Continue.
   - Exit 3: the change puts back lines a recent commit removed. That removal may have been deliberate, whatever its message says. Do not stop. Add to Open questions: "For the reviewer: this fix puts back code removed on <date> (<sha>): <the lines>. Was that removal deliberate?" Note it in the row, and continue. The PR opens as a draft.
4. Run the tests from the test step: the bug test now passes, the characterization tests still pass. If the bug test still fails, try again within the Plan; if it cannot be made to pass, stop as blocked and report.
   **Evidence, after.** "After the fix:" gets the same test's passing line and the runner's summary line (counts), copied as printed, in a code block. Not run here: "After the fix: not run on this machine: <why>", the same reason as before.
5. Append to Changes, in plain words, for the reviewer. Append any judgement call to Decisions.
6. Row `fix | done`, commit `<TICKET> [fix] <what changed, one line>`.

## Step: suite

Goal: did anything else break.

1. `FRAMED suite <every file in touches:>`. It lists the test commands to run: every project the change touched, plus every project the scan links to those, each with the reason it was picked. If a touched file is outside every project, it lists all of them. If it lists nothing, the repo has no unit tests and the fix is verified by hand: row `suite | done`, note "no unit tests; to verify by hand: <the manual check from the Plan>", commit, go to pr. The PR must say the change was not tested automatically.
2. Run each listed command in full, from its folder. Nothing narrowed. Record each in the row note as "folder: passed/failed (why it ran)".

   **Except when the config has `testSelection: "coverage"`** (a suite too big to run on every fix, §10). Then, instead of the full commands:
   - `FRAMED tests run --base <defaultBranch>`. It picks the tests by what they really run (tests that run a changed file, tests whose recorded files changed since, tests with no record, changed tests), runs each with coverage and re-records it, and prints what passed and failed.
   - Exit 3 means the map can't vouch for this change (settings, data, dependencies, startup, test setup changed, or there is no map yet): run the full commands as in step 2 instead.
   - If `.framed/testmap.json` doesn't exist yet, the first time: run `FRAMED tests baseline` once before this step (it runs every test file once; it can take long, and it resumes if interrupted). Tests that fail in the baseline are already failing: list them under Changes, as in step 4.
   - A selected run is never "suite green". Note "ran <n> of <total> test files, picked by coverage: <why, in short>", and add to Open questions: "For the reviewer: only the tests picked by coverage ran here; the full suite must pass in CI before merging." The PR opens as a draft.
   - A dependent from the Blast radius that no recorded test runs is named in that same item as unchecked.
3. All green: row `suite | done`, note the counts if the runners print them, commit `<TICKET> [suite] green`.
4. **Any red: first find out whether those tests were already failing before this change.** An unfinished suite often has tests that fail on the default branch too. Those are not this change's fault, and they must not block it.
   - Write the row first: `suite | running`, note "checking whether <tests> failed before the change; touched files temporarily at base". If the session dies here, resume must restore the files.
   - `git merge-base HEAD <defaultBranch>` gives the base. For each touched source file that existed at the base, excluding the test files this task added or changed: `git restore --source=<base> --worktree -- <file>`. That changes the working tree only, never the index, so nothing reverted can be committed by accident.
   - Rerun only the failing tests, narrowed.
   - Restore: `git restore --worktree -- <the same files>`, then confirm `git status` shows only the working file changed.
   - Tests that also fail at the base are **already failing**. List them under Changes as "Already failing before this change, not touched: <names>" so the reviewer knows. They don't block.
   - Tests that pass at the base and fail with the change are **caused by this change**. Continue below with only those. If there are none, the step is green: go to 3.
5. Red caused by this change. Read each failing test:
   - **A dependent the fix broke** (the dependent should have been `updated`): one more round is allowed. Append a `fix` row for that dependent alone, inside the ticket's scope, then a new `suite` row. If it is still red after that round, treat it as below.
   - **A test that pins the old behaviour**: that is evidence the behaviour was deliberate. Do not change, skip or delete the test. Add to Open questions: "For the reviewer: <test> expects the old behaviour (<what it checks>). Was that behaviour deliberate? If so, the fix needs another approach."
   Row `suite | failed` with the test names and your reading of each, commit `<TICKET> [suite] failed: <tests>`, go to pr. The PR opens as a draft.

## Step: pr

Goal: deliver, and leave the record in the PR, not in a file. No gate: the yes at the gate covered this.

1. **Draft or ready.** The PR is a draft when Open questions has any unticked "For the reviewer" item, or the suite step ended failed. Otherwise it is ready for review.
2. PR title: `<TICKET>: <title>`. PR body, in this order: the unticked "For the reviewer" items first, under "Needs a reviewer's decision" (only if there are any), then Task, Changes, Evidence (the bug test failing before and passing after, as copied), Decisions, Blast radius (touches and dependents with verdicts), and the Steps table. That is the working file collapsed.
3. Read the remote: `git remote get-url origin`. If it is an `https://` or `ssh` URL, `git push -u origin <branch>`. If it is a local path or there is no remote, do not push; record "not pushed: <reason>" for the row.
4. Open the PR by host:
   - `github.com`: `gh pr create --base <defaultBranch> --head <branch> --title "<title>" --body-file <tmpfile>`, plus `--draft` for a draft.
   - `dev.azure.com` or `visualstudio.com`: `az repos pr create --source-branch <branch> --target-branch <defaultBranch> --title "<title>" --description @<tmpfile>`, plus `--draft true` for a draft. For a numbered ticket, add `--work-items <number>` so the PR is linked to the work item. The PAT comes from the environment the Azure CLI reads (`AZURE_DEVOPS_EXT_PAT`); never write a token into any file.
   - Anything else, no push, or the CLI is missing or fails: print the title and body and tell the user to open the PR by hand, and whether as a draft. That is not a failure of the task.
5. Row `pr | done`. Note: the PR URL and "draft" or "ready", or "opened by hand: <reason>". `status: done`. Commit `<TICKET> [pr] <url or "opened by hand">`.
6. `git rm .framed/tasks/<TICKET>.md`, commit `<TICKET> [pr] working file collapsed into PR`. Push again only if step 3 pushed. The PR description is now the record; nothing piles up.
7. Tell the user in a three-line card: the PR link (or where the title and body are) and whether it is a draft; what changed; what the reviewer should look at first, including every "For the reviewer" item.

## Not in v1

Tiering and escalation, budgets on every step, the decision log, map reconcile after the change, lessons loop. If the task turns out to be bigger than a patch (many files, a shared contract changing), say so on the gate card and let the user decide; do not grow the plan quietly.

Tokens per step: Claude Code does not expose token use to a skill, so the working file has no tokens column in v1 (§17).
