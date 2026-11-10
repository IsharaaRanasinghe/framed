# framed

An AI dev workflow for Claude Code that works on **existing codebases first** and new projects second.

> The code is the spec, the map is how the agent reads it, and every step ends on its own.

Most AI workflow frameworks start from an empty folder. framed starts from the code you already have: it builds a one-page map of the repo, fixes one bug at a time without breaking what depends on the changed code, and delivers every change as a pull request with real test output in it. For a new project, it starts the app from a design you pick on its local page.

## What's in it

| Part | What it does |
|---|---|
| `map` skill | One-time setup for an existing repo. Scans imports, git co-change and tests mechanically, asks only what the code can't tell, runs one budgeted model pass, and commits `.framed/map.md` on a `framed-init` branch. |
| `patch` skill | Fixes one bug: find → why → gate → test → fix → suite → PR. You're asked once, at the gate, before any code changes. After your yes it runs to the PR. A commit lands at the end of every step, so "continue" resumes anywhere. |
| `design` skill | Builds the design you saved in the page's Studio. In an existing app it restyles only the theme layer, after one consent gate that lists the files. In an empty folder it starts the app on that design. |
| `map-builder`, `design-scout` agents | The map's model pass, and the search for more Studio style options. |
| Hooks | A git guard on Bash and PowerShell (no push to the default branch, no force push, branches named after the ticket), and a session-start line that says where the repo stands and what to say next. |
| The page | A local page (`http://127.0.0.1:4646`) with the fix's road, the map, the files a change may affect, Studio and Help. It opens by itself when a fix, a setup or a build starts. |

Everything runs on one dependency-free Node script, `scripts/framed.js`.

## Install

You need Claude Code, Git and Node 18 or newer.

In Claude Code:

```
/plugin marketplace add IsharaaRanasinghe/framed
/plugin install framed@framed
```

Or from a terminal:

```
claude plugin marketplace add IsharaaRanasinghe/framed
claude plugin install framed@framed
```

To update later, run `claude plugin marketplace update framed`, then `claude plugin update framed@framed`.

Or, from a clone of this repo, load it for a single session without installing:

```
claude --plugin-dir C:\path\to\framed
```

## Use

There are no commands to learn. Open Claude Code in a repo and say what you want:

- **"set up framed"** maps an existing repo (once). Merge the `framed-init` branch it opens.
- **Paste a ticket or describe a bug** to start a fix. Answer the one gate question, then review the PR.
- **"continue"** resumes a fix from its last step.
- **"open the page"** shows the road, the map and Studio. **"build my design"** applies the Studio design.

Settings live in `.framed/config.json` in each repo: test commands, the branch pattern, ticket prefixes and protected paths.

## What it never does

- Push to the default branch, or force push.
- Change your machine to get a test to pass. Anything that can't run here is named in the PR for the reviewer, and the PR opens as a draft.
- Widen the fix beyond the ticket. Anything else it notices is written down as "left as is", not changed.

## Status

Version 0.1.0, an early working version. The map has been tested on 21 public repos, and the fix flow on replays of real, already-fixed bugs. It is not yet proven in day-to-day team use. The full design, with its limits, is in [framework-design.md](framework-design.md).

## License

[MIT](LICENSE)
