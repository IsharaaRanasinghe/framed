---
ticket: TICKET-000
title: One-line title in the reporter's words
tier: patch
branch: TICKET-000-short-slug
status: in-progress
step: find
---
<!--
Working file. One per task, at .framed/tasks/<TICKET>.md in the repo being changed.
Committed at the end of every step, however the step ends. Collapsed into the PR
description on merge (or the ticket comment on close), then deleted.

Frontmatter is the only machine-read part (scripts/framed.js task).
  status: in-progress | blocked | done | closed
          blocked = stopped, waiting on a person. closed = finished with no code change.
  step:   the step currently running or last finished.
Everything below is written for the person reading the gate card. Plain words, no jargon.
-->

## Task
<!-- The bug in the reporter's words. Repro steps. The reported cases (record ids, names,
     dates) when the ticket has them, so the fix can be checked against them. -->

## Blast radius
<!-- From the map, not opinion. Every dependent gets a verdict: "updated" or "no change"
     plus why. Verdicts are proposed at find and confirmed at fix. Fix can't end while a
     dependent has no verdict. When a dependent turns out to need changing, append it to
     touches with the step it was added at. -->
- touches: file, file
- dependents from map:
  - File.cs (static): verdict. Why.
  - File.cs (co-change): verdict. Why.
  - File.test.ts (test): verdict. Why.

## Plan
<!-- Ordered. One line per intended change. One line is fine for a one-line fix. -->
1.

## Open questions
<!-- One per line. Who answers it: a person or a later step. Record the answer as given,
     not summarised. Unticked questions at gate time are the "unsure" line of the gate card.
     After the gate nobody is asked: what needs a decision is written "For the reviewer: ..."
     and goes first in the PR, which then opens as a draft. -->
- [ ] Question. Answered by <who>: <answer as given>.

## Steps
<!-- Append-only log. Rows are added in execution order; a step can appear more than once
     (fix fails suite, fix again). Remaining todo rows stay at the bottom so "what's next"
     is visible. Statuses: todo | running | done | failed | blocked.
     A running row means its work is in the working tree, uncommitted: resume starts with
     git status. A failed or blocked row still commits this file. -->
| step  | status | commit | note |
|-------|--------|--------|------|
| find  | todo   |        | |
| blame | todo   |        | |
| test  | todo   |        | |
| fix   | todo   |        | |
| suite | todo   |        | |
| pr    | todo   |        | |

## Decisions
<!-- One line each: what was decided and why. Goes into the PR. -->
-

## Changes
<!-- What has changed so far, in plain words, appended per step. Tests count. This becomes
     the PR description, so write it for the reviewer. -->
(nothing yet)

## Evidence
<!-- The bug test, failing before the fix and passing after, copied from the runner's own
     output, never written from memory. Shown in the PR right after Changes. -->
- Before the fix:
- After the fix:
