# AI Dev Workflow Framework — Design Doc (draft 1)

Working name: TBD
Date: 2026-10-19
Status: brainstorm consolidated, nothing built yet

---

## 1. What this is

An AI-assisted development workflow (same genre as BMAD, Kiro, cc-sdd) that works on **existing codebases first** and new projects second. One framework, one set of steps, two ways in: brownfield extracts a map from the code, greenfield writes a map from a plan.

The pitch in one line: **the code is the spec, the map is how the agent reads it, and every step ends on its own.**

## 2. Pain points this solves

From actually using BMAD/Kiro at work:

1. Existing frameworks assume greenfield. Brownfield is an afterthought.
2. Legacy code has no tests, or partial tests. Frameworks either ignore that or try to rebuild coverage from scratch.
3. No PR/branch/commit flow built in.
4. Same heavy process for a one-line bug fix and a big feature. Either wastes time on small stuff or shortcuts big stuff.
5. No way for a non-coder user to go back to a known-good point.
6. Too many files generated.
7. No clean way to migrate from another framework.
8. Generated files nobody reads. You click "yes" without looking and they pile up.
9. Steps that don't end (BMAD brainstorm runs until you stop it). Bad when you only get a few sessions.
10. Quality has to be high but tokens have to be low. Can't have both perfectly, so it has to be sized.
11. Bug fix creates three more bugs because dependent parts weren't updated.

## 3. Principles

- **Ask only what the code can't tell you.** Scan first, ask the gaps last.
- **The map is never trusted, it's reconciled.** Compared against reality after every step.
- **Every step ends on its own.** Hard budget + exit rule. The default stops; the user can extend. Never the other way round.
- **An artifact exists only if something consumes it.** A later step reads it or a human gate shows it. Otherwise it's a log line.
- **Size the process to the task.** Patch ≠ feature ≠ epic.
- **Coverage follows the work.** Tests get written where you touch, not everywhere up front.
- **Git is the versioning.** No separate versioning system. Commit per step.
- **Gates talk to a person.** Every human review reads like a message, not a diff.
- **Hooks, not prompts, for hard rules.** Prompts get ignored.

## 4. The spine

```
map  →  tier  →  budgeted steps  →  working file  →  PR
```

- **Map**: what the agent reads instead of the repo.
- **Tier**: how big the task is → which steps run.
- **Budgeted steps**: each step has a budget and an exit rule, commits when done.
- **Working file**: one file per task, holds all task state, is the checkpoint.
- **PR**: the delivery and the permanent record.

Five concepts. Not twelve personas.

## 5. The map

### Purpose
Answers one question: *what does an agent need to know to make a safe change here without reading the whole repo?*

### Two ways in
- **Brownfield**: extracted from the code. Code is truth, map is summary.
- **Greenfield**: written from the PRD. Map is intent, code catches up. The "architecture design" step on greenfield *is* writing the first map. There is no separate architecture doc.

A greenfield project that's 6 months old is just a brownfield project whose map was kept current.

### How it's built (brownfield init)
Three mechanical sources, scripted, no model, seconds to a minute:
1. **Static references** — imports/usings/call sites via the language's own tooling (Roslyn for .NET, tsc/project graph for TS, madge-style for JS). Catches the obvious ~50%.
2. **Git co-change** — files that repeatedly change in the same commits (last ~200 commits). Catches hidden runtime/convention dependencies static analysis misses. Free.
3. **Tests as evidence** — a test touching A and B is a dependency A↔B. Also reveals what has no tests.

Then **one model pass** over the resulting graph: name modules in plain words, flag suspicious bits, mark gaps as "unsure". Budgeted. First version is one page and is allowed to stop.

**Two levels, learned on the first real repo (6k files).** The file-level graph is thousands of nodes and can't be a page, but the blast-radius check needs it file by file. So:
- **scan** (`.framed/scan.json`) — the file-level graph: every file with its module and language, every edge with its source, a per-file "a test touches this" flag. Mechanical, seconds, regenerable, gitignored. Readers: the model pass (through `framed map summary`, a few hundred lines) and the blast-radius check.
- **map** (`.framed/map.md`) — the module-level page the model writes. Committed. Sections read by heading: What this is, Modules, How they connect, Watch out (hubs, hidden dependencies, least tested, isolated), Unsure, Hand-maintained.

**Module** = nearest folder with a `.csproj`, `project.json` or `package.json`; otherwise the top-level folder (docs, data, scripts: listed in one line, not mapped). A project file inside a dot-folder such as `.vite` or `.next` is committed tool output and does not make a module. **Large modules are split**: one with more than 300 code files (a Rails or Django app, which has no project file below the root, or one big .NET or Node project) is divided by its subfolders, again for each part still over 300. A subfolder with fewer than 30 code files stays in its parent, and a wrapper folder holding nearly all the code (`src/`) is stepped through. Parts are named by path, e.g. `app/models`, `MyApp.Application/RequestHandlers/Orders`.

**Static references in v1 are pattern-based**, not language tooling: C# `using` lines resolved through a namespace + type-name index plus csproj project references, and a C# file only sees types in its own project and the projects it references, as the compiler does (otherwise a class name several projects each declare, like `Extensions`, links them all); TS/JS `import`/`require` resolved with extension, index and `tsconfig` `paths` rules. Other languages get no static edges and are flagged. Measured against dependency-cruiser on one 1,100-file library: 98.9% of its edges found; the extra edges were type-only imports, which are skipped on purpose (they can't break at runtime). Edge tag is `static/regex`; a tool-resolved edge would be `static/depcruise` or `static/roslyn`, so a reader knows a guess from a resolution.

**Co-change tuning**: last 1,000 commits (200 was three weeks on a busy repo), commits touching more than 30 files skipped (bulk moves and merges link everything to everything), edge when a pair changed together 3+ times. Co-change and test edges have no direction; static edges do.

**Tests**: a test touching more than 10 source files still marks them tested but adds no pairwise edges; those grow quadratically and are weak evidence.

### Dependency section — source column
Every dependency records where it came from: `static` / `co-change` / `test` / `manual` / `learned`. Tells the agent how much to trust it. The section is read as "check these", never "only these".

### What it won't catch on its own
Cross-repo (separate frontend calling this API), DB-level logic (triggers, stored procs), config-driven behaviour, and **frontend-to-API calls inside one repo** (a portal calling a controller by URL: no import, so invisible to static; co-change catches some). These go in by hand on day one, in a clearly marked hand-maintained section. DB scripts checked into the repo do show up for co-change.

### dependency-cruiser (v2, optional static source for TS/JS)
Tried on the first repo: not installed, registry slow, choked on the tsconfig when run from the wrong folder, ran nine minutes and out of memory on a 2k-file portal, needed an 8GB heap for one library. Not a drop-in. If added later: tag edges `static/depcruise`; on any error log why and fall back to regex, never fail init; lookup order `node_modules/.bin/depcruise`, then a **pinned** npx version, then regex; exclude `node_modules`; skip type-only imports; emit orphans and cycles in framed's own shape, not the cruiser's; and diff the two edge lists on the same repo to get a real miss number before relying on it. Same rules for a Roslyn source on the C# side.

### Maintenance
- Never rebuilt in full after init.
- After every step that touches code, a cheap reconcile checks only the files in the diff against the map and updates it. Seconds.
- **Lessons loop**: every time a surprise dependency bites in a PR, it gets added (`learned`). Map gets smarter from bugs.
- **Big repos**: lazy mapping. Init maps the top level only (big chunks, how they connect). A module gets mapped in detail the first time a task touches it.

### Time
Init: a few minutes, scales with repo size, lazy for huge repos. Per task after that: seconds.

### Limits (be honest in the docs)
The map answers "what *might* be affected". Tests answer "*was* it affected". You need both. Map without tests is a confident guess. Target: ~70% of dependencies from the three mechanical sources, climbing to 85%+ via lessons loop.

## 6. Tiering

Intake step classifies the task. Suggested tiers: **patch / change / feature / epic** (names TBD). Each tier runs a different slice of the pipeline.

- Patch: find → blame → **one gate** → characterization test → fix → run tests → PR. The person answers once, at the gate; the PR review is the next time a person looks (§9).
- Epic: full planning (mini-PRD for the epic, map update, breakdown into changes) then each change runs its own slice.

Rules:
- Agent **proposes** the tier **with evidence** from the map ("touches 2 files in billing, no shared contracts, I'd call it a patch"). Human confirms.
- Tier can **escalate mid-task**. "Small fix" that turns out to touch 12 files bumps to a change and the extra steps kick in.
- Blast-radius check uses the map's dependency section: pull dependents of X and give each a **verdict** — updated, or no change plus why. Runs twice: **proposed at find** (so the test step can cover dependents that will change), **confirmed at fix**. Fix can't end while a dependent has no verdict. A dependent that needed changing is appended to the touched files with the step it was added at.

## 7. Steps and budgets

- Every step has a **hard budget** (turns, tokens, or N questions max) and an **exit rule**.
- When budget runs out the step does not keep going. It writes "here's what I have, here's what's uncertain" to the working file and hands off. Uncertain items become open questions for the next step or the human.
- Every step is **resumable** from its written state. Session dies → reopen working file → continue, not restart.
- **End of every step, however it ends (done, failed, blocked): update working file, commit.** A failed step that doesn't commit loses the failure note, the most valuable line in the file. Message carries step name + task id. "Undo the last step" = checkout that commit, in plain words for a non-coder.
- Steps show their own budget ("round 3 of brainstorm, PRD stable except auth question") so the user can see circling and stop.

## 8. Artifacts

### Durable (outlive a task, live in the repo, versioned by git)
- `map` — see §5.
- `decision log` — one line per decision: what, why, PR link. Agent reads relevant entries before touching a module.
- `PRD` — one page. Required on greenfield. Optional on brownfield (code is the PRD). An epic may get a mini-PRD.
- `design.md` — the design a new app was started on in Studio (§19): its tokens, fonts, where they live, and the rules every later build follows (components use the variables, never a typed colour). Written by `framed:design`; patch follows it for UI changes.

Three files max on greenfield, two on brownfield (design.md is the third on greenfield).

### Working file (one per task)
Holds: task (with the reported cases), blast radius (touched files + dependents with verdicts), plan, open questions (answers recorded as given, not summarised), step log, decisions, changes so far, evidence (the bug test's runner output, failing before the fix and passing after). Is the checkpoint. Collapsed into the PR description on merge, then deleted. Nothing piles up.

The step log is **append-only**: rows in execution order, a step can appear more than once (fix fails the suite, fix again), remaining todo rows stay at the bottom so "what's next" is visible. Statuses: todo / running / done / failed / blocked. Failed = the step ran and the result was bad. Blocked = the whole task is waiting on a person.

If the task **closes with no code change** (status `closed`, e.g. the reported behaviour turned out to be deliberate), there is no PR: changes and decisions go to the ticket comment instead, then the file is deleted. Same rule, different destination.

Template: `templates/working-file.md`. Lives at `.framed/tasks/<TICKET>.md` in the repo being changed. Frontmatter (ticket, title, tier, branch, status, step) is the only part the flow depends on (the page in §19 also reads the body, for display only); the active task is the file whose branch matches the current git branch.

(Open question: Ishi wanted to "see what we've done". Position: that lives in the PR + decision log + git log. If it still feels thin after trying, archive working files in a folder. Try without first.)

### Not artifacts
Brainstorm output (feeds PRD, no own file). Step logs. Anything with no reader.

## 9. Human gates

A gate is **not** "approve this file write". It's the step's output as a short card:
- what changed
- what it decided
- what it's unsure of (= open questions still unanswered at gate time)

Three lines, reviewed as a decision, not as markdown. Written for a non-coder: "I changed how invoices get totalled, it also touches the email that sends them, tests pass, want me to open the PR?"

**A gate asks one question, and the agent settles everything it can before it.** The ticket is the scope: a fix changes only the behaviour the ticket asks about, and leaves everything else as it is, even what looks stale or wrong. What it notices beyond that is reported to the reviewer as "Left as is: …, outside the ticket", not asked. The unsure line is information. A real question reaches the user only when the ticket doesn't say what should happen in a case the change affects, the evidence conflicts, or a comment says the code is deliberate. Found in the first real replay: the agent offered to widen a fix to a case the ticket never mentioned and asked about it; the team's actual fix had left that case alone. Each "Left as is" note names its place in the code, and before the gate the agent reads the code again for every note and every case of the scope check, correcting or dropping what is wrong (added 2026-11-06: one note in the first replay described a case wrongly, and a wrong note reaches the reviewer as fact).

**One gate per task, before any code changes; after it, nobody is asked.** The patch flow gathers everything that needs a person before the gate: where the bug is, the blast radius, the cases that change, comments that say the code is deliberate (the blame check runs before the gate, not after), and whether the existing test project runs. A "no" is a change request: the plan is revised and the gate shown again, as many rounds as it takes. A "yes" means fix, test and open the PR with no further questions. What turns up after it and needs a decision (re-added lines, an existing test that now fails because of the change, a test project that could not be created) is written as "For the reviewer: …", goes first in the PR, and the PR opens as a draft. The PR review is the second time a person looks; nothing merges without one. After the gate the agent also never changes the machine to get past an environment problem (drive mappings, global installs, runtime switching) and never changes the repo to suit the machine (a test project targets the project's own framework): what cannot run here is written, committed, and named for the reviewer, and the PR is a draft. Found in the second replay, which mapped a drive with `subst` and retargeted the first backend test project to .NET 10 because the machine lacked .NET 9, then marked the PR ready. Why: the point is to automate the workflow; a person who has to answer at every step is doing the workflow by hand.

## 10. Tests

- Framework has **zero opinion on test tooling**. Discovers the existing runner (xUnit, Jest, whatever) and uses it. Never imposes a suite, never converts existing tests.
- Framework's only opinion is **when**: characterization tests on the touched area *before* the change, full existing suite *after*. The test step writes two things: characterization tests of the surrounding behaviour that must keep passing, and **one failing test for the bug**. Characterization alone would pin the bug as correct.
- **The bug test is the PR's evidence** (added 2026-11-06). The runner's own output for it goes in the PR description: failing before the fix (expected vs got, e.g. "expected 409, got 200"), passing after. Copied as printed, never written from memory; when it can't run on this machine the PR says so instead. Every fix carries proof that the bug happened and no longer does, with no app needed. Showing it in a running app (API calls, screenshots) is later work, only where the repo can run here.
- **"Full existing suite" on a repo with several projects** (a .NET backend and three JS front ends, each with its own runner, was the first real repo): run the suite of every project the change touched, plus every project the scan links to those (static imports, or co-change/test links seen 3+ times). A touched file outside every project runs them all. `framed suite <files>` does the selection; when unsure it runs more, never less. Suites that need a running app (end-to-end, performance, UI automation) are not part of it.
- Full-coverage backfill on a legacy codebase is a project, not a framework step. Not in scope.
- **"Never imposes a suite" means never converts, rebuilds or replaces existing tests.** It does not forbid the first test. A repo with no unit tests at all (the second real repo: two .NET solutions with no test project, an Nx workspace with no test runner, only a Playwright suite against a deployed environment) gets this: config `tests: []`; the first fix in a project with no tests proposes, at the gate, the smallest test project for that stack and adds it to config in the same commit. When another project of the same stack in the repo already has tests, it copies that one's tool and setup (runner, version, assertion and mocking libraries, layout: Vitest next to Vitest, xUnit next to xUnit), so a repo never ends up with two tools for one job (agreed 2026-11-06). Only when there is none, the stack's standard (`dotnet new xunit`, the workspace's own generator, Vitest for a plain package). Only where the change touches. If the person says no, the fix is verified by hand, written down as an exact check, and the PR says it was not tested automatically. That is "coverage follows the work".
- **Detection proposes a runner only where one really exists.** A solution file or an Nx workspace is not a test suite: a `.sln` counts only with a project referencing a test framework, an Nx workspace only with a test target, plugin or test config (a `vite.config` only if it configures Vitest). Suites that need a running app are reported as skipped and never used as the unit suite, even when they are the only tests.
- **A suite too big to run per fix: pick tests by what they actually run** (added 2026-11-03). Opt-in (`testSelection: "coverage"`), for repos where the full suite takes too long to run on every fix. Small repos keep running everything.
  - **Once, at the start:** run every test file once with coverage. That records which source files each test file executes (`.framed/testmap.json`, local, never committed) and which tests already fail, listed once so no fix is blamed for them. Coverage sees what imports can't: dependency injection, reflection, routes reached by URL, event handlers. Any path a test really runs.
  - **Each fix, the tests that run:** every test that touches a changed file; every test that touches any file changed since its own entry was recorded, by anyone, merges included (it is re-recorded, because a test can only start reaching new code if code it already runs has changed); every test with no entry; every changed test file.
  - **The whole suite runs when the map can't be trusted:** a change to something that isn't code but changes behaviour (config and settings, `.env`, SQL and migrations, dependency manifests, project files), to app startup (`Program.cs`, `Startup.cs`: dependency registration lives there), or to shared test setup.
  - **Tried for real** on a small Vitest project: someone else's merged change made `invoice.js` call `price.js`; the next fix changed `price.js`; framed ran the price and invoice tests (the second because `invoice.js` changed since it was recorded), skipped the unrelated one, and the invoice test's record then included `price.js`. Commands: `framed tests baseline | select | run | command | record`. In the PR, like every other result.
  - **Honest in the PR:** "ran 412 of 180,000 test files' tests, chosen by coverage; the full suite must pass in CI before merging", and the PR is a draft until it has. Never "suite green" for part of a suite.
  - **No nightly runs.** A failure nobody looks at is no check. Entries refresh during fixes, and a full run happens inside a fix whose PR someone reviews.
  - **Limits, said plainly:** coverage only knows what tests run, so a dependent no test covers is named in the PR as unchecked; it doesn't see behaviour driven by data outside the code, which is why those changes run everything.
  - Recording per test file needs the runner's own coverage: Vitest and Jest (lcov), .NET (coverlet's Cobertura, per test class), pytest with pytest-cov. Other runners keep running the whole suite.
- **Unfinished suites are left as they are.** Skipped tests, placeholders, thin coverage, tests already failing: framed never un-skips, completes, rewrites, fixes or deletes a test it wasn't asked about. When the suite goes red, it first checks whether the failing tests also fail at the base commit, with the touched source files temporarily restored in the working tree only (`git restore --source=<base> --worktree`), never the index. Already-failing tests are listed in the PR and don't block; only failures caused by the change do. A test project that doesn't build before the change is a question, not something to fix quietly.

## 11. Why / dependencies / "don't undo what was deliberate"

Four needs, four homes. No mandatory comments.

1. **Why a change was made** → commit message + PR, with the ticket key or number. Zero files, never piles up.
   **But messages are context, never evidence** (learned on the first real repo: most commits said "fix", and one PR title covered several unrelated changes). Whether lines were deliberate is decided by evidence in the code, at three points:
   - **blame step** (`framed why <file> <a>-<b>`): a comment in or right above the block that explains *why* — a reason, a rule, an order that matters, a "keep"/"must"/"do not". Then stop and ask. Generated doc comments (`<summary>`, `@param`) don't count; neither does a comment that only labels what the code does. The recent commits that touched the block, with what each actually changed there and the merge that brought it in, are shown as context.
   - **fix step** (`framed reverts`, before committing): the change puts back lines a commit in the last 12 months removed. That is undoing someone's work, whatever its message says. Stop and ask, showing that commit's diff. Lines moved within one commit, a single short line in common, and removals older than 12 months don't count.
   - **suite step**: an existing test fails because it pins the old behaviour. That is evidence the behaviour was deliberate; ask "was it?", never "may I update the test?".
2. **What depends on what** → the map. One place, kept current.
3. **Decisions that'll bite later** → decision log.
4. **Comments** → only for load-bearing code that looks wrong but isn't. `// PROJ-412: billing must run before audit log, order matters`. Short, rare, not mandatory. Rule: comment when the next person would otherwise "fix" it.

## 12. Greenfield intake

Order: brainstorm (optional) → PRD → map → first task.

### Brainstorm — draft-first, opt-in, capped
Off by default. If on:
- **Round 1 — draft**: user gives one line. Agent immediately writes a one-page draft PRD with assumptions filled in and marked as assumptions. User reacts/corrects. (Correcting a draft beats answering from blank.)
- **Round 2 — poke holes**: agent lists 3 biggest risks or 2 alternatives, one line each. User picks or ignores.
- Ends on its own. User can say "another round" as many times as they want. Each round shows the count and what's still unstable.
- Output is a paragraph that feeds the PRD. No own file.

### PRD — one page
What it is, who it's for, what it must do first, what it must not do, open questions. Anything more becomes tasks later.

### Questions (if no brainstorm) — five, one screen
What is it / who uses it / stack (or "pick for me") / the one thing it must do first / anything it must not do. No follow-up rounds unless an answer was empty.

### Architecture = first map
Modules, how they talk, stack, where tests go. Maintained as the map from then on.

## 13. Brownfield init

Order: scan → map → ask gaps → work.

- Scan + map: §5. Runs as `/framed:map`. Init has no ticket, so the map and config land on the fixed branch `framed-init` and reach the default branch by PR like everything else. The guard allows two branch names without a ticket in them: `framed-init`, and `framed-design` for a Studio build with no ticket (§19).
- **Gap questions, 2–3 max, asked after the scan, detect-then-confirm.** `framed detect` reads the repo's own conventions and proposes, with evidence:
  - test commands, one per project, from the files there (`.sln`/`.slnx` by the test projects they list, Nx workspace, `package.json` test scripts, `pyproject`/`go.mod`/`pom.xml`/`Cargo.toml`/gradle, `Gemfile` with rspec or minitest, `composer.json` with phpunit or pest); suites that look like they need a running app are listed as skipped. Test files that no detected runner covers are listed too, and setup asks for their command: a language framed has no rule for still gets its tests run;
  - ticket prefixes: every key seen on 5+ distinct tickets in branch names and the last 500 commit subjects (a team can have several boards). Numbered tickets (GitHub issues, Azure Boards work items) count too, as the entry `#`: a branch segment that starts with a number, `AB#1234` or "fixes #1234" in a commit, never a pull-request number like `(#1234)`. Nothing found: setup asks where the team tracks work;
  - branch pattern: what usually precedes the ticket key in existing branch names, preferring a bug-fix folder for patches (`bugfix/{ticket}-{slug}`). If under a fifth of branches carry a key, the repo has no convention and framed uses its own (`{ticket}-{slug}`);
  - default branch from `origin/HEAD`.
  Then: "are these right?", "anything I shouldn't touch?". One message, no follow-up rounds. Written to `.framed/config.json`; the other fields take defaults.
  Rule against overfitting: framed never hard-codes a repo's conventions; it detects them per repo and asks. A rule that only makes sense for one repo doesn't go in.
- **Migrating from another framework**: detect `.bmad/`, `.kiro/`, `.claude/`, `docs/prd.md` etc. Read them as input to the map (there's real knowledge in there). Then list what's left over and offer "delete these?" — one confirm, user doesn't do it by hand. Never auto-delete.

## 14. Config file (per repo, tiny)

- test commands, one per project (`tests: [{ path, command }]`)
- branch pattern (`branchPattern`, e.g. `bugfix/{ticket}-{slug}`)
- default branch
- Jira/ticket key prefixes, one per board (`ticketPrefixes`); `#` for numbered work items or issues (branch `bugfix/1234-…`, commits `#1234 [find] …`, Azure PRs linked with `--work-items`)
- model per step (cheap for scan/tests/PR body, expensive for plan/code). In a Claude Code plugin only subagent steps can pick a model; inline skill steps run in the session's model. v1 has one: `models.mapPass`, an alias the Agent tool accepts (`sonnet` default). The scan itself is a script and uses no model.
- protected paths
- brainstorm default on/off
- budgets per step (defaults provided)

## 15. Git guardrails (hooks, not prompts)

- Never push to main/default branch.
- Never force push.
- Always a branch named after the task.
- Delivery is PR only.
- Commit at end of every step.

Enforcement: the first four are a PreToolUse hook on the shell tools, Bash and PowerShell (`hooks/hooks.json` → `framed.js guard`; on Windows a session may have only PowerShell, so a Bash-only hook guards nothing there). PowerShell commands are read with its own escape (the backtick; a backslash is a path), and `& git …` and `git.exe` count as git. It blocks: push to the default branch (any refspec form, `--all`, `--mirror`, pushing while on it); any force push (`-f`, `--force*`, `+refspec`); commit-creating commands (`commit`, `merge`, `cherry-pick`, `revert`, `am`) on the default branch or on a branch with no ticket in its name; creating a branch with no ticket in its name. "Ticket in its name" = some path segment starts with `<PREFIX>-<n>` for one of the configured prefixes, or with a bare number when `#` is configured (`release/2.0` is not a ticket), so the repo's own convention (`bugfix/PROJ-4840-…`, `feature/admin/PROJ-12_v2`) passes as well as framed's. The exact shape framed creates comes from `branchPattern`. Without a config it still blocks pushes to main/master and force pushes, and skips the branch-name rule.

The fifth, commit at end of every step, is **not hook-enforceable**: a hook can block a command, it can't make one happen. It lives in the step skills (§7).

Limits: hooks guard the agent, not a person typing git in a terminal. The guard parses the command line, so it covers the normal forms and common disguises, not every exotic shell construction.

## 16. Failure paths (define each, don't let the agent improvise)

Before the gate, every one of these: stop → write what happened in the working file → ask. After the gate nobody is asked (§9): a path that needs a decision becomes a "For the reviewer" item and a draft PR; a path that cannot continue at all stops and reports, and "continue" resumes it.

- Tests fail after the fix: the bug test that won't pass stops and reports; an existing test now failing because of the change is a reviewer item (§10), after one extra fix round when it is a dependent the fix broke.
- Budget runs out mid-step.
- Can't find a test command. (A repo with no unit tests is not this: see §10.)
- Test project doesn't build or run before the change: checked before the gate; the plan puts the new tests in a new test project and the gate card says why.
- Suite red: first check which failures already happen at the base (§10); only failures caused by the change stop the task.
- Map says X depends on Y, Y doesn't exist (map is stale → reconcile, then continue or ask).
- Deliberate code in the way (§11): a comment explaining the block (caught at blame, before the gate; the task may close with no code change, see §8), or the fix putting back recently removed lines (caught at fix, after the gate: a reviewer item and a draft PR).
- Tier escalation triggered.
- Session dies mid-step (→ resume from working file).

## 17. Tokens

- Map instead of re-reading the repo: biggest saver.
- Tiering: patches never run planning steps.
- Budgets: steps can't run away.
- Cheaper model for mechanical steps, expensive model only for planning + code change.
- Tokens per task and per step, shown on the page (§19), not in the working file. Claude Code does not give a skill its token use, so they come from the session transcripts on this machine: every reply records its tokens, time and git branch. A task's tokens are the replies on its branch (subagents included), split into steps by the times of the step commits. The transcript format is undocumented and can change in any release, so this is read defensively: if it can't be read, the page says "tokens: not available" and nothing else changes. Replies before the task branch exists are not counted. This also gives tokens per task for §21.
- Context left and plan usage (5-hour and weekly limits) come from the status line input, which is documented. A plugin can't ship a status line, so turning the page on adds one to the person's own settings, with their OK (§19).

## 18. Host

- **Claude Code plugin, fully working.** Mapping: map builder = subagent, tiering/intake = slash command, gates + git rules = hooks, step prompts = skills.
- **Cursor / Copilot: nice to have, not a must.** Keep the brain in plain markdown + one small node script. Plugin is a thin wrapper, so porting = another wrapper, not a rewrite. Hooks won't port; markdown will.
- **No slash commands needed.** Users don't type them. A SessionStart hook runs `framed status --hook` once per session (startup, resume, clear, compact). It shows the person one line about where the repo stands and gives the model the next action, so the person just says what they want in their own words:

  | state | told to the person | the model then |
  |---|---|---|
  | not a git repo | nothing | — |
  | no code (greenfield) | no code yet: pick a look in Studio, save it, say "build my design" | runs framed:design on that; never map or patch |
  | code, no setup | say "set up framed" for a one-time scan | runs map on that, or on any bug request |
  | setup on unmerged `framed-init` | merge it, or work from that branch | never re-runs map |
  | setup present, config broken | the first config error | helps fix the config |
  | ready | "tell me the bug", with the ticket prefixes | runs patch on any bug, ticket or fix request |
  | task in progress on this branch | the ticket and step, "say continue" | resumes patch |

  Brownfield vs greenfield is detected (any code files = brownfield), never asked (§3). The common path reads `.git` and `.framed/` directly and spawns no git, because it runs at every session start: about a second, most of it Node starting.

## 19. UI — the page

Moved up from "later" (2026-11-02) once the spine worked end to end on two replays, so framed can be shown. `framed ui` serves one local page from `.framed/`, read-only except for Studio's one saved choice (below): the gate is still answered in the chat, and nothing to install. A sidebar switches between four pages: **Home** (the current fix, the map and the repo at a glance), **Build** (the fix's road), **Map** and **Files**. The address names the page and view (`#/files?module=<name>`), so Back works and a view can be shared.

- **Task: a road, not a bar.** The steps are stops on a winding road (find, why, the gate, test, fix, suite, PR). A marker moves along it as step commits land; each finished stop shows its note and tokens. The gate stays shut and pulses while it waits for the person. A fix that had to run again loops back. A hard stop shows a stop sign with the reason. "For the reviewer" items collect at the PR stop. After the PR the working file is gone from the tree, so the page reads it from the commit before it was collapsed and shows the finished road.
- **Map**: modules as bubbles sized by files, coloured by language; imports as solid lines, changed-together as dashed, thicker for stronger links. Read from `map.md`, which every clone has. During a fix the modules it touches glow (the working file's touches plus what the branch has changed) and the ones its blast radius reaches pulse, which needs file-to-module from the local `scan.json`; without it the map shows without the glow and says why. Click a module and the Files page opens on its files: the ones this task changes (and the new ones it created), the ones it may affect with the working file's reason, then every file as a folder tree with a search box. Click a file for its direct neighbours, drawn and listed: what it uses, what uses it, what changes with it in git, the tests that touch it. Never the whole module as a graph: a few hundred files drawn at once is a hairball nobody reads.
- **Tokens** (§17): per step and for the task, live.
- **Help** (added 2026-11-10): what framed does, how to start, the gate, how to read each page, the things to say, what framed never does, where its files live, and what to do when something's off. Written for a developer using framed for the first time. Contents on the side follow the reading (a row on a phone), a find box filters the sections, and every section has its own link (`#/help?s=gate`); Build and Map link into the part that explains them. Static text in the page; it describes only what framed does.
- **Opens by itself** when a fix, a setup or a Studio build starts (`framed page open`, called by the skills): it reuses this repo's running page, restarts one that is older than framed, or starts one in the background on the first free port from 4646, and opens the browser once per ticket, not on every resume; when the person asks for it, it always opens. A page with no tab open for 30 minutes stops itself (an open tab asks every 2 seconds; a running design scout keeps it up), so old pages don't hold ports and the next one gets 4646 again (added 2026-11-09). On by default; the person turns it off or on by asking in plain words (`framed page off|on`). That choice is theirs, not the repo's, so it lives in their home folder (`~/.framed/`), never in `.framed/config.json`. The session-start hook tells the model these controls.
- **Context left and plan usage** come from framed's status line (`framed statusline`), which Claude Code feeds the session's usage. It shows one line under the chat (the fix's step, context left, the 5-hour and weekly limits) and saves the numbers for the page's Claude usage card. Added to the person's own Claude Code settings only when they ask (`framed statusline install`), never replacing a status line they already have; `uninstall` removes only framed's.

The page reads the working file's body (steps table, plan, decisions) for display. It never writes it, and the skills don't depend on the page.

### Studio: pick a design, Claude Code builds it (added 2026-11-03)

A fifth page, **Studio**, for choosing how an app looks. Pulled forward from v2 at Ishi's call, so it is a design tier of its own, not part of patch.

- **Options.** Named styles that ship with framed (calm, editorial, bold, dense dashboard, …), each a full set of design tokens: colours for light and dark, a font pair, corner radius, spacing, shadow, motion. More come from the design scout agent, which writes `.framed/design/options.json`. It works from the named styles and the repo's own look; when it looks at real sites it keeps links for inspiration, never copies a site. In an existing repo the first card is the repo's current look, read from its code.
- **Pick and tweak.** Every colour of the palette, light and dark (text, quiet text, headings, background, cards, borders, accent and the text on it, success, warning, danger); heading and text fonts, from a list or any Google Font by name; text size and how much larger headings step up; corners, spacing, shadows, motion. Spacing and motion are sliders (added 2026-11-06): spacing runs from tight to airy, with compact, comfortable and roomy marked on it, and every padding and gap follows it; motion runs from none to lively and sets how long transitions take and how much they spring, replayed on the preview when it changes. The built app writes them as variables (`--spacing`, `--duration`, `--ease`) and stops motion for anyone whose system asks for less. All on a live preview of a sample app screen. A contrast check flags text that would be hard to read.
- **Refresh looks.** Not liking any of them, the person writes what they want and presses Refresh: the page starts the design scout in Claude Code's print mode (`claude -p`), allowed only to read, write inside `.framed/design/`, search and fetch the web, and run framed's own script. One run at a time; the page says it uses tokens and shows it working. The new looks arrive at the front of the cards. The same scout runs from the chat ("find more designs").
- **The page's writes.** "Use this design" saves the choice to `.framed/design/choice.json`; Refresh starts the scout, which writes `.framed/design/options.json`. Nothing else. Only a request from the page itself is accepted (a custom header, so another website can't post to it). Building starts in the chat ("build my design"), not on the page: the person stays in one place for decisions.
- **Existing repo (brownfield): consent first, theme layer only.** A restyle changes the theme layer (colour variables, the Tailwind or component-library theme, fonts), never every component. Before any change one gate shows exactly which files change and says what stays as it is; "no" changes nothing. Then a branch, the change, a PR, like a fix.
- **New project (greenfield): the choice is the foundation.** The tokens become `.framed/design.md`, a durable artifact (§8) that every later build reads, so the whole app is built on it. One gate first: the stack (React + Vite + TypeScript unless the person says otherwise), the token file, a first screen. Then scaffold with the stack's own tool, in the folder, never a global install.
- **Mechanical parts are the script's**: `framed design detect` (the current look), `choice` (the saved design, checked), `css` (the tokens as CSS variables, shadcn's names or framed's own), `hardcoded` (colours fixed in components, which a theme change can't reach and the gate names as left as is). The skill is `framed:design`.

## 20. Scope

### v1 (build this, nothing else)
- Map builder (3 mechanical sources + 1 budgeted model pass), brownfield only
- Working file
- One tier: patch
- Commit per step
- Blame check before edit
- Characterization test → fix → run suite
- PR creation
- Config file
- Git guardrails as hooks
- The page (§19), added for the demo
- Studio (§19): pick a design; restyle an existing repo with consent, or found a new one on it. Pulled forward from v2

Goal: fix a bug in an existing repo without breaking things, and actually use it at work.

### v2
- Tiering (all tiers, propose-with-evidence, escalation)
- Budgets + exit rules on every step
- Decision log
- Reconcile step + lessons loop
- Noise rules on the scan: see through barrel files, mark hubs and leaves, rate edges by source agreement, drop generated files, report orphans and cycles
- dependency-cruiser as an optional `static/depcruise` source (spec in §5)
- Greenfield intake (brainstorm, PRD, map-as-architecture)
- Migration from other frameworks

### Later / maybe never
- Cursor / Copilot wrappers
- Lazy mapping for monorepos (only if someone hits it)

### Not doing
- More agents / personas
- Plugin system
- Custom versioning
- Full-coverage backfill
- Imposed test suite
- Mandatory comments

## 21. How we'll know it's better

Two numbers, measured for a few weeks the normal way *before* building, as a baseline:
- regressions per PR
- tokens per task

Then the same two numbers with the framework. "Feels better" doesn't count.

**Map quality, measured (2026-11-04).** 21 public repos, 9 languages. The scan is built at an old commit (HEAD~60 or less), then scored on the commits after it: for each changed file, how many of the other files that commit changed did the map predict. A lower bound on blast radius, since a dependent that needed no change scores as a miss.

| | recall | files predicted |
|---|---|---|
| start (C# and TS imports only) | 17.4% | 5.3 |
| after the TS, co-change-noise and detection fixes | 18.3% | 6.3 |
| after Python, Go, Java/Kotlin, PHP, Ruby readers | 21.4% | 10.4 |
| the same, plus what the file itself imports | 26.3% | 15.3 |
| baseline: every file in the same folder | 22.1% | 15.9 |

Git history carries most of it (14.9% alone at 2.8 files; starlette 67%, cobra 71%). The benchmark and per-repo results live outside the repo (scratch `eval/`).

**Tests, measured (2026-11-05).** Would the map have pointed at the tests that broke? Nothing is run: a later commit that changes source files and edits tests that already existed is one whose change those tests had to follow. For each edited test, did the old map link it to a changed file? 16 of the 21 repos had such commits (263 commits, 582 edited tests).

| | tests linked | commits with at least one | tests named per changed file |
|---|---|---|---|
| framed (the test imports the file, or they change together) | 66.7% | 69.0% | 0.2–26, most under 15 |
| imports only | 62.9% | 61.7% | |
| following imports 3 deep, plus change-together | 78.4% | 76.1% | 2–107, 5–8× more |
| baseline: the test's name matches the file's | 43.1% | 49.7% | |
| baseline: same folder | 27.0% | 27.9% | |

Pooled over edited tests; the per-repo mean is lower (57.7% for framed), because documenso (11%), hugo (28%) and ripgrep (0%, Rust) pull it down. Going 3 imports deep finds 12 points more for several times the tests, so direct stays the rule.

## 22. Open items (Ishi)

- [ ] Draft the map for a real repo (work repo, side project, or a random OSS repo you've never read — the last one is the best test). One page. Include the source column.
- [ ] Draft the working file for one real bug you fixed recently.
- [ ] Write the brownfield gap-question list (2–3) and the greenfield five.
- [ ] Decide tier names.
- [ ] Decide on keeping vs deleting working files after merge (try deleting first).
- [ ] Pick a name.
- [ ] Start baseline measurement at work now, before anything is built.

### Left to do after the demo (2026-11-02)

v1 ran end to end on two replayed bugs (§20). Parked so a skeleton can be shown first:

- [ ] Rerun replay 2 under the machine rule (§9): it should keep the test project on net9.0, leave the machine alone, and open a draft PR with "not run on this machine" first. 2026-11-05, headless, up to the gate: the gate now says itself that .NET 9 is missing, the tests will be written but not run here, and the PR opens as a draft. After "yes" not run yet (an unattended session with a shell needs the user's say-so; run it in a normal session).
- [x] "Left as is" notes are not checked against the code: one in replay 1 described a case wrongly. Decided 2026-11-06: yes, each note names its place and is read again before the gate (§9, patch blame step 4).
- [x] The first test project in a repo copies the test tool another project in the same repo already uses (Vitest next to Vitest, xUnit next to xUnit). Agreed 2026-11-06 (§10, patch find step 5).
- [ ] The practice repo: merge the `framed-init` PR (drop the stale "deps" unsure line first).
- [ ] Baseline numbers (§21), measured without framed.
- [ ] The known gaps below.
- [ ] Studio, end to end in a real Claude Code session: a restyle on a scratch copy of a real repo, a new app in an empty folder, and a scout run with a brief. The page, the script helpers and the checks are tested; the two skills' flows have not run yet. 2026-11-05, headless: the scout with a brief made 6 valid looks; the restyle gate (a copy of a real repo's React front end) and the new-app gate both came out as the skill says. Found and fixed on the way: the guard watched Bash only (a Windows session may have only PowerShell), and the saved choice left the tree dirty, which stopped the restyle. After "yes" not run yet, for the same reason as replay 2.
- [ ] Then v2 (§20).

### Known gaps to check (found on eShop and Mastodon, 2026-10-28)

- [x] **Ruby code has no static edges.** Done 2026-11-04: Rails constants resolve to autoloaded files the Zeitwerk way (case and underscores ignored, so `API::V1` finds `api/v1`), with lexical lookup inside modules. Python, Go, Java/Kotlin (imports plus same-package class names) and PHP (`use` through composer PSR-4) got readers in the same change. Rust, Dart and Swift say "unknown", never "no".
  The original note: Rails loads classes by naming convention (`UserMailer` lives in `app/mailers/user_mailer.rb`), not by import lines, so the scan links Ruby files only through git history. Check how much blast radius that misses on a real Rails repo, then decide: a convention-based resolver (class name to file path), or a tool like the depcruise spec in §5.
- [x] **Spec files are not linked to the code they test.** Done for Rails by the constant reader (a spec names the class it tests) and for packages that re-export (a test importing `flask` or an `index.ts` touches what those re-export).
  The original note: spec files were not linked to the code they test when the test framework doesn't import it (rspec, and any convention-loaded language). Test edges come from imports today. Check whether name pairing (`user_spec.rb` to `user.rb`, `UserTests.cs` to `User.cs`) would be right often enough to use.
- [x] **Some test suites need Docker or a database.** Done 2026-11-03: test projects referencing Testcontainers, Aspire.Hosting.Testing, Playwright or Selenium are skipped (a solution containing one is split into its unit projects), and npm test scripts that start a browser, Docker or a database migration are skipped.
  The original note: e.g. eShop's functional tests start containers through Aspire. Detection can't tell that from the files, so they run with the unit tests. The suite step's pre-existing-failure check keeps them from blocking a fix, but every run pays for them. Check on a real repo whether to detect them (Testcontainers or Aspire references) and list them as skipped like running-app suites.

