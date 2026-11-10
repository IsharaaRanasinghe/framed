#!/usr/bin/env node
'use strict';
// framed — the one Node script. Plain Node, no dependencies.
//
// Subcommands are added piece by piece. Right now:
//   node framed.js config [--root <dir>]   load, validate and print the effective config
//   node framed.js task   [--root <dir>]   find the active working file (frontmatter branch ==
//                                         current git branch) and print its frontmatter as JSON
//   node framed.js guard                   PreToolUse hook: reads hook JSON on stdin, exits 2 with
//                                         a reason if the Bash command breaks a git rule (§15)
//   node framed.js map scan|summary ...    build / summarise the file-level dependency scan (§5)
//   node framed.js deps <file>             dependents of one file from the scan, by source (§6)
//   node framed.js detect                  propose config from the repo's own conventions (§13)
//   node framed.js suite <file>...         test commands to run for a change (§10)
//   node framed.js why <file> <a>-<b>      evidence a block was deliberate: comments, recent commits (§11)
//   node framed.js reverts                 does the uncommitted change put back recently removed lines?
//                                         exit 0 no, 3 yes (stop and ask), 1 error (§11)
//   node framed.js ui [--port N]           the local page: the task's road, the map, Studio (§19)
//   node framed.js tests select|command|record|baseline|run   tests picked by coverage, for suites too
//                                         big to run on every fix (§10, opt-in)
//   node framed.js design detect|choice|css|hardcoded   the repo's current look, the saved Studio
//                                         choice, it as CSS variables, fixed colours a theme can't reach
//
// Repo root resolution: --root, else CLAUDE_PROJECT_DIR (set for hooks), else cwd.
// Config lives at <root>/.framed/config.json. Missing config is an error, never a silent default,
// because "can't find a test command" is a stop-and-ask failure path (design doc §16).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG_REL_PATH = path.join('.framed', 'config.json');
const TASKS_REL_DIR = path.join('.framed', 'tasks');

// ---- config ---------------------------------------------------------------------------------

// Defaults only for fields that have a safe, obvious value. Anything the code can't tell us
// (tests, ticket prefixes) is required and fails validation if absent. `framed detect` proposes
// values for all of them from the repo's own history and files; init asks the user to confirm.
//
// Fields:
//   tests           [{ path, command }]  one per project; command runs with cwd = path
//   ticketPrefixes  ["PROJ", "OPS"]      one per Jira board / tracker project; "#" means
//                                        numbered tickets (GitHub issues, Azure Boards work
//                                        items): branch bugfix/1234-x, commits "#1234 [find] ..."
//   branchPattern   "{ticket}-{slug}"    how framed names a task branch; detected from the
//                                        repo's branches, e.g. "bugfix/{ticket}-{slug}"
//   defaultBranch, protectedPaths, models.mapPass, budgets.mapPass
// Older single-value keys (testCommand, ticketPrefix) are still read and converted.
// The ticketPrefixes entry for numbered tickets (GitHub issues, Azure Boards work items).
const NUMBERED = '#';

const DEFAULTS = {
  defaultBranch: 'main',
  branchPattern: '{ticket}-{slug}',
  protectedPaths: [],
  models: { mapPass: 'sonnet' }, // alias the Agent tool accepts: sonnet | opus | haiku
  budgets: { mapPass: 25 }, // tool calls for the map model pass; the only budgeted step in v1 (§20)
};

const KNOWN_KEYS = ['tests', 'ticketPrefixes', 'branchPattern', 'defaultBranch', 'protectedPaths', 'models', 'budgets', 'testSelection',
  'testCommand', 'ticketPrefix'];

function resolveRoot(argv) {
  const i = argv.indexOf('--root');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  return process.cwd();
}

function loadConfig(root) {
  const file = path.join(root, CONFIG_REL_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`no config at ${file}. Create .framed/config.json in the repo root (see scripts/framed.js for fields).`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`config at ${file} is not valid JSON: ${e.message}`);
  }
  const merged = {
    ...DEFAULTS,
    ...raw,
    models: { ...DEFAULTS.models, ...(raw.models || {}) },
    budgets: { ...DEFAULTS.budgets, ...(raw.budgets || {}) },
  };
  // older single-value keys
  if (merged.tests === undefined && typeof raw.testCommand === 'string') merged.tests = [{ path: '.', command: raw.testCommand }];
  if (merged.ticketPrefixes === undefined && typeof raw.ticketPrefix === 'string') merged.ticketPrefixes = [raw.ticketPrefix];
  delete merged.testCommand;
  delete merged.ticketPrefix;
  const { errors, warnings } = validate(merged, raw);
  return { config: merged, file, errors, warnings };
}

function validate(cfg, raw) {
  const errors = [];
  const warnings = [];
  const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

  // An empty list is valid: a repo with no unit tests yet. The first fix in a project adds them.
  if (!Array.isArray(cfg.tests)) {
    errors.push('tests is required: a list of { "path": "<folder>", "command": "<test command>" }, one per project; [] if the repo has no unit tests yet');
  } else {
    cfg.tests.forEach((t, i) => {
      if (!t || !isStr(t.path) || !isStr(t.command)) errors.push(`tests[${i}] needs a non-empty "path" and "command"`);
    });
  }
  if (!Array.isArray(cfg.ticketPrefixes) || cfg.ticketPrefixes.length === 0) {
    errors.push('ticketPrefixes is required: a list of ticket keys, e.g. ["PROJ"], or ["#"] for numbered work items / issues');
  } else {
    for (const p of cfg.ticketPrefixes) {
      if (p !== NUMBERED && (!isStr(p) || !/^[A-Z][A-Z0-9]*$/.test(p))) {
        errors.push(`ticketPrefixes entry "${p}" should be an upper-case Jira-style key, e.g. PROJ, or "#" for numbered work items / issues`);
      }
    }
  }
  if (!isStr(cfg.branchPattern) || !cfg.branchPattern.includes('{ticket}') || !cfg.branchPattern.includes('{slug}')) {
    errors.push('branchPattern must contain {ticket} and {slug}, e.g. "{ticket}-{slug}" or "bugfix/{ticket}-{slug}"');
  }
  if (!isStr(cfg.defaultBranch)) errors.push('defaultBranch must be a non-empty string');
  if (!Array.isArray(cfg.protectedPaths) || !cfg.protectedPaths.every(isStr)) {
    errors.push('protectedPaths must be an array of strings');
  }
  if (typeof cfg.models !== 'object' || !isStr(cfg.models.mapPass)) {
    errors.push('models.mapPass must be a model alias for the map builder subagent: sonnet, opus or haiku');
  }
  if (typeof cfg.budgets !== 'object' || !Number.isInteger(cfg.budgets.mapPass) || cfg.budgets.mapPass <= 0) {
    errors.push('budgets.mapPass must be a positive integer (tool calls)');
  }
  if (cfg.testSelection !== undefined && cfg.testSelection !== 'coverage') {
    errors.push('testSelection, when set, must be "coverage" (pick tests by what they run; for suites too big to run on every fix)');
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) warnings.push(`unknown key "${key}" is ignored`);
  }
  return { errors, warnings };
}

function cmdConfig(argv) {
  const root = resolveRoot(argv);
  let result;
  try {
    result = loadConfig(root);
  } catch (e) {
    console.error(`framed: ${e.message}`);
    return 1;
  }
  for (const w of result.warnings) console.error(`framed: warning: ${w}`);
  if (result.errors.length) {
    console.error(`framed: invalid config at ${result.file}:`);
    for (const err of result.errors) console.error(`  - ${err}`);
    return 1;
  }
  console.log(JSON.stringify(result.config, null, 2));
  return 0;
}

// ---- working file ---------------------------------------------------------------------------
// Only the frontmatter is machine-read. Fields: ticket, title, tier, branch, status, step.
// The body is for the model and the person; the script never parses it.

const TASK_FIELDS = ['ticket', 'title', 'tier', 'branch', 'status', 'step'];
const TASK_STATUSES = ['in-progress', 'blocked', 'done', 'closed'];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    out[kv[1]] = kv[2].replace(/\s+#.*$/, '').trim(); // strip trailing "# comment"
  }
  return out;
}

function currentBranch(root) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return null;
  }
}

function listTasks(root) {
  const dir = path.join(root, TASKS_REL_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const file = path.join(dir, f);
      return { file, fm: parseFrontmatter(fs.readFileSync(file, 'utf8')) };
    });
}

// The active task is the working file whose frontmatter branch is the current git branch.
// Matched by branch, not "the only file", so a leftover file from an unmerged task can't be
// mistaken for the current one.
function findActiveTask(root, knownBranch) {
  const branch = knownBranch || currentBranch(root);
  if (!branch) throw new Error(`${root} is not a git repository (or git is not on PATH)`);
  const tasks = listTasks(root);
  const matches = tasks.filter((t) => t.fm && t.fm.branch === branch);
  if (matches.length === 0) {
    const known = tasks.filter((t) => t.fm).map((t) => `${path.basename(t.file)} -> ${t.fm.branch}`);
    throw new Error(`no working file for branch "${branch}" in ${TASKS_REL_DIR}`
      + (known.length ? ` (found: ${known.join(', ')})` : ' (folder empty or missing)'));
  }
  if (matches.length > 1) {
    throw new Error(`more than one working file claims branch "${branch}": ${matches.map((t) => path.basename(t.file)).join(', ')}`);
  }
  const { file, fm } = matches[0];
  const errors = [];
  for (const key of TASK_FIELDS) if (!fm[key]) errors.push(`frontmatter is missing "${key}"`);
  if (fm.status && !TASK_STATUSES.includes(fm.status)) {
    errors.push(`status "${fm.status}" is not one of ${TASK_STATUSES.join('/')}`);
  }
  const task = {};
  for (const key of TASK_FIELDS) task[key] = fm[key] || null;
  task.file = file;
  return { task, errors };
}

function cmdTask(argv) {
  const root = resolveRoot(argv);
  let result;
  try {
    result = findActiveTask(root);
  } catch (e) {
    console.error(`framed: ${e.message}`);
    return 1;
  }
  if (result.errors.length) {
    console.error(`framed: invalid working file at ${result.task.file}:`);
    for (const err of result.errors) console.error(`  - ${err}`);
    return 1;
  }
  console.log(JSON.stringify(result.task, null, 2));
  return 0;
}

// ---- git guard (PreToolUse hook on Bash) ----------------------------------------------------
// Design doc §15: never push to the default branch, never force push, always a task branch,
// delivery is PR only. "Commit at end of every step" is the step skill's job; a hook can't
// make a commit happen.
//
// Reads the hook JSON from stdin, inspects every git invocation in the command, exits 2 with a
// plain-words reason on the first broken rule. Exit 2 makes Claude Code block the command and
// show the reason to the agent. Anything else exits 0.
//
// Without a config: still blocks force pushes and pushes to main/master; the branch-name rule
// needs ticketPrefixes, so it is skipped. Safe by default, stricter with config.

const FALLBACK_DEFAULT_BRANCHES = ['main', 'master'];
const COMMIT_CREATING = ['commit', 'merge', 'cherry-pick', 'revert', 'am'];
const GIT_GLOBAL_OPTS_WITH_ARG = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'];

// Split a shell command into segments (one per simple command), each a list of tokens.
// Respects single and double quotes; splits on && || ; | and newlines. Good enough for the
// git commands an agent writes; it is a guard, not a shell.
// PowerShell's escape character is the backtick; a backslash there is part of a path.
function shellSegments(command, shell = 'bash') {
  const escape = shell === 'powershell' ? '`' : '\\';
  const segments = [[]];
  let tok = '';
  let quote = null;
  let i = 0;
  const flush = () => { if (tok.length) { segments[segments.length - 1].push(tok); tok = ''; } };
  const sep = () => { flush(); if (segments[segments.length - 1].length) segments.push([]); };
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null; else tok += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
    if (ch === escape && i + 1 < command.length) { tok += command[i + 1]; i += 2; continue; }
    if (command.startsWith('&&', i) || command.startsWith('||', i)) { sep(); i += 2; continue; }
    if (ch === ';' || ch === '|' || ch === '\n') { sep(); i += 1; continue; }
    if (/\s/.test(ch)) { flush(); i += 1; continue; }
    tok += ch;
    i += 1;
  }
  flush();
  return segments.filter((s) => s.length);
}

// From one segment, return { sub, args } if it is a git invocation, else null.
// Skips leading env assignments (FOO=bar git ...) and git's own global options (-C dir, -c k=v).
// PowerShell's call operator (& git ...) and git.exe, bare or by path, are git too.
function parseGit(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (tokens[i] === '&') i += 1;
  if (!/^(.*[\\/])?git(\.exe)?$/i.test(tokens[i] || '')) return null;
  i += 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i];
    i += 1;
    if (GIT_GLOBAL_OPTS_WITH_ARG.includes(opt)) i += 1; // option takes a separate argument
  }
  if (i >= tokens.length) return null;
  return { sub: tokens[i], args: tokens.slice(i + 1) };
}

function isDefaultBranch(name, defaults) {
  if (!name) return false;
  const bare = name.replace(/^refs\/heads\//, '');
  return defaults.includes(bare);
}

function checkPush(args, ctx) {
  const defaults = ctx.defaultBranches;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--force' || a === '--force-with-lease' || a === '--force-if-includes' || a.startsWith('--force-with-lease=')) {
      return `force push is not allowed (${a}). Rule: never force push.`;
    }
    if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) return `force push is not allowed (${a}). Rule: never force push.`;
    if (a === '--all' || a === '--mirror') return `git push ${a} would push the default branch. Rule: never push to the default branch, delivery is PR only.`;
    if (a === '--delete' || a === '-d') {
      const target = args[i + 2] || args[i + 1];
      if (isDefaultBranch(target, defaults)) return `deleting the default branch is not allowed.`;
    }
    if (a.startsWith('+')) return `refspec "${a}" is a force push. Rule: never force push.`;
    if (a === '--repo' || a === '-o' || a === '--push-option' || a === '--receive-pack' || a === '--exec') { i += 1; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const refspecs = positional.slice(1); // first positional is the remote
  if (refspecs.length === 0) {
    if (isDefaultBranch(ctx.branch, defaults)) {
      return `you are on "${ctx.branch}" and git push would push it. Rule: never push to the default branch, delivery is PR only. Create a task branch first.`;
    }
    return null;
  }
  for (const spec of refspecs) {
    const dest = spec.includes(':') ? spec.split(':')[1] : spec;
    const src = spec.includes(':') ? spec.split(':')[0] : null;
    if (isDefaultBranch(dest, defaults)) {
      return `git push to "${dest}" is not allowed. Rule: never push to the default branch, delivery is PR only. Push the task branch and open a PR.`;
    }
    if (!src && dest === 'HEAD' && isDefaultBranch(ctx.branch, defaults)) {
      return `you are on "${ctx.branch}" and git push HEAD would push it. Rule: never push to the default branch.`;
    }
  }
  return null;
}

// Brownfield init (§13) has no ticket: the map and config land on this one fixed branch name.
const INIT_BRANCH = 'framed-init';
// A Studio build with no ticket (§19) lands here, the same way.
const DESIGN_BRANCH = 'framed-design';

// "Named after the task" = some path segment of the branch starts with <PREFIX>-<number>, for
// any configured prefix. So the repo's own convention passes (bugfix/PROJ-4840-x,
// feature/admin/PROJ-12_v2) as well as framed's default (PROJ-4840-x). The exact shape framed
// itself creates comes from branchPattern; the guard only insists a ticket is in the name.
// A numbered ticket ("#" in ticketPrefixes) is a path segment that starts with the number
// (bugfix/1234-x, 1234_fix). Not followed by "." so release/2.0 is not a ticket.
function ticketAlternatives(prefixes) {
  return prefixes.map((p) => (p === NUMBERED ? '\\d+(?=[-_/]|$)' : `${p.replace(/[^A-Z0-9]/g, '')}-\\d+(?=[-_./]|$)`));
}

function branchHasTicket(name, prefixes) {
  return new RegExp(`(^|/)(${ticketAlternatives(prefixes).join('|')})`).test(name);
}

function exampleTicket(prefix) {
  return prefix === NUMBERED ? '1234' : `${prefix}-123`;
}

// "APP-123 or OPS-123", "a work item / issue number like 1234"
function describeTickets(prefixes) {
  return prefixes.map((p) => (p === NUMBERED ? 'a work item or issue number like 1234' : exampleTicket(p))).join(' or ');
}

function exampleBranch(ctx) {
  return (ctx.branchPattern || DEFAULTS.branchPattern).replace('{ticket}', exampleTicket(ctx.ticketPrefixes[0])).replace('{slug}', 'short-slug');
}

function checkBranchName(name, ctx) {
  if (!ctx.ticketPrefixes || !ctx.ticketPrefixes.length || !name) return null;
  if (name === INIT_BRANCH || name === DESIGN_BRANCH) return null;
  if (!branchHasTicket(name, ctx.ticketPrefixes)) {
    return `branch "${name}" is not named after a task. Rule: always a branch named after the task, with ${describeTickets(ctx.ticketPrefixes)} in it, e.g. ${exampleBranch(ctx)}.`;
  }
  return null;
}

function checkCommitCreating(sub, ctx) {
  if (isDefaultBranch(ctx.branch, ctx.defaultBranches)) {
    return `git ${sub} on "${ctx.branch}" is not allowed. Rule: never commit to the default branch, delivery is PR only. Create a task branch first.`;
  }
  return checkBranchName(ctx.branch, ctx);
}

function checkBranchCreate(sub, args, ctx) {
  // git checkout -b NAME | git switch -c NAME | git branch NAME
  let name = null;
  if (sub === 'checkout') {
    const i = args.findIndex((a) => a === '-b' || a === '-B');
    if (i !== -1) name = args[i + 1];
  } else if (sub === 'switch') {
    const i = args.findIndex((a) => a === '-c' || a === '-C' || a === '--create');
    if (i !== -1) name = args[i + 1];
  } else if (sub === 'branch') {
    const positional = args.filter((a) => !a.startsWith('-'));
    const deleting = args.some((a) => a === '-d' || a === '-D' || a === '--delete' || a === '-m' || a === '-M' || a === '--move');
    if (!deleting && positional.length >= 1) name = positional[0];
  }
  return name ? checkBranchName(name, ctx) : null;
}

function guardCommand(command, ctx, shell = 'bash') {
  for (const seg of shellSegments(command, shell)) {
    const git = parseGit(seg);
    if (!git) continue;
    let reason = null;
    if (git.sub === 'push') reason = checkPush(git.args, ctx);
    else if (COMMIT_CREATING.includes(git.sub)) reason = checkCommitCreating(git.sub, ctx);
    else if (git.sub === 'checkout' || git.sub === 'switch' || git.sub === 'branch') reason = checkBranchCreate(git.sub, git.args, ctx);
    if (reason) return reason;
  }
  return null;
}

function guardContext(root) {
  const ctx = { root, branch: currentBranch(root), defaultBranches: FALLBACK_DEFAULT_BRANCHES, ticketPrefixes: null, branchPattern: null, warnings: [] };
  try {
    const { config, errors } = loadConfig(root);
    if (errors.length) {
      ctx.warnings.push(`config has errors, branch-name rule skipped: ${errors.join('; ')}`);
    } else {
      ctx.defaultBranches = [config.defaultBranch];
      ctx.ticketPrefixes = config.ticketPrefixes;
      ctx.branchPattern = config.branchPattern;
    }
  } catch (e) {
    ctx.warnings.push(`${e.message} Branch-name rule skipped; still blocking pushes to ${FALLBACK_DEFAULT_BRANCHES.join('/')} and force pushes.`);
  }
  return ctx;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function cmdGuard(argv) {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    return 0; // not hook JSON; nothing to guard
  }
  const command = input && input.tool_input && input.tool_input.command;
  if (typeof command !== 'string' || !/\bgit\b/.test(command)) return 0;

  const rootArg = argv.indexOf('--root');
  const root = rootArg !== -1 && argv[rootArg + 1] ? path.resolve(argv[rootArg + 1])
    : (input.cwd ? path.resolve(input.cwd) : resolveRoot(argv));

  let reason;
  try {
    const ctx = guardContext(root);
    reason = guardCommand(command, ctx, input.tool_name === 'PowerShell' ? 'powershell' : 'bash');
    if (reason && ctx.warnings.length) reason += `\n(framed: ${ctx.warnings.join(' ')})`;
  } catch (e) {
    // Fail closed only for pushes: a guard crash must not let a push through.
    if (/\bgit\b[^|;&]*\bpush\b/.test(command)) reason = `framed guard failed (${e.message}); refusing to let a git push through.`;
    else return 0;
  }
  if (reason) {
    console.error(`framed: blocked. ${reason}`);
    return 2;
  }
  return 0;
}

// ---- status: where this repo stands with framed (§18 entry point) ---------------------------
// One answer for "what should happen next here?", so the user never needs a slash command.
// Read by the SessionStart hook (greets the user, tells the model) and by the skills.
// Cheap on purpose: git ls-files, a few file reads, no scan.
//
// States: not-git | greenfield | setup-invalid | setup-pending | uninitialized | task | ready
const CODE_EXT = /\.(cs|ts|tsx|js|jsx|mjs|cjs|py|java|go|rb|php|kt|swift|rs|c|cc|cpp|h|hpp|scala|vb|fs|dart)$/i;

// Runs at every session start, and each git process costs up to a second on a slow Windows
// box. So the common path (repo already set up) reads .git directly and spawns no git at all;
// git ls-files runs only when the repo is not set up, to tell code from an empty repo.
function gitDirOf(root) {
  const dotgit = path.join(root, '.git');
  let st;
  try { st = fs.statSync(dotgit); } catch { return null; }
  if (st.isDirectory()) return dotgit;
  const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m); // worktree or submodule
  return m ? path.resolve(root, m[1].trim()) : null;
}

function fastBranch(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : 'HEAD'; // detached
  } catch { return null; }
}

function localBranchExists(gitDir, name) {
  const common = (() => { try { return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { return gitDir; } })();
  if (fs.existsSync(path.join(common, 'refs', 'heads', ...name.split('/')))) return true;
  try { return fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').includes(` refs/heads/${name}\n`); } catch { return false; }
}

function repoStatus(root) {
  // The repo root may be above the session's folder; status is about the repo the user is in.
  let top = root;
  while (!gitDirOf(top)) { const up = path.dirname(top); if (up === top) return { state: 'not-git', root: toPosix(root) }; top = up; }
  root = top;
  const gitDir = gitDirOf(root);
  const branch = fastBranch(gitDir);
  if (!branch) return { state: 'not-git', root: toPosix(root) };
  const base = { root: toPosix(root), branch };

  const hasConfig = fs.existsSync(path.join(root, CONFIG_REL_PATH));
  const hasMap = fs.existsSync(path.join(root, MAP_REL_PATH));
  if (!hasConfig || !hasMap) {
    let files = [];
    try { files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean); } catch { /* no commits yet */ }
    const codeFiles = files.filter((f) => CODE_EXT.test(f) && !f.startsWith('.framed/')).length;
    if (codeFiles === 0) return { ...base, state: 'greenfield', codeFiles };
    if (branch !== INIT_BRANCH && localBranchExists(gitDir, INIT_BRANCH)) return { ...base, state: 'setup-pending', codeFiles };
    return { ...base, state: 'uninitialized', codeFiles, missing: [!hasConfig && 'config', !hasMap && 'map'].filter(Boolean) };
  }
  let config;
  try {
    const r = loadConfig(root);
    if (r.errors.length) return { ...base, state: 'setup-invalid', errors: r.errors };
    config = r.config;
  } catch (e) { return { ...base, state: 'setup-invalid', errors: [e.message] }; }

  let mapDate = null;
  try { mapDate = fs.statSync(path.join(root, MAP_REL_PATH)).mtime.toISOString().slice(0, 10); } catch { /* gone */ }
  const ready = { ...base, mapDate, ticketPrefixes: config.ticketPrefixes, unitTests: config.tests.length, onInitBranch: branch === INIT_BRANCH };
  try {
    const { task, errors } = findActiveTask(root, branch);
    if (!errors.length) return { ...ready, state: 'task', task: { ticket: task.ticket, title: task.title, step: task.step, status: task.status } };
  } catch { /* no task for this branch */ }
  return { ...ready, state: 'ready' };
}

// What to tell the person (one or two lines, shown in the terminal) and the model (context).
function statusMessages(s) {
  const P = 'framed';
  switch (s.state) {
    case 'not-git':
      return null; // stay silent outside git repos
    case 'greenfield':
      return {
        user: `${P}: this folder has no code yet. To start a new app from a design: open the framed page, pick a look in Studio, save it, then say "build my design".`,
        model: `${P} status: greenfield (no code files). Fixing bugs and the map need existing code. framed can start a new app from a design: the page is \`node "${toPosix(__filename)}" ui\` (Studio page); when the user says "build my design", asks to start the app from the saved design, or asks for more design options, run the framed:design skill. Do not run framed:map or framed:patch here.`,
      };
    case 'uninitialized':
      return {
        user: `${P}: this repo isn't set up yet. Say "set up framed" and I'll scan the code (seconds) and ask you three short questions.`,
        model: `${P} status: uninitialized (${s.codeFiles} code files, no ${s.missing.join(' or ')}). When the user asks to set up framed, map the repo, or describes a bug to fix, run the framed:map skill first. Explain in one line that the repo needs a one-time scan before bugs can be fixed.`,
      };
    case 'setup-pending':
      return {
        user: `${P}: setup was done on the local branch "${INIT_BRANCH}" but isn't merged into ${s.branch} yet. Merge it (by PR), or say "use the framed-init setup" to work from that branch.`,
        model: `${P} status: setup-pending. The map and config exist on the local branch ${INIT_BRANCH}, not on ${s.branch}. Do not run framed:map again. If the user wants to work now, check out ${INIT_BRANCH} (git checkout ${INIT_BRANCH}) and then follow framed:patch.`,
      };
    case 'setup-invalid':
      return {
        user: `${P}: the config in .framed/config.json has a problem: ${s.errors[0]}`,
        model: `${P} status: setup-invalid. Errors: ${s.errors.join('; ')}. Help the user fix .framed/config.json before running any framed skill.`,
      };
    case 'task':
      return {
        user: `${P}: you're in the middle of ${s.task.ticket} (${s.task.title}), at the ${s.task.step} step${s.task.status === 'blocked' ? ', waiting on your answer' : ''}. Say "continue" to pick it up.`,
        model: `${P} status: task in progress on this branch: ${s.task.ticket} "${s.task.title}", step ${s.task.step}, status ${s.task.status}. When the user says continue or asks about this task, run the framed:patch skill; it resumes from the working file.`,
      };
    case 'ready':
      return {
        user: `${P}: ready${s.mapDate ? ` (map from ${s.mapDate})` : ''}. Tell me the bug: paste the ticket or describe it, with its number (${describeTickets(s.ticketPrefixes)}).${s.unitTests ? '' : ' This repo has no unit tests yet; the first fix in each project will offer to add them.'}`,
        model: `${P} status: ready on ${s.branch}${s.onInitBranch ? ' (setup branch, not merged yet)' : ''}. Ticket prefixes: ${s.ticketPrefixes.join(', ')}${s.ticketPrefixes.includes(NUMBERED) ? ' ("#" = numbered work items / issues)' : ''}. Unit test suites in config: ${s.unitTests}. When the user describes a bug, pastes a ticket, or asks for a fix, run the framed:patch skill. Pull the ticket key and a short title from what they wrote; ask once if there is no key. When the user says "build my design", asks to restyle the app from the design saved in the framed page's Studio, or asks for more design options, run the framed:design skill.`,
      };
    default:
      return null;
  }
}

function cmdStatus(argv) {
  const root = resolveRoot(argv);
  const s = repoStatus(root);
  if (argv.includes('--hook')) {
    const m = statusMessages(s);
    if (!m) return 0;
    const cmd = `node "${toPosix(__filename)}"`;
    const q = (c) => '`' + cmd + ' ' + c + '`';
    const controls = ' The framed page (a local web page showing the fix\'s progress, the map and Studio) opens by itself when a fix or setup starts'
      + (pageEnabled() ? '' : ', but the person has turned it off')
      + '. When the person asks to turn the framed page off or on, run ' + q('page off') + ' or ' + q('page on') + '; to open it now, ' + q('page open') + '.'
      + ' When they ask to show context left and plan usage (framed\'s status line), run ' + q('statusline install') + ' (' + q('statusline uninstall') + ' to remove it);'
      + ' it changes their own Claude Code settings, so only on their request.';
    console.log(JSON.stringify({
      systemMessage: m.user,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: m.model + controls },
    }));
    return 0;
  }
  console.log(JSON.stringify(s, null, 2));
  return 0;
}

// ---- detect: the repo's own conventions, proposed for init to confirm (§13) ----------------
// Ask only what the code can't tell you. Branch names, commit messages and project files tell
// most of it. Everything here is a proposal; the map skill shows it and the user confirms.
//
//   node framed.js detect [--root <repo>]   prints JSON: defaultBranch, ticketPrefixes,
//                                           branchPattern, tests, plus the evidence for each

// Things that look like ticket keys and are not.
const KEY_STOPLIST = new Set(['GPL', 'LGPL', 'AGPL', 'MPL', 'EPL', 'BSD', 'MIT', 'UTF', 'ISO', 'SHA', 'TLS', 'SSL', 'HTTP', 'HTTPS', 'RFC', 'CVE', 'PR', 'MR', 'WIP',
  'TODO', 'FIXME', 'ES', 'IE', 'UTC', 'GMT', 'AES', 'RSA', 'MD', 'X', 'V', 'COVID', 'PEP', 'JSR']);
const KEY_RE = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]{0,9})-(\d+)(?![A-Za-z0-9])/g;

// Ticket prefixes = keys seen on several distinct tickets, in branch names or commit subjects.
// Counted by distinct ticket number, so one busy ticket can't make a prefix look common.
function detectPrefixes(branches, subjects) {
  const seen = new Map(); // prefix -> { tickets:Set, branches:n, commits:n }
  const scan = (text, where) => {
    for (const m of text.matchAll(KEY_RE)) {
      if (KEY_STOPLIST.has(m[1])) continue;
      if (!seen.has(m[1])) seen.set(m[1], { tickets: new Set(), branches: 0, commits: 0 });
      const s = seen.get(m[1]);
      s.tickets.add(m[2]);
      s[where] += 1;
    }
  };
  for (const b of branches) scan(b, 'branches');
  for (const s of subjects) scan(s, 'commits');
  // Numbered tickets: a branch segment that starts with a number (bugfix/1234-x), Azure's
  // "AB#1234" work-item link, or GitHub's "fixes #1234". Not GitHub's "(#1234)" or "Merge pull
  // request #1234": those are pull-request numbers, not tickets.
  const num = (n, where) => {
    if (!seen.has(NUMBERED)) seen.set(NUMBERED, { tickets: new Set(), branches: 0, commits: 0 });
    const s = seen.get(NUMBERED);
    s.tickets.add(n);
    s[where] += 1;
  };
  for (const b of branches) for (const m of b.matchAll(/(?:^|\/)(\d+)(?=[-_/]|$)/g)) num(m[1], 'branches');
  for (const s of subjects) {
    for (const m of s.matchAll(/\bAB#(\d+)|\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi)) num(m[1] || m[2], 'commits');
  }
  const ranked = [...seen.entries()].map(([prefix, s]) => ({ prefix, tickets: s.tickets.size, inBranches: s.branches, inCommits: s.commits }))
    .sort((a, b) => b.tickets - a.tickets);
  const top = ranked.length ? ranked[0].tickets : 0;
  const kept = ranked.filter((r) => r.tickets >= 5 && r.tickets >= top * 0.1);
  return { prefixes: kept.map((r) => r.prefix), evidence: ranked.slice(0, 6) };
}

// Branch pattern = what usually comes before the ticket key in this repo's branch names. A patch
// is a bug fix, so a bug-ish folder (bugfix/, fix/, hotfix/) wins if the repo uses one. If few
// branches carry a key at all, the repo has no convention and framed's default applies.
function detectBranchPattern(branches, prefixes) {
  const fallback = { pattern: DEFAULTS.branchPattern, convention: false };
  if (!prefixes.length) return { ...fallback, evidence: 'no ticket prefixes found' };
  const re = new RegExp(`^(.*?)(?:^|(?<=/))(${ticketAlternatives(prefixes).join('|')})`);
  const lead = new Map();
  let keyed = 0;
  for (const b of branches) {
    const m = b.match(re);
    if (!m) continue;
    keyed += 1;
    lead.set(m[1], (lead.get(m[1]) || 0) + 1);
  }
  const share = branches.length ? keyed / branches.length : 0;
  const ranked = [...lead.entries()].sort((a, b) => b[1] - a[1]);
  const evidence = { branches: branches.length, withTicket: keyed, leads: ranked.slice(0, 6).map(([l, n]) => `${l || '(none)'} x${n}`) };
  if (keyed < 10 || share < 0.2) return { ...fallback, evidence };
  const bugLead = ranked.find(([l]) => /bug|fix/i.test(l));
  const chosen = bugLead || ranked[0];
  return { pattern: `${chosen[0]}{ticket}-{slug}`, convention: true, evidence };
}

// Test commands, one per project, from the files the repo already has. The framework has no
// opinion on tooling (§10): it finds the runner that is there. Suites that need a running app
// (end-to-end, performance, UI automation) are listed as skipped, for the user to add by hand.
const NEEDS_RUNNING_APP = /(^|\/)(e2e|playwright|cypress|perf|performance|load-?tests?|k6|ui-?automation|selenium)(\/|$|-)/i;

// A solution file or an Nx workspace is not a test suite. An entry is proposed only when a
// runner is really configured under its folder (a test project, a test target, a test script);
// each carries how many test files it would run, so "runner ready, no tests yet" is visible.
// any ".test.<ext>" (so a language framed has no runner for still shows up), except env files and
// copies like ".env.test.example" (found on a Rails repo)
const TEST_FILE_RE = /(?<!\.env)\.(test|spec)\.(?!(example|sample|template|dist|bak|orig)$)[a-z0-9]+$|Tests?\.(cs|php|java|kt)$|_test\.(go|rb|dart|py)$|_spec\.rb$|(^|\/)test_[^/]+\.py$/i;
// MSTest.Sdk covers projects that name the framework as their project SDK, not as a package
const DOTNET_TEST_REF = /Microsoft\.NET\.Test\.Sdk|\bxunit\b|\bnunit\b|\bMSTest\b|\bTUnit\b/i;
// which test files each runner kind runs, so counts and "test files nothing runs" stay per language
const KIND_EXTS = {
  dotnet: ['cs'], nx: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'], npm: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'],
  python: ['py'], go: ['go'], maven: ['java', 'kt'], gradle: ['java', 'kt'], cargo: ['rs'], ruby: ['rb'], php: ['php'], flutter: ['dart'],
};
// A test script or project that needs a running app, a browser, a database or Docker is not a
// unit suite, whatever its folder is called (Playwright in frontend/tests, a solution's
// Web.AcceptanceTests, "npm test" that migrates a database first: all found on public repos).
const APP_SCRIPT = /\b(playwright|cypress|start-server-and-test|wait-on|docker(-compose)?|testcontainers|migrate(:fresh)?|db:(migrate|reset|setup)|selenium)\b/i;
const APP_TEST_PROJECT = /Microsoft\.Playwright|Selenium\.WebDriver|Testcontainers|Aspire\.Hosting\.Testing/i;
// a root script that only forwards to a package's own test script
const FORWARDING_SCRIPT = /(--filter\b|--workspace\b|\s-w\s|\bturbo run\b|\blerna run\b|\bpnpm -r\b|\bpnpm --recursive\b|\byarn workspaces?\b|\bnpm run test --workspaces?\b)/i;

// Project paths a .sln or .slnx lists, relative to the repo root.
function solutionProjects(root, sln) {
  const text = readText(root, sln);
  const rels = [...text.matchAll(/Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+\.csproj)"/gi), ...text.matchAll(/<Project\s+Path="([^"]+\.csproj)"/gi)]
    .map((m) => m[1]);
  return rels.map((r) => toPosix(path.posix.normalize(path.posix.join(dirOf(sln), r.split('\\').join('/')))));
}

function detectTests(root, files) {
  const tests = [];
  const skipped = [];
  const noRunner = [];
  const has = (dir, name) => files.includes(dir ? `${dir}/${name}` : name);
  const inside = (dir) => (f) => dir === '' || f.startsWith(`${dir}/`);
  const isTestFile = (f, dir = '') => TEST_FILE_RE.test(f) && !/node_modules\//.test(f) && (NEEDS_RUNNING_APP.test(`${dir}/`) || !NEEDS_RUNNING_APP.test(f));
  const countTests = (dir, kind) => files.filter(inside(dir))
    .filter((f) => isTestFile(f, dir) && (!KIND_EXTS[kind] || KIND_EXTS[kind].includes(extOf(f)))).length;
  // vite.config is a build file; it is a test runner only if it configures vitest
  const isTestConfig = (f) => (/(^|\/)(jest|vitest)\.config\.[cm]?[jt]s$/.test(f)
    || (/(^|\/)vite\.config\.[cm]?[jt]s$/.test(f) && /\btest\s*:\s*\{|vitest/.test(readText(root, f)))) && !/node_modules\//.test(f);
  const add = (dir, command, kind, testFiles = countTests(dir, kind)) => {
    const entry = { path: dir || '.', command, kind, testFiles };
    if (NEEDS_RUNNING_APP.test(`${dir}/`)) skipped.push({ ...entry, reason: 'looks like a suite that needs a running app; framed does not run it' });
    else tests.push(entry);
  };
  const under = (dir, kind) => tests.concat(skipped).some((t) => t.kind === kind && (t.path === '.' || dir.startsWith(`${t.path}/`)));

  // .NET: a solution counts only if it lists a test project (one referencing a test framework).
  // Membership comes from the solution file, not the folder. Shallowest solution first; one whose
  // test projects an earlier solution already runs adds nothing. A test project in no solution
  // gets its own entry.
  const testProjects = files.filter((f) => /\.csproj$/i.test(f) && DOTNET_TEST_REF.test(readText(root, f)));
  const slns = files.filter((f) => /\.slnx?$/i.test(f)).sort((a, b) => a.split('/').length - b.split('/').length);
  const covered = new Set();
  const csIn = (projs) => files.filter((f) => projs.some((p) => f.startsWith(`${dirOf(p)}/`)) && /\.cs$/.test(f)).length;
  // a test project that drives a browser or needs Docker is never part of the unit run
  const needsApp = (p) => APP_TEST_PROJECT.test(readText(root, p)) || NEEDS_RUNNING_APP.test(`${dirOf(p)}/`);
  const skipProject = (p) => {
    if (skipped.some((x) => x.path === dirOf(p))) return;
    skipped.push({ path: dirOf(p), command: 'dotnet test', kind: 'dotnet', testFiles: csIn([p]), reason: 'this test project drives a browser or needs Docker (Playwright, Selenium, Testcontainers, Aspire); framed does not run it' });
  };
  for (const s of slns) {
    const d = dirOf(s);
    const listed = new Set(solutionProjects(root, s));
    const mine = testProjects.filter((p) => listed.has(p));
    if (!mine.length) { noRunner.push({ path: d || '.', why: `${s.slice(s.lastIndexOf('/') + 1)} has no test project` }); continue; }
    const fresh = mine.filter((p) => !covered.has(p));
    if (!fresh.length) continue;
    for (const p of mine) covered.add(p);
    const app = mine.filter(needsApp);
    if (!app.length) { add(d, `dotnet test ${s.slice(s.lastIndexOf('/') + 1)}`, 'dotnet', csIn(mine)); continue; }
    // the solution would run them too: one command per unit test project instead
    for (const p of app) skipProject(p);
    for (const p of mine.filter((x) => !needsApp(x))) add(dirOf(p), 'dotnet test', 'dotnet', csIn([p]));
  }
  for (const p of testProjects.filter((x) => !covered.has(x))) { if (needsApp(p)) skipProject(p); else add(dirOf(p), 'dotnet test', 'dotnet', csIn([p])); }

  // JS/TS: an Nx workspace counts only if something in it can run tests
  const nxDirs = files.filter((f) => /(^|\/)nx\.json$/.test(f)).map(dirOf).sort((a, b) => a.length - b.length);
  for (const d of nxDirs) {
    if (under(d, 'nx')) continue;
    let nx = {};
    try { nx = JSON.parse(stripJsonComments(readText(root, d ? `${d}/nx.json` : 'nx.json'))); } catch { /* unreadable */ }
    const plugins = (nx.plugins || []).map((p) => (typeof p === 'string' ? p : p.plugin || ''));
    const runnerConfigured = Object.keys(nx.targetDefaults || {}).some((t) => /test/.test(t))
      || plugins.some((p) => /@nx\/(jest|vite|vitest)/.test(p))
      || files.filter(inside(d)).some(isTestConfig)
      || files.filter(inside(d)).some((f) => /(^|\/)project\.json$/.test(f) && /"test"\s*:/.test(readText(root, f)));
    if (runnerConfigured) add(d, 'npx nx run-many -t test', 'nx');
    else noRunner.push({ path: d || '.', why: 'Nx workspace with no test target or test runner configured' });
  }
  for (const pj of files.filter((f) => /(^|\/)package\.json$/.test(f)).sort((a, b) => a.length - b.length)) {
    const d = dirOf(pj);
    // inside an Nx workspace, package.json test scripts belong to Nx, except a running-app suite
    // (it is reported as skipped so the person sees why it is not used)
    if (nxDirs.some((n) => n === '' || d === n || d.startsWith(`${n}/`)) && !NEEDS_RUNNING_APP.test(`${d}/`)) continue;
    let script;
    try { script = (JSON.parse(readText(root, pj)).scripts || {}).test; } catch { continue; }
    if (!script || /no test specified/.test(script)) continue;
    if (APP_SCRIPT.test(script)) {
      skipped.push({ path: d || '.', command: 'npm test', kind: 'npm', testFiles: countTests(d, 'npm'), reason: `its test script needs a running app, a browser or a database ("${script.slice(0, 80)}"); framed does not run it` });
      continue;
    }
    add(d, 'npm test', 'npm');
    if (FORWARDING_SCRIPT.test(script)) tests[tests.length - 1].forwards = true;
  }
  // a root script that only forwards to packages that have their own entry adds nothing but a second run
  for (const t of tests.filter((x) => x.forwards)) {
    const others = tests.concat(skipped).filter((o) => o !== t && o.kind === 'npm' && (t.path === '.' || o.path.startsWith(`${t.path}/`)));
    if (others.length) tests.splice(tests.indexOf(t), 1);
    delete t.forwards;
  }

  // Other ecosystems: one entry per top-most project file of each kind. A command function
  // returns null when the project file is there but no test runner is set up in it.
  const others = [
    // Flutter first: its android/ shell has a build.gradle that is not the app's test runner
    [/(^|\/)pubspec\.yaml$/, (d, f) => (/^\s*flutter\s*:/m.test(readText(root, f)) ? 'flutter test' : files.some((x) => inside(d)(x) && /_test\.dart$/.test(x)) ? 'dart test' : null), 'flutter'],
    [/(^|\/)(pyproject\.toml|pytest\.ini|tox\.ini)$/, () => 'python -m pytest', 'python'],
    [/(^|\/)go\.mod$/, () => 'go test ./...', 'go'],
    [/(^|\/)pom\.xml$/, () => 'mvn -q test', 'maven'],
    // one JVM runner per project: Maven if it is there, Gradle otherwise; never inside a Flutter app
    [/(^|\/)build\.gradle(\.kts)?$/, (d) => (under(d, 'maven') || under(d, 'flutter') ? null : has(d, 'gradlew') ? './gradlew test' : 'gradle test'), 'gradle'],
    [/(^|\/)Cargo\.toml$/, () => 'cargo test', 'cargo'],
    [/(^|\/)Gemfile$/, (d, f) => {
      const gems = readText(root, f);
      if (/['"]rspec(-rails)?['"]/.test(gems)) return 'bundle exec rspec';
      if (files.some((x) => inside(d)(x) && /_test\.rb$/.test(x))) return has(d, 'bin/rails') ? 'bin/rails test' : 'bundle exec rake test';
      return null;
    }, 'ruby'],
    [/(^|\/)composer\.json$/, (d, f) => {
      const deps = readText(root, f);
      if (/pestphp\/pest/.test(deps)) return 'vendor/bin/pest';
      if (/phpunit\/phpunit/.test(deps)) return 'vendor/bin/phpunit';
      return null;
    }, 'php'],
  ];
  for (const [re, command, kind] of others) {
    for (const f of files.filter((x) => re.test(x)).sort((a, b) => a.length - b.length)) {
      const d = dirOf(f);
      if (under(d, kind)) continue;
      const cmd = command(d, f);
      if (cmd) add(d, cmd, kind);
    }
  }

  // Test files no entry above runs: a language framed has no rule for, or a runner it missed.
  // Reported so setup asks for the command instead of saying "no unit tests".
  const runs = (f) => tests.concat(skipped).some((t) => (t.path === '.' || f.startsWith(`${t.path}/`))
    && (!KIND_EXTS[t.kind] || KIND_EXTS[t.kind].includes(extOf(f))));
  const unrun = new Map(); // ext -> { count, example }
  const NOT_CODE = /\.(json|ya?ml|snap|md|txt|html?|s?css|xml|csv|png|svg)$/i; // tsconfig.spec.json is config
  for (const f of files) {
    if (!isTestFile(f) || NOT_CODE.test(f) || runs(f)) continue;
    const e = extOf(f);
    if (!unrun.has(e)) unrun.set(e, { ext: e, testFiles: 0, example: f });
    unrun.get(e).testFiles += 1;
  }
  return { tests, skipped, noRunner, unrun: [...unrun.values()].sort((a, b) => b.testFiles - a.testFiles) };
}

function listBranches(root) {
  const out = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  const names = new Set();
  for (const ref of out.split(/\r?\n/).filter(Boolean)) {
    if (ref.endsWith('/HEAD')) continue;
    if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length));
    else names.add(ref.split('/').slice(3).join('/')); // refs/remotes/<remote>/<name>
  }
  return [...names];
}

function detectDefaultBranch(root) {
  try {
    return git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '');
  } catch {
    const branches = listBranches(root);
    return ['main', 'master', 'develop'].find((b) => branches.includes(b)) || 'main';
  }
}

function detectConventions(root) {
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const defaultBranch = detectDefaultBranch(root);
  const branches = listBranches(root).filter((b) => b !== defaultBranch && b !== INIT_BRANCH);
  let subjects = [];
  try { subjects = git(root, ['log', '-500', '--format=%s']).split(/\r?\n/); } catch { /* empty repo */ }
  const prefixes = detectPrefixes(branches, subjects);
  const pattern = detectBranchPattern(branches, prefixes.prefixes);
  const tests = detectTests(root, files);
  return {
    defaultBranch,
    ticketPrefixes: prefixes.prefixes,
    branchPattern: pattern.pattern,
    tests: tests.tests.map(({ path: p, command }) => ({ path: p, command })),
    evidence: {
      ticketPrefixes: prefixes.evidence,
      branchPattern: { convention: pattern.convention, ...(typeof pattern.evidence === 'object' ? pattern.evidence : { note: pattern.evidence }) },
      testsFound: tests.tests.map(({ path: p, command, testFiles }) => ({ path: p, command, testFiles })),
      testsSkipped: tests.skipped.map(({ path: p, command, reason, testFiles }) => ({ path: p, command, testFiles, reason })),
      noTestRunner: tests.noRunner,
      testFilesNothingRuns: tests.unrun,
      unitTests: tests.tests.length ? 'found'
        : tests.unrun.length ? 'unknown: test files exist but no runner was detected; ask the user for the command'
          : 'none: the first fix in each project adds its tests (with the user\'s consent)',
    },
  };
}

function cmdDetect(argv) {
  const root = resolveRoot(argv);
  let result;
  try {
    result = detectConventions(root);
  } catch (e) {
    console.error(`framed: ${root} is not a git repository, or git failed (${e.message})`);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

// ---- map scan (design doc §5, three mechanical sources) -------------------------------------
// Produces the file-level graph: files with module and language, edges tagged with their
// source (static / co-change / test), and a per-file "has tests" flag. Mechanical, no model,
// regenerable in seconds, so it is a cache (gitignored), not an artifact. Two readers: the
// map-builder model pass (which writes the one-page module-level map) and the patch flow's
// blast-radius check.
//
//   node framed.js map scan --root <repo> --out <file.json> [--commits 1000] [--max-files 30] [--min-cochange 3]

const BINARY_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'pdf', 'woff', 'woff2', 'ttf', 'eot', 'zip', 'dll', 'exe', 'pfx', 'snk', 'mp4', 'mp3', 'webp', 'bmp']);
const LANG_BY_EXT = {
  cs: 'csharp', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  vue: 'vue', svelte: 'svelte', dart: 'dart', swift: 'swift', scala: 'scala',
  py: 'python', java: 'java', rb: 'ruby', go: 'go', php: 'php', kt: 'kotlin', rs: 'rust', sql: 'sql', sh: 'shell', ps1: 'powershell', json: 'json', yaml: 'yaml', yml: 'yaml',
  md: 'markdown', css: 'css', scss: 'css', html: 'html', xml: 'xml', csproj: 'msbuild', props: 'msbuild', sln: 'sln',
};
const CODE_LANGS = ['csharp', 'typescript', 'javascript', 'vue', 'svelte', 'python', 'java', 'ruby', 'go', 'php', 'kotlin', 'rust', 'dart', 'swift', 'scala'];
// the languages whose imports the scan reads (staticCSharp, staticTs, staticPython, …); others rely on co-change
const STATIC_LANGS = ['csharp', 'typescript', 'javascript', 'vue', 'svelte', 'python', 'go', 'java', 'kotlin', 'php', 'ruby'];
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json'];
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|Tests?\.cs$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;

function argValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'], ...opts }).toString();
}

function toPosix(p) { return p.split(path.sep).join('/'); }
function dirOf(p) { const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i); }
function extOf(p) { const m = p.match(/\.([A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : ''; }
function readText(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

// Module = nearest ancestor folder holding a .csproj, project.json or package.json; else the
// first two path segments. Markers are found among tracked files, so node_modules never counts.
// A marker inside a dot-folder (.vite, .next, .nx, ...) is tool output someone committed, not a
// project: its files belong to the nearest real project above it.
const IN_DOT_DIR = /(^|\/)\.[^/]+\//;
function buildModules(files) {
  const markers = new Map(); // dir -> { name, kind }
  for (const f of files) {
    if (IN_DOT_DIR.test(f)) continue;
    const ext = extOf(f);
    const base = f.slice(f.lastIndexOf('/') + 1);
    if (ext === 'csproj') markers.set(dirOf(f), { name: base.replace(/\.csproj$/, ''), kind: 'csproj' });
    else if (base === 'project.json' && !markers.has(dirOf(f))) markers.set(dirOf(f), { name: null, kind: 'project.json' });
    else if (base === 'package.json' && !markers.has(dirOf(f))) markers.set(dirOf(f), { name: null, kind: 'package.json' });
  }
  const moduleOf = new Map();
  const modules = new Map(); // name -> { name, path, kind, files }
  for (const f of files) {
    let dir = dirOf(f);
    let hit = null;
    while (true) {
      if (markers.has(dir)) { hit = dir; break; }
      if (dir === '') break;
      dir = dirOf(dir);
    }
    let name;
    let kind;
    if (hit !== null) {
      const m = markers.get(hit);
      name = m.name || hit.slice(hit.lastIndexOf('/') + 1) || '(root)';
      kind = m.kind;
    } else {
      // No project marker: group by top-level folder. Coarse on purpose; these are usually docs,
      // data, scripts, not code modules. The map lists them in one line.
      name = f.includes('/') ? f.split('/')[0] : '(root)';
      kind = 'folder';
    }
    moduleOf.set(f, name);
    if (!modules.has(name)) modules.set(name, { name, path: hit !== null ? hit : (name === '(root)' ? '' : name), kind, files: 0 });
    modules.get(name).files += 1;
  }
  const projectOf = new Map(moduleOf); // the unsplit project name, e.g. for "is this a .Tests project"
  splitLargeModules(moduleOf, modules);
  return { moduleOf, modules, projectOf };
}

// One project can be most of the app: a Rails or Django app has no project file below the root,
// and a big .NET or Node project is one marker over thousands of files. A one-module map tells
// the patch flow nothing, so a module with more than SPLIT_LIMIT code files is divided by its
// subfolders, again for each part still over the limit. Files directly in the folder stay in
// the module; a part is named by its path inside it, e.g. "(root)" gives "app/models".
const SPLIT_LIMIT = 300;
const SPLIT_MIN_PART = 30; // a smaller subfolder stays in its parent, so the map doesn't shatter

function splitLargeModules(moduleOf, modules) {
  const filesOf = new Map();
  for (const [f, m] of moduleOf) {
    if (!filesOf.has(m)) filesOf.set(m, []);
    filesOf.get(m).push(f);
  }
  const codeCount = (list) => list.filter((f) => CODE_EXT.test(f)).length;
  const split = (mod, name, base, list) => {
    if (codeCount(list) <= SPLIT_LIMIT) return;
    const groups = new Map(); // first folder under base -> files
    for (const f of list) {
      const rel = base ? f.slice(base.length + 1) : f;
      if (!rel.includes('/')) continue; // directly in the folder: stays
      const seg = rel.slice(0, rel.indexOf('/'));
      if (!groups.has(seg)) groups.set(seg, []);
      groups.get(seg).push(f);
    }
    // A wrapper folder holding nearly all the code (src/, lib/) is stepped through, not made a part.
    const big = [...groups].filter(([, part]) => codeCount(part) >= SPLIT_MIN_PART);
    if (big.length === 1 && codeCount(list) - codeCount(big[0][1]) < SPLIT_MIN_PART) {
      split(mod, name, base ? `${base}/${big[0][0]}` : big[0][0], big[0][1]);
      return;
    }
    for (const [seg, part] of groups) {
      if (codeCount(part) < SPLIT_MIN_PART) continue;
      const partPath = base ? `${base}/${seg}` : seg;
      const rel = mod.path ? partPath.slice(mod.path.length + 1) : partPath;
      const partName = mod.name === '(root)' ? rel : `${mod.name}/${rel}`;
      if (modules.has(partName) && partName !== name) continue; // never merge into another module
      for (const f of part) moduleOf.set(f, partName);
      modules.set(partName, { name: partName, path: partPath, kind: mod.kind, files: part.length, partOf: mod.name });
      modules.get(name).files -= part.length;
      split(mod, partName, partPath, part);
    }
    if (modules.get(name).files === 0) modules.delete(name);
  };
  for (const mod of [...modules.values()]) split(mod, mod.name, mod.path, filesOf.get(mod.name) || []);
}

// --- static: C# ---
// Index every `namespace X` and every type declared in it. A file that `using`s namespace X gets
// an edge to each file in X that declares a type name appearing as a word in the importing file.
// Same-namespace references need no using, so a file's own namespace is always searched.
// Visibility follows the compiler: a file sees types in its own project and in projects reachable
// through ProjectReference. Without this, a type name several projects each declare in the same
// namespace (an `Extensions` class in Microsoft.Extensions.Hosting, a partial `Program`) would
// link every project to every other. Files outside any .csproj see everything, as before.
function csprojVisibility(root, files) {
  const projects = files.filter((f) => extOf(f) === 'csproj');
  const projDirs = new Set(projects.map(dirOf));
  const refs = new Map(); // csproj dir -> Set(csproj dir)
  for (const pj of projects) {
    const set = new Set();
    for (const m of readText(root, pj).matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      set.add(dirOf(toPosix(path.posix.normalize(path.posix.join(dirOf(pj), m[1].split('\\').join('/'))))));
    }
    refs.set(dirOf(pj), set);
  }
  const reach = new Map();
  const visible = (d) => {
    if (reach.has(d)) return reach.get(d);
    const seen = new Set([d]);
    reach.set(d, seen);
    for (const r of refs.get(d) || []) for (const x of visible(r)) seen.add(x);
    return seen;
  };
  const projectOf = (f) => {
    for (let d = dirOf(f); ; d = dirOf(d)) {
      if (projDirs.has(d)) return d;
      if (d === '') return null;
    }
  };
  return { projectOf, visible };
}

function staticCSharp(root, files, addEdge) {
  const csFiles = files.filter((f) => extOf(f) === 'cs');
  const { projectOf, visible } = csprojVisibility(root, files);
  const projOfFile = new Map(csFiles.map((f) => [f, projectOf(f)]));
  const texts = new Map();
  const nsOfFile = new Map();
  const typesByNs = new Map(); // ns -> Map(typeName -> Set(files))
  const typeDeclRe = /\b(?:class|interface|record|struct|enum|delegate)\s+([A-Z][A-Za-z0-9_]*)/g;
  for (const f of csFiles) {
    const text = readText(root, f);
    texts.set(f, text);
    const nsMatches = [...text.matchAll(/^\s*namespace\s+([A-Za-z_][\w.]*)\s*[;{]?/gm)].map((m) => m[1]);
    const nss = nsMatches.length ? [...new Set(nsMatches)] : ['(global)'];
    nsOfFile.set(f, nss);
    const types = new Set([...text.matchAll(typeDeclRe)].map((m) => m[1]));
    for (const ns of nss) {
      if (!typesByNs.has(ns)) typesByNs.set(ns, new Map());
      const tmap = typesByNs.get(ns);
      for (const t of types) {
        if (!tmap.has(t)) tmap.set(t, new Set());
        tmap.get(t).add(f);
      }
    }
  }
  let edges = 0;
  for (const f of csFiles) {
    const text = texts.get(f);
    const usings = new Set(nsOfFile.get(f));
    for (const m of text.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm)) {
      usings.add(m[1]);
      const parent = m[1].slice(0, m[1].lastIndexOf('.'));
      if (parent) usings.add(parent); // `using static A.B.C` names a type; its namespace is A.B
    }
    const words = new Set(text.match(/[A-Z][A-Za-z0-9_]*/g) || []);
    const mine = projOfFile.get(f);
    const sees = mine === null ? null : visible(mine);
    for (const ns of usings) {
      const tmap = typesByNs.get(ns);
      if (!tmap) continue;
      for (const [t, declFiles] of tmap) {
        if (!words.has(t)) continue;
        for (const g of declFiles) {
          if (g === f) continue;
          const theirs = projOfFile.get(g);
          if (sees && theirs !== null && !sees.has(theirs)) continue;
          addEdge(f, g, 'static'); edges += 1;
        }
      }
    }
  }
  return { files: csFiles.length, edges };
}

// --- static: csproj ProjectReference -> module-level edges, exact ---
function staticCsproj(root, files, moduleOf, addModuleEdge) {
  let edges = 0;
  for (const f of files.filter((x) => extOf(x) === 'csproj')) {
    const text = readText(root, f);
    for (const m of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
      const target = toPosix(path.posix.normalize(path.posix.join(dirOf(f), m[1].split('\\').join('/'))));
      const targetMod = moduleOf.get(target);
      if (targetMod) { addModuleEdge(moduleOf.get(f), targetMod, 'static'); edges += 1; }
    }
  }
  return { edges };
}

// --- static: TypeScript / JavaScript ---
// Relative imports resolved with the usual extension and index rules. Alias imports resolved via
// `paths` in any tracked tsconfig*.json (nearest one whose paths match wins). Bare package
// imports are external and skipped.

// tsconfig is JSON with comments and trailing commas. Strip those without touching string
// literals: a regex cannot tell that "@/*" opens no comment and "**/*.ts" closes none (FRM-1).
function stripJsonComments(text) {
  let out = '';
  let pendingComma = -1; // index in out of a comma that is trailing unless a value follows
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j += 1; j += 1; }
      out += text.slice(i, j + 1); i = j + 1; pendingComma = -1; continue;
    }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
    if (ch === ',') { out += ch; pendingComma = out.length - 1; i += 1; continue; }
    if (!/\s/.test(ch)) {
      if ((ch === '}' || ch === ']') && pendingComma !== -1) out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      pendingComma = -1;
    }
    out += ch; i += 1;
  }
  return out;
}

function loadTsPaths(root, files) {
  const configs = [];
  for (const f of files.filter((x) => /(^|\/)tsconfig[^/]*\.json$/.test(x))) {
    let json;
    try { json = JSON.parse(stripJsonComments(readText(root, f))); } catch { continue; }
    const paths = json && json.compilerOptions && json.compilerOptions.paths;
    if (!paths) continue;
    const baseUrl = (json.compilerOptions.baseUrl || '.');
    const baseDir = toPosix(path.posix.normalize(path.posix.join(dirOf(f), baseUrl)));
    configs.push({ dir: dirOf(f), baseDir, paths });
  }
  return configs;
}

function matchesAlias(spec, pattern) {
  const star = pattern.indexOf('*');
  if (star === -1) return spec === pattern || spec.startsWith(`${pattern}/`);
  return spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
}

// ESM and NodeNext code imports the compiled name: "./x.js" for x.ts (found on 21 public repos)
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
function resolveTsFile(fileSet, candidate) {
  const c = candidate.replace(/\/+$/, '');
  if (fileSet.has(c) && /\.[a-z]+$/.test(c) && !fileSet.has(`${c}/index.ts`)) return c;
  const ext = (c.match(/\.[cm]?jsx?$/) || [])[0];
  if (ext) for (const t of JS_TO_TS[ext]) if (fileSet.has(c.slice(0, -ext.length) + t)) return c.slice(0, -ext.length) + t;
  for (const e of TS_EXTS) if (fileSet.has(c + e)) return c + e;
  for (const e of TS_EXTS) if (fileSet.has(`${c}/index${e}`)) return `${c}/index${e}`;
  if (fileSet.has(c)) return c;
  return null;
}

// Workspace packages by name, so `import x from "@acme/lib/utils"` in a monorepo reaches the
// package's own files: its exports map, then main/types/module, then src/ and the folder itself.
function loadWorkspacePackages(root, files) {
  const pkgs = new Map();
  const subpathImports = []; // { dir, imports } for package.json "imports" ("#lib/*": "./src/lib/*")
  for (const f of files.filter((x) => /(^|\/)package\.json$/.test(x) && !/node_modules\//.test(x))) {
    let json;
    try { json = JSON.parse(readText(root, f)); } catch { continue; }
    if (json && typeof json.name === 'string' && dirOf(f)) pkgs.set(json.name, { dir: dirOf(f), json });
    if (json && json.imports && typeof json.imports === 'object') subpathImports.push({ dir: dirOf(f), imports: json.imports });
  }
  pkgs.subpathImports = subpathImports.sort((a, b) => b.dir.length - a.dir.length);
  return pkgs;
}
// "#lib/x" from the nearest package.json above the importing file
function resolveSubpathImport(fileSet, pkgs, spec, fromFile) {
  const owner = pkgs.subpathImports.find((p) => p.dir === '' || fromFile.startsWith(`${p.dir}/`));
  if (!owner) return null;
  const pick = (v) => (typeof v === 'string' ? v : v && (v.types || v.import || v.default || v.require));
  for (const [k, v] of Object.entries(owner.imports)) {
    const star = k.indexOf('*');
    let target = null;
    if (star === -1) { if (spec === k) target = pick(v); }
    else if (spec.startsWith(k.slice(0, star)) && spec.endsWith(k.slice(star + 1))) {
      const p = pick(v);
      if (p) target = p.replace('*', spec.slice(star, spec.length - (k.length - star - 1)));
    }
    if (target) { const hit = resolveTsFile(fileSet, toPosix(path.posix.normalize(path.posix.join(owner.dir, target)))); if (hit) return hit; }
  }
  return null;
}
function resolveWorkspaceImport(fileSet, pkgs, spec) {
  let name = null;
  for (const n of pkgs.keys()) if ((spec === n || spec.startsWith(`${n}/`)) && (!name || n.length > name.length)) name = n;
  if (!name) return { matched: false, target: null };
  const { dir, json } = pkgs.get(name);
  const sub = spec.slice(name.length).replace(/^\//, '');
  const cands = [];
  const fromExports = (key) => {
    const ex = json.exports;
    if (!ex || typeof ex !== 'object') return;
    const pick = (v) => (typeof v === 'string' ? v : v && (v.types || v.import || v.default || v.require));
    if (ex[key]) cands.push(pick(ex[key]));
    for (const [k, v] of Object.entries(ex)) {
      const star = k.indexOf('*');
      if (star !== -1 && key.startsWith(k.slice(0, star)) && key.endsWith(k.slice(star + 1))) {
        const p = pick(v);
        if (p) cands.push(p.replace('*', key.slice(star, key.length - (k.length - star - 1))));
      }
    }
  };
  if (!sub) {
    fromExports('.');
    for (const k of ['source', 'types', 'typings', 'module', 'main']) if (typeof json[k] === 'string') cands.push(json[k]);
    cands.push('src/index', 'index');
  } else {
    fromExports(`./${sub}`);
    cands.push(sub, `src/${sub}`);
  }
  for (const c of cands.filter(Boolean)) {
    const base = toPosix(path.posix.normalize(path.posix.join(dir, c)));
    // built output points at its source: dist/x.js -> src/x.ts
    const target = resolveTsFile(fileSet, base) || resolveTsFile(fileSet, base.replace(/\/(dist|build|lib|out)\//, '/src/'));
    if (target) return { matched: true, target };
  }
  return { matched: true, target: null };
}

function staticTs(root, files, fileSet, addEdge) {
  // .vue and .svelte files import from their <script> blocks; the same pattern reads them
  const tsFiles = files.filter((f) => ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(extOf(f)));
  const tsConfigs = loadTsPaths(root, files);
  const workspace = loadWorkspacePackages(root, files);
  const importRe = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
  let edges = 0;
  let unresolvedAlias = 0;
  let unresolvedRelative = 0;
  let unresolvedWorkspace = 0;
  let viaWorkspace = 0;
  for (const f of tsFiles) {
    const text = readText(root, f);
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] || m[2];
      if (!spec) continue;
      let target = null;
      const isAsset = spec.includes('?') || /\.(svg|png|jpe?g|gif|webp|ico|s?css|less|json|md|woff2?|ttf|txt|html)$/.test(spec);
      if (spec.startsWith('.')) {
        target = resolveTsFile(fileSet, toPosix(path.posix.normalize(path.posix.join(dirOf(f), spec))));
        if (!target && !isAsset) unresolvedRelative += 1;
      } else {
        // alias? try tsconfigs whose dir is an ancestor of f first
        const applicable = tsConfigs.filter((c) => f.startsWith(c.dir ? `${c.dir}/` : ''))
          .sort((a, b) => b.dir.length - a.dir.length);
        for (const c of applicable) {
          for (const [pattern, targets] of Object.entries(c.paths)) {
            const star = pattern.indexOf('*');
            let rest = null;
            // an alias without "*" still takes a subpath: "@acme/lib" -> "../lib" serves "@acme/lib/x"
            if (star === -1) { if (spec === pattern) rest = ''; else if (spec.startsWith(`${pattern}/`)) rest = spec.slice(pattern.length); }
            else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1))) {
              rest = spec.slice(star, spec.length - (pattern.length - star - 1));
            }
            if (rest === null) continue;
            for (const t of targets) {
              const cand = toPosix(path.posix.normalize(path.posix.join(c.baseDir, star === -1 ? t + rest : t.replace('*', rest))));
              target = resolveTsFile(fileSet, cand);
              if (target) break;
            }
            if (target) break;
          }
          if (target) break;
        }
        // Node subpath imports ("#lib/x"), declared in package.json, not tsconfig
        if (!target && spec.startsWith('#')) target = resolveSubpathImport(fileSet, workspace, spec, f);
        // a package of this repo, imported by its name
        if (!target) {
          const w = resolveWorkspaceImport(fileSet, workspace, spec);
          if (w.target) { target = w.target; viaWorkspace += 1; } else if (w.matched && !isAsset) unresolvedWorkspace += 1;
        }
        // Count a miss only when the import really matches an alias pattern ("@/x" for "@/*", not
        // "@reduxjs/toolkit") and points at code, not an asset like "icon.svg?react".
        if (!target && !isAsset && tsConfigs.some((c) => Object.keys(c.paths).some((p) => matchesAlias(spec, p)))) {
          unresolvedAlias += 1;
          if (process.env.FRAMED_DEBUG && unresolvedAlias <= 15) console.error(`framed debug: unresolved alias "${spec}" in ${f}`);
        }
      }
      if (target && target !== f) { addEdge(f, target, 'static'); edges += 1; }
    }
  }
  return { files: tsFiles.length, edges, unresolvedAlias, unresolvedRelative, unresolvedWorkspace, viaWorkspace, workspacePackages: workspace.size, tsconfigsWithPaths: tsConfigs.length };
}

// --- static: Python, Go, Java/Kotlin, PHP, Ruby ---------------------------------------------
// One reader per language, text matching only, like the TS one. On 21 public repos these languages
// had no static edges at all, so their blast radius came from git history alone.
// A same-package reference without an import (Java, Kotlin, PHP) or a Rails constant counts too:
// in those languages that is how files use each other.
const SAME_PACKAGE_CAP = 200; // a package with more classes than this is too broad to scan by name

function nearest(cands, from) {
  if (cands.length <= 1) return cands[0] || null;
  // the candidate sharing the longest folder prefix with the importer; a tie is too ambiguous
  const score = (c) => { const a = c.split('/'), b = from.split('/'); let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; };
  const ranked = cands.map((c) => [c, score(c)]).sort((x, y) => y[1] - x[1]);
  return ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
}

function staticPython(root, files, addEdge) {
  const py = files.filter((f) => extOf(f) === 'py');
  if (!py.length) return { files: 0, edges: 0 };
  const pkgDirs = new Set(py.filter((f) => /(^|\/)__init__\.py$/.test(f)).map(dirOf));
  // module name = path from the first folder above the top package (src/flask/app.py -> flask.app)
  const rootOf = (f) => { let d = dirOf(f); while (d && pkgDirs.has(d)) d = dirOf(d); return pkgDirs.has(d) ? '' : d; };
  const index = new Map();
  for (const f of py) {
    const r = rootOf(f);
    const name = (r ? f.slice(r.length + 1) : f).replace(/\.py$/, '').replace(/\/__init__$/, '').split('/').join('.');
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(f);
  }
  const lookup = (name, from) => nearest(index.get(name) || [], from);
  const pySet = new Set(py);
  const fileIn = (dir, rel) => {
    const base = [dir, rel].filter(Boolean).join('/');
    return pySet.has(`${base}.py`) ? `${base}.py` : pySet.has(`${base}/__init__.py`) ? `${base}/__init__.py` : null;
  };
  let edges = 0;
  const link = (f, t) => { if (t && t !== f) { addEdge(f, t, 'static'); edges += 1; } };
  for (const f of py) {
    const text = readText(root, f);
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm)) {
      for (const part of m[1].split(',')) link(f, lookup(part.trim().split(/\s+/)[0], f));
    }
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*)/gm)) {
      const dots = m[1].length, mod = m[2];
      const names = m[3].replace(/[()]/g, ' ').split(',').map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== '*');
      if (dots) {
        let dir = dirOf(f);
        for (let i = 1; i < dots; i += 1) dir = dirOf(dir);
        const rel = mod.split('.').filter(Boolean).join('/');
        let hit = false;
        for (const n of names) { const t = fileIn(dir, [rel, n].filter(Boolean).join('/')); if (t) { link(f, t); hit = true; } }
        if (!hit) link(f, fileIn(dir, rel) || (rel ? null : fileIn(dir, '__init__')));
      } else {
        let hit = false;
        for (const n of names) { const t = lookup(`${mod}.${n}`, f); if (t) { link(f, t); hit = true; } } // a submodule
        if (!hit) link(f, lookup(mod, f));
      }
    }
  }
  return { files: py.length, edges };
}

function staticGo(root, files, addEdge) {
  const go = files.filter((f) => extOf(f) === 'go');
  if (!go.length) return { files: 0, edges: 0 };
  const mods = files.filter((f) => /(^|\/)go\.mod$/.test(f)).map((f) => ({ dir: dirOf(f), path: ((readText(root, f).match(/^module\s+(\S+)/m) || [])[1]) })).filter((m) => m.path)
    .sort((a, b) => b.path.length - a.path.length);
  const byDir = new Map();
  for (const f of go) if (!/_test\.go$/.test(f)) { const d = dirOf(f); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
  let edges = 0;
  for (const f of go) {
    const text = readText(root, f);
    const specs = [...text.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)].map((m) => m[1]);
    for (const block of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const m of block[1].matchAll(/"([^"]+)"/g)) specs.push(m[1]);
    for (const spec of specs) {
      const mod = mods.find((m) => spec === m.path || spec.startsWith(`${m.path}/`));
      if (!mod) continue;
      const dir = [mod.dir, spec.slice(mod.path.length + 1)].filter(Boolean).join('/');
      for (const t of byDir.get(dir) || []) if (t !== f) { addEdge(f, t, 'static'); edges += 1; } // the package's files
    }
  }
  return { files: go.length, edges, modules: mods.length };
}

// Java, Kotlin and PHP: classes by namespace. Same-namespace use needs no import, so a class name
// that appears in a file of the same package links them too.
function staticByNamespace(root, files, addEdge, { exts, nsRe, sep, importRes, resolveImport }) {
  const src = files.filter((f) => exts.includes(extOf(f)));
  if (!src.length) return { files: 0, edges: 0 };
  const fqn = new Map(); // a.b.C -> file
  const pkgOf = new Map(); // file -> package
  const byPkg = new Map(); // package -> [[Class, file]]
  for (const f of src) {
    const text = readText(root, f);
    const pkg = ((text.match(nsRe) || [])[1] || '').trim();
    pkgOf.set(f, pkg);
    const names = new Set([path.posix.basename(f).replace(/\.[^.]+$/, '')]);
    for (const m of text.matchAll(/\b(?:class|interface|object|enum|record|trait)\s+([A-Z]\w*)/g)) names.add(m[1]);
    for (const n of names) {
      const key = pkg ? `${pkg}${sep}${n}` : n;
      if (!fqn.has(key)) fqn.set(key, f);
      if (!byPkg.has(pkg)) byPkg.set(pkg, []);
      byPkg.get(pkg).push([n, f]);
    }
  }
  let edges = 0, samePackage = 0;
  const seen = new Set();
  const link = (f, t, same) => { const k = `${f}|${t}`; if (t && t !== f && !seen.has(k)) { seen.add(k); addEdge(f, t, 'static'); edges += 1; if (same) samePackage += 1; } };
  for (const f of src) {
    const text = readText(root, f);
    for (const re of importRes) for (const m of text.matchAll(re)) for (const t of resolveImport(m, { fqn, byPkg, files })) link(f, t, false);
    const mates = byPkg.get(pkgOf.get(f)) || [];
    if (mates.length > 1 && mates.length <= SAME_PACKAGE_CAP) {
      const words = new Set(text.match(/\b[A-Z]\w*/g) || []);
      for (const [n, t] of mates) if (t !== f && words.has(n)) link(f, t, true);
    }
  }
  return { files: src.length, edges, samePackage };
}

function staticJvm(root, files, addEdge) {
  return staticByNamespace(root, files, addEdge, {
    exts: ['java', 'kt'], nsRe: /^\s*package\s+([\w.]+)/m, sep: '.',
    importRes: [/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;?\s*$/gm],
    resolveImport: (m, { fqn, byPkg }) => {
      if (m[2]) return (byPkg.get(m[1]) || []).slice(0, 60).map(([, t]) => t); // import a.b.*
      let name = m[1];
      for (let i = 0; i < 3 && name.includes('.'); i += 1) { // a.b.C, a.b.C.member, a.b.Outer.Inner
        if (fqn.has(name)) return [fqn.get(name)];
        name = name.slice(0, name.lastIndexOf('.'));
      }
      return [];
    },
  });
}

function staticPhp(root, files, addEdge) {
  // PSR-4 from composer.json: "App\\": "app/" -> App\Models\Song is app/Models/Song.php
  const psr4 = [];
  for (const c of files.filter((f) => /(^|\/)composer\.json$/.test(f) && !/vendor\//.test(f))) {
    let json;
    try { json = JSON.parse(readText(root, c)); } catch { continue; }
    for (const sect of [json.autoload, json['autoload-dev']]) {
      for (const [prefix, dirs] of Object.entries((sect && sect['psr-4']) || {})) {
        for (const d of [].concat(dirs)) psr4.push({ prefix, dir: toPosix(path.posix.normalize(path.posix.join(dirOf(c), d))).replace(/\/$/, '').replace(/^\.$/, '') });
      }
    }
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);
  const fileSet = new Set(files);
  return staticByNamespace(root, files, addEdge, {
    exts: ['php'], nsRe: /^\s*namespace\s+([\w\\]+)\s*;/m, sep: '\\',
    importRes: [/^\s*use\s+(?:function\s+|const\s+)?\\?([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm],
    resolveImport: (m, { fqn }) => {
      if (fqn.has(m[1])) return [fqn.get(m[1])];
      const p = psr4.find((x) => m[1].startsWith(x.prefix));
      if (!p) return [];
      const file = [p.dir, `${m[1].slice(p.prefix.length).split('\\').join('/')}.php`].filter(Boolean).join('/');
      return fileSet.has(file) ? [file] : [];
    },
  });
}

// Rails (Zeitwerk): a constant is a file under an autoload root, Admin::UsersController ->
// app/controllers/admin/users_controller.rb. Matched without case or underscores, so API::V1 finds
// api/v1. Specs reference constants too, which links each spec to the code it tests.
function staticRuby(root, files, addEdge) {
  const rb = files.filter((f) => extOf(f) === 'rb');
  if (!rb.length) return { files: 0, edges: 0 };
  const rootOf = (f) => { const m = f.match(/^(.*?(?:^|\/)app\/[^/]+(?:\/concerns)?)\// ) || f.match(/^(.*?(?:^|\/)lib)\//); return m ? m[1] : null; };
  const keyOf = (rel) => rel.replace(/\.rb$/, '').split('/').map((s) => s.replace(/_/g, '').toLowerCase()).join('::');
  const index = new Map();
  for (const f of rb) {
    const r = rootOf(f);
    if (!r) continue;
    const k = keyOf(f.slice(r.length + 1));
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(f);
  }
  let edges = 0;
  const seen = new Set();
  for (const f of rb) {
    const text = readText(root, f).replace(/^\s*#.*$/gm, '');
    const r = rootOf(f);
    const ns = r ? keyOf(f.slice(r.length + 1)).split('::').slice(0, -1) : [];
    for (const ref of new Set(text.match(/\b[A-Z][A-Za-z0-9]*(?:::[A-Z][A-Za-z0-9]*)*/g) || [])) {
      const k = ref.split('::').map((s) => s.toLowerCase()).join('::');
      // lexical lookup: Foo inside Admin:: may be Admin::Foo
      let t = null;
      for (let i = ns.length; i >= 0 && !t; i -= 1) t = nearest(index.get([...ns.slice(0, i), k].join('::')) || [], f);
      if (t && t !== f && !seen.has(`${f}|${t}`)) { seen.add(`${f}|${t}`); addEdge(f, t, 'static'); edges += 1; }
    }
  }
  return { files: rb.length, edges, constants: index.size };
}

// --- co-change: files that repeatedly change in the same commit ---
// Files that change with everything and depend on nothing. On 21 public repos they were 45-100%
// of co-change links (flask's top "dependent" of app.py was CHANGES.rst), so they are left out
// of co-change. They stay in the scan as files.
const COCHANGE_NOISE = new RegExp([
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|packages\.lock\.json|[^/]+\.lock)$/,
  /(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|RELEASE[-_ ]?NOTES|README|CONTRIBUTING|AUTHORS)[^/]*$/i, /\.(md|mdx|rst|adoc|txt)$/i,
  /(^|\/)(locales?|i18n|lang|translations?|l10n)\//i, /(^|\/)translation\.json$/i, /\.(po|pot|resx|xlf|arb)$/i,
  /\.snap$/, /(^|\/)__snapshots__\//, /\.(g|generated|designer)\.[a-z]+$/i, /ModelSnapshot\.cs$/,
  /(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i,
  /(^|\/)(Directory\.(Packages|Build)\.(props|targets)|libs\.versions\.toml|Cargo\.toml|go\.mod|package\.json)$/, /\.(csproj|fsproj|vbproj|sln|slnx)$/i,
].map((r) => r.source).join('|'), 'i');

function coChange(root, fileSet, { commits, maxFiles, minCount }, addEdge) {
  let log = '';
  // %x1e marks each commit, whatever the hash length (SHA-256 repos); quotePath keeps non-ASCII paths
  try { log = git(root, ['-c', 'core.quotePath=false', 'log', '-n', String(commits), '--format=%x1e%H', '--name-only', '--no-merges']); } catch { /* no commits yet: no history, no co-change */ }
  const pairCounts = new Map();
  let used = 0;
  let skippedBig = 0;
  let noise = 0;
  let current = [];
  const flush = () => {
    if (!current.length) return;
    if (current.length > maxFiles) { skippedBig += 1; current = []; return; }
    const all = [...new Set(current)].filter((f) => fileSet.has(f));
    const tracked = all.filter((f) => !COCHANGE_NOISE.test(f)).sort();
    noise += all.length - tracked.length;
    if (tracked.length >= 2) {
      used += 1;
      for (let i = 0; i < tracked.length; i += 1) {
        for (let j = i + 1; j < tracked.length; j += 1) {
          const key = `${tracked[i]}\n${tracked[j]}`;
          pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }
      }
    }
    current = [];
  };
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('\x1e')) { flush(); continue; }
    if (line.trim()) current.push(line.trim());
  }
  flush();
  let edges = 0;
  for (const [key, n] of pairCounts) {
    if (n < minCount) continue;
    const [a, b] = key.split('\n');
    addEdge(a, b, 'co-change', n);
    edges += 1;
  }
  return { commitsRequested: commits, commitsUsed: used, skippedBig, pairsSeen: pairCounts.size, edges, noiseFilesLeftOut: noise, ...(log ? {} : { note: 'no git history yet' }) };
}

// --- tests as evidence ---
// A test file that statically touches non-test files A and B is a dependency A<->B (source
// `test`). Any non-test file some test touches has tests. Module level: a test module's static
// references mark the referenced module as tested.
// A test touching many files (integration test) still marks them tested, but its pairwise edges
// are weak evidence and grow quadratically, so they are only emitted below the fan-out cap.
const TEST_FANOUT_CAP = 10;

function testsAsEvidence(files, isTest, staticOut, addEdge) {
  const hasTests = new Set();
  let edges = 0;
  let wideTests = 0;
  // a test that imports a package's re-export file (__init__.py, index.ts) touches what it re-exports
  const BARREL = /(^|\/)(__init__\.py|index\.[cm]?[jt]sx?)$/;
  for (const [testFile, targets] of staticOut) {
    if (!isTest(testFile)) continue;
    const srcTargets = [...targets].filter((t) => !isTest(t)).sort();
    for (const t of srcTargets) {
      hasTests.add(t);
      if (BARREL.test(t)) for (const r of staticOut.get(t) || []) if (!isTest(r)) hasTests.add(r);
    }
    if (srcTargets.length > TEST_FANOUT_CAP) { wideTests += 1; continue; }
    for (let i = 0; i < srcTargets.length; i += 1) {
      for (let j = i + 1; j < srcTargets.length; j += 1) { addEdge(srcTargets[i], srcTargets[j], 'test'); edges += 1; }
    }
  }
  return { hasTests, edges, wideTests };
}

function cmdMapScan(argv) {
  const root = resolveRoot(argv);
  const out = argValue(argv, '--out', null);
  if (!out) { console.error('framed: map scan needs --out <file.json>'); return 2; }
  const params = {
    commits: parseInt(argValue(argv, '--commits', '1000'), 10),
    maxFiles: parseInt(argValue(argv, '--max-files', '30'), 10),
    minCount: parseInt(argValue(argv, '--min-cochange', '3'), 10),
  };
  for (const [k, v] of Object.entries(params)) {
    if (!Number.isInteger(v) || v < 1) { console.error(`framed: --${{ commits: 'commits', maxFiles: 'max-files', minCount: 'min-cochange' }[k]} needs a whole number of 1 or more`); return 2; }
  }
  const t0 = Date.now();
  let tracked;
  try {
    tracked = git(root, ['-c', 'core.quotePath=false', 'ls-files', '-z']).split('\0').filter(Boolean);
  } catch (e) {
    console.error(`framed: ${root} is not a git repository, or git failed (${e.message})`);
    return 1;
  }
  // nothing tracked, files on disk: a failed checkout or nothing added yet, not an empty project
  if (!tracked.length) {
    let onDisk = [];
    try { onDisk = fs.readdirSync(root).filter((n) => n !== '.git'); } catch { /* unreadable */ }
    if (onDisk.length) console.error(`framed: warning: git tracks no files here, but the folder has ${onDisk.length} entries. Add them (git add) or check the checkout; the scan will be empty.`);
  }
  const files = tracked.filter((f) => !BINARY_EXT.has(extOf(f)));
  const fileSet = new Set(files);
  const { moduleOf, modules, projectOf } = buildModules(files);
  const isTest = (f) => TEST_PATH_RE.test(f) || /\.Tests?$/.test(projectOf.get(f) || '');

  // edges keyed by from|to|source; static edges also kept per-file for the test source
  const edgeMap = new Map();
  const staticOut = new Map(); // file -> Set(targets)
  const addEdge = (from, to, source, weight) => {
    const key = `${from}|${to}|${source}`;
    const cur = edgeMap.get(key);
    if (cur) { if (weight) cur.weight = Math.max(cur.weight || 0, weight); return; }
    edgeMap.set(key, { from, to, source, ...(weight ? { weight } : {}) });
    if (source === 'static') {
      if (!staticOut.has(from)) staticOut.set(from, new Set());
      staticOut.get(from).add(to);
    }
  };
  const moduleEdgeMap = new Map();
  const addModuleEdge = (from, to, source, n = 1) => {
    if (from === to) return;
    const key = `${from}|${to}|${source}`;
    moduleEdgeMap.set(key, (moduleEdgeMap.get(key) || 0) + n);
  };

  const stats = {};
  const ms = { listFiles: Date.now() - t0 };
  const timed = (name, fn) => { const s = Date.now(); const r = fn(); ms[name] = Date.now() - s; return r; };
  stats.csharp = timed('csharp', () => staticCSharp(root, files, addEdge));
  stats.csproj = timed('csproj', () => staticCsproj(root, files, moduleOf, addModuleEdge));
  stats.typescript = timed('typescript', () => staticTs(root, files, fileSet, addEdge));
  stats.python = timed('python', () => staticPython(root, files, addEdge));
  stats.go = timed('go', () => staticGo(root, files, addEdge));
  stats.jvm = timed('jvm', () => staticJvm(root, files, addEdge));
  stats.php = timed('php', () => staticPhp(root, files, addEdge));
  stats.ruby = timed('ruby', () => staticRuby(root, files, addEdge));
  stats.coChange = timed('coChange', () => coChange(root, fileSet, params, addEdge));
  const tests = timed('tests', () => testsAsEvidence(files, isTest, staticOut, addEdge));
  stats.ms = ms;
  stats.tests = {
    testFiles: files.filter(isTest).length, edges: tests.edges, filesWithTests: tests.hasTests.size,
    wideTestsSkippedForEdges: tests.wideTests, fanoutCap: TEST_FANOUT_CAP,
  };

  // aggregate file edges to module level (project references already added). Static edges have
  // a direction (importer -> imported). Co-change and test edges do not, so their module pair is
  // stored in sorted order and the summary prints them with <->.
  for (const e of edgeMap.values()) {
    const a = moduleOf.get(e.from);
    const b = moduleOf.get(e.to);
    if (e.source === 'static') addModuleEdge(a, b, e.source);
    else addModuleEdge(...[a, b].sort(), e.source);
  }

  const fileRecords = files.map((f) => ({
    path: f, module: moduleOf.get(f), lang: LANG_BY_EXT[extOf(f)] || (extOf(f) || 'none'),
    isTest: isTest(f), hasTests: tests.hasTests.has(f),
  }));
  const moduleRecords = [...modules.values()].map((m) => {
    const mf = fileRecords.filter((r) => r.module === m.name);
    const src = mf.filter((r) => !r.isTest && CODE_LANGS.includes(r.lang));
    const langs = {};
    for (const r of mf) langs[r.lang] = (langs[r.lang] || 0) + 1;
    return {
      ...m, langs, sourceFiles: src.length, testFiles: mf.filter((r) => r.isTest).length,
      sourceFilesWithTests: src.filter((r) => r.hasTests).length,
    };
  }).sort((a, b) => b.files - a.files);
  const moduleEdges = [...moduleEdgeMap.entries()].map(([k, n]) => {
    const [from, to, source] = k.split('|');
    return { from, to, source, count: n };
  }).sort((a, b) => b.count - a.count);

  stats.totals = {
    trackedFiles: tracked.length, files: files.length, modules: modules.size,
    edges: edgeMap.size, moduleEdges: moduleEdges.length, seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
  const result = {
    root: toPosix(root), generatedAt: new Date().toISOString(), params, stats,
    modules: moduleRecords, moduleEdges, files: fileRecords, edges: [...edgeMap.values()],
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.error(`framed: scanned ${stats.totals.files} files into ${stats.totals.modules} modules, ${stats.totals.edges} file edges, ${stats.totals.moduleEdges} module edges in ${stats.totals.seconds}s -> ${out}`);
  console.log(JSON.stringify(stats, null, 2));
  return 0;
}

// --- map summary: the compact view the map-builder model pass reads instead of scan.json ---
// scan.json is megabytes of file edges. The model pass needs modules, module edges, test
// coverage, hubs and hidden dependencies. A few hundred lines, printed as text.
const SCAN_REL_PATH = path.join('.framed', 'scan.json');


function cmdMapSummary(argv) {
  const root = resolveRoot(argv);
  const file = argValue(argv, '--in', path.join(root, SCAN_REL_PATH));
  if (!fs.existsSync(file)) { console.error(`framed: no scan at ${file}. Run: framed map scan --root <repo> --out ${SCAN_REL_PATH}`); return 1; }
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

  out.push(`# scan summary for ${s.root}`);
  out.push(`generated ${s.generatedAt}; ${s.stats.totals.files} files, ${s.stats.totals.modules} modules, ${s.stats.totals.edges} file edges`);
  out.push(`sources: static C# ${s.stats.csharp.edges} edges, static TS/JS ${s.stats.typescript.edges}, co-change ${s.stats.coChange.edges} (from ${s.stats.coChange.commitsUsed} commits, ${s.stats.coChange.skippedBig} bulk commits skipped), test ${s.stats.tests.edges}`);
  // code whose imports the scan doesn't read: say so, so the map doesn't read silence as "no links"
  const unread = {};
  for (const f of s.files) if (!f.isTest && CODE_LANGS.includes(f.lang) && !STATIC_LANGS.includes(f.lang)) unread[f.lang] = (unread[f.lang] || 0) + 1;
  if (Object.keys(unread).length) {
    out.push(`imports NOT read for: ${Object.entries(unread).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n} source files)`).join(', ')}. For these, links come from git history only; "no importers" and "untested" are unknown, not facts.`);
  }
  const ts = s.stats.typescript || {};
  if (ts.unresolvedRelative || ts.unresolvedWorkspace) out.push(`unresolved TS/JS imports: ${ts.unresolvedRelative || 0} relative, ${ts.unresolvedWorkspace || 0} to workspace packages, ${ts.unresolvedAlias || 0} via path aliases`);
  out.push('');

  const code = s.modules.filter((m) => m.sourceFiles > 0 || m.testFiles > 0);
  const other = s.modules.filter((m) => !(m.sourceFiles > 0 || m.testFiles > 0));
  out.push('## modules (code)');
  out.push('name | kind | path | langs | source files | test files | source files touched by a test');
  for (const m of code) {
    const langs = Object.entries(m.langs).filter(([l]) => CODE_LANGS.includes(l)).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}:${n}`).join(' ');
    out.push(`${m.name} | ${m.kind} | ${m.path} | ${langs || '-'} | ${m.sourceFiles} | ${m.testFiles} | ${m.sourceFilesWithTests} (${pct(m.sourceFilesWithTests, m.sourceFiles)})`);
  }
  if (other.length) out.push(`\nnon-code folders (${other.length}): ${other.map((m) => `${m.name} (${m.files})`).join(', ')}`);
  out.push('');

  // module edges, one line per pair, sources combined
  const pairs = new Map();
  for (const e of s.moduleEdges) {
    const key = `${e.from}|${e.to}`;
    if (!pairs.has(key)) pairs.set(key, { from: e.from, to: e.to, sources: {} });
    pairs.get(key).sources[e.source] = (pairs.get(key).sources[e.source] || 0) + e.count;
  }
  const pairList = [...pairs.values()].sort((a, b) => Object.values(b.sources).reduce((x, y) => x + y, 0) - Object.values(a.sources).reduce((x, y) => x + y, 0));
  out.push('## module edges (a -> b: a imports b. a <-> b: no import, linked only by git history or shared tests)');
  for (const p of pairList) out.push(`${p.from} ${p.sources.static ? '->' : '<->'} ${p.to}: ${Object.entries(p.sources).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  out.push('');

  // hubs: most referenced source files
  const isTest = new Set(s.files.filter((f) => f.isTest).map((f) => f.path));
  const indeg = new Map();
  for (const e of s.edges) if (e.source === 'static' && !isTest.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const hubs = [...indeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  out.push('## hubs (source files most referenced by other files; changing one is wide)');
  for (const [f, n] of hubs) out.push(`${n} dependents: ${f}`);
  out.push('');

  // hidden dependencies: co-change pairs with no static edge either way
  const stat = new Set(s.edges.filter((e) => e.source === 'static').map((e) => `${e.from}|${e.to}`));
  const hidden = s.edges.filter((e) => e.source === 'co-change' && !stat.has(`${e.from}|${e.to}`) && !stat.has(`${e.to}|${e.from}`)
    && !isTest.has(e.from) && !isTest.has(e.to) && /\.(cs|tsx?|jsx?|py|java)$/.test(e.from) && /\.(cs|tsx?|jsx?|py|java)$/.test(e.to))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 20);
  out.push(`## hidden dependencies (change together in git, no import between them; ${hidden.length} shown)`);
  for (const e of hidden) out.push(`${e.weight}x: ${e.from}  +  ${e.to}`);
  out.push('');

  // isolated: source files with no static edges in or out
  const touched = new Set();
  for (const e of s.edges) if (e.source === 'static') { touched.add(e.from); touched.add(e.to); }
  const isolated = s.files.filter((f) => !f.isTest && CODE_LANGS.includes(f.lang) && !touched.has(f.path));
  out.push(`## isolated source files (no imports in or out; dead code, entry points, or a language the scan cannot read): ${isolated.length}`);
  const byMod = {};
  for (const f of isolated) byMod[f.module] = (byMod[f.module] || 0) + 1;
  for (const [m, n] of Object.entries(byMod).sort((a, b) => b[1] - a[1]).slice(0, 10)) out.push(`${n} in ${m}`);

  console.log(out.join('\n'));
  return 0;
}

// --- map check: did the model pass actually write a usable map? ---
// The skill never trusts the agent's report: a write can fail silently (a broken shell heredoc
// did, on the first real run). Exit 0 only if map.md exists and has every heading the patch
// flow reads, in order.
const MAP_REL_PATH = path.join('.framed', 'map.md');
const MAP_HEADINGS = ['What this is', 'Modules', 'How they connect', 'Watch out', 'Unsure', 'Hand-maintained'];

function cmdMapCheck(argv) {
  const root = resolveRoot(argv);
  const file = path.join(root, MAP_REL_PATH);
  if (!fs.existsSync(file)) { console.error(`framed: no map at ${file}. The model pass did not write it.`); return 1; }
  const text = fs.readFileSync(file, 'utf8');
  const found = [...text.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  const errors = [];
  if (!/^# Map: /m.test(text)) errors.push('missing the "# Map: <name>" title');
  let last = -1;
  for (const h of MAP_HEADINGS) {
    const at = found.indexOf(h);
    if (at === -1) errors.push(`missing section "## ${h}"`);
    else if (at < last) errors.push(`section "## ${h}" is out of order`);
    else last = at;
  }
  const unsure = text.split(/^## Unsure\s*$/m)[1];
  if (unsure !== undefined && !/^\s*-\s+\S/m.test(unsure.split(/^## /m)[0])) errors.push('"## Unsure" is empty; there is always something');
  if (errors.length) {
    console.error(`framed: map at ${file} is not usable:`);
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`framed: map ok: ${file} (${text.split('\n').length} lines, ${MAP_HEADINGS.length} sections)`);
  return 0;
}

// --- deps: dependents of one file, for the blast-radius check (§6) ---
// "Who is affected if I change this file?" Static edges pointing at it (importers), plus
// undirected co-change and test edges touching it. Grouped by source, so the reader can tell
// a resolved import from a historical hunch. Reads scan.json; says so if it is missing.
function cmdDeps(argv) {
  const root = resolveRoot(argv);
  const target = argv.find((a) => !a.startsWith('--') && a !== argValue(argv, '--root', null) && a !== argValue(argv, '--in', null));
  if (!target) { console.error('usage: framed deps <file> [--root <repo>] [--in <scan.json>]'); return 2; }
  const file = argValue(argv, '--in', path.join(root, SCAN_REL_PATH));
  if (!fs.existsSync(file)) { console.error(`framed: no scan at ${file}. Run: framed map scan --root . --out ${SCAN_REL_PATH}`); return 1; }
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rel = toPosix(path.isAbsolute(target) ? path.relative(root, target) : target).replace(/^\.\//, '');
  const rec = s.files.find((f) => f.path === rel) || s.files.find((f) => f.path.toLowerCase() === rel.toLowerCase())
    || (() => { const hits = s.files.filter((f) => f.path.endsWith(`/${rel}`)); return hits.length === 1 ? hits[0] : null; })();
  if (!rec) {
    const near = s.files.filter((f) => f.path.toLowerCase().includes(rel.split('/').pop().toLowerCase())).slice(0, 5).map((f) => f.path);
    console.error(`framed: "${rel}" is not in the scan${near.length ? `. Did you mean: ${near.join(', ')}` : ''}. The scan may be stale: rerun framed map scan.`);
    return 1;
  }
  const modOf = new Map(s.files.map((f) => [f.path, f.module]));
  const groups = { static: [], 'co-change': [], test: [] };
  for (const e of s.edges) {
    if (e.source === 'static' && e.to === rec.path) groups.static.push({ file: e.from });
    else if (e.source !== 'static' && (e.from === rec.path || e.to === rec.path)) {
      groups[e.source].push({ file: e.from === rec.path ? e.to : e.from, weight: e.weight });
    }
  }
  const imports = s.edges.filter((e) => e.source === 'static' && e.from === rec.path).map((e) => e.to);
  const out = [];
  out.push(`# dependents of ${rec.path}`);
  // Imports are read for C# and TS/JS only. Elsewhere "nobody imports it" and "no test touches it"
  // are not known, and saying NO would be a false fact (found on 11 of 21 public repos).
  const reads = STATIC_LANGS.includes(rec.lang);
  const tested = rec.hasTests ? 'yes' : reads ? 'NO' : `unknown (framed doesn't read ${rec.lang} imports yet)`;
  out.push(`module: ${rec.module}; language: ${rec.lang}; touched by a test: ${tested}; scan from ${s.generatedAt}`);
  const total = groups.static.length + groups['co-change'].length + groups.test.length;
  if (groups.static.length >= 50) out.push(`HUB: ${groups.static.length} files import this. Listing by module; expect the full suite to matter.`);
  out.push('');
  out.push(reads ? `## static (${groups.static.length} files import it)` : `## static: not read for ${rec.lang} yet, so importers are unknown. Search the code for its name; co-change below still applies.`);
  if (groups.static.length >= 50) {
    const byMod = {};
    for (const d of groups.static) byMod[modOf.get(d.file)] = (byMod[modOf.get(d.file)] || 0) + 1;
    for (const [m, n] of Object.entries(byMod).sort((a, b) => b[1] - a[1])) out.push(`${n} in ${m}`);
  } else {
    for (const d of groups.static.sort((a, b) => a.file.localeCompare(b.file))) out.push(`${d.file}  [${modOf.get(d.file)}]`);
  }
  out.push('');
  out.push(`## co-change (${groups['co-change'].length} files changed together with it, no import needed)`);
  for (const d of groups['co-change'].sort((a, b) => (b.weight || 0) - (a.weight || 0))) out.push(`${d.weight}x  ${d.file}  [${modOf.get(d.file)}]`);
  out.push('');
  out.push(`## test (${groups.test.length} files share a test with it)`);
  for (const d of groups.test.sort((a, b) => a.file.localeCompare(b.file)).slice(0, 30)) out.push(`${d.file}  [${modOf.get(d.file)}]`);
  if (groups.test.length > 30) out.push(`… ${groups.test.length - 30} more`);
  out.push('');
  out.push(`## it imports (${imports.length}; not dependents, listed so you can see what it leans on)`);
  for (const f of imports.sort().slice(0, 30)) out.push(f);
  if (imports.length > 30) out.push(`… ${imports.length - 30} more`);
  if (total === 0) out.push(reads ? '\nNo dependents found by any source: a leaf, or linked in a way imports and history don\'t show (DI, routes, config). Check the map.' : `\nNo dependents found, but framed doesn't read ${rec.lang} imports yet: search the code for its name before trusting that.`);
  console.log(out.join('\n'));
  return 0;
}

// --- why / reverts: "don't undo what was deliberate" without trusting messages (§11) ---
// Commit and PR messages are context, never evidence: on the first real repo most commits said
// "fix" and one PR title covered several unrelated changes. Two kinds of evidence decide:
//   1. a comment in or right above the lines that explains them  -> `why`, at the blame step
//   2. the fix puts back lines a recent commit removed            -> `reverts`, after the edit
// (A test that pins the behaviour is the third; the suite step already stops on it.)
const RECENT_MONTHS = 12;
const COMMENT_START = /^\s*(\/\/|\/\*|\*(?!\*\/)|#(?!(region|endregion|if|else|elif|endif|pragma|include|define|undef|nullable|!)\b)|--|<!--|'''|"""|;;|REM\b)/i;
const TRAILING_COMMENT = /(?:^|[^:"'/])\/\/\s*\S|\s#\s+\S/; // `code; // why`, `code  # why`, not URLs
// Generated-shape doc comments (XML doc tags, JSDoc tags) describe signatures, not reasons.
const DOC_BOILERPLATE = /^\s*(\/\/\/\s*<\/?(summary|param|returns|typeparam|inheritdoc)\b|\/\/\/\s*$|\*\s*@(param|returns?|type|typedef)\b|\/\*\*\s*$|\*\/\s*$|\*\s*$)/;

function parseRange(spec) {
  const m = String(spec || '').match(/^(\d+)[-,](\d+)$/) || String(spec || '').match(/^(\d+)$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  return a > 0 && b >= a ? [a, b] : null;
}

function mergeThatBrought(root, sha, ref) {
  try {
    const out = git(root, ['log', '--merges', '--ancestry-path', '--reverse', '--format=%h%x02%s', `${sha}..${ref}`]);
    const first = out.split(/\r?\n/).find(Boolean);
    return first ? { sha: first.split('\x02')[0], subject: first.split('\x02')[1] } : null;
  } catch { return null; }
}

function defaultRef(root) {
  let def = 'main';
  try { def = loadConfig(root).config.defaultBranch; } catch { def = detectDefaultBranch(root); }
  try { git(root, ['rev-parse', '--verify', '-q', `origin/${def}`]); return `origin/${def}`; } catch { return def; }
}

function cmdWhy(argv) {
  const root = resolveRoot(argv);
  const pos = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root');
  const [fileArg, rangeArg] = pos;
  const range = parseRange(rangeArg);
  if (!fileArg || !range) { console.error('usage: framed why <file> <first>-<last> [--root <repo>]'); return 2; }
  const rel = toPosix(path.isAbsolute(fileArg) ? path.relative(root, fileArg) : fileArg).replace(/^\.\//, '');
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) { console.error(`framed: no file ${rel}`); return 1; }
  const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
  const [a, b] = [range[0], Math.min(range[1], lines.length)];
  const out = [`# why: ${rel} lines ${a}-${b}`, ''];

  // 1. comments in the block and the 3 lines above it
  const comments = [];
  for (let n = Math.max(1, a - 3); n <= b; n += 1) {
    const t = lines[n - 1] || '';
    if (DOC_BOILERPLATE.test(t)) continue;
    if (COMMENT_START.test(t) || (n >= a && TRAILING_COMMENT.test(t))) comments.push(`${n}: ${t.trim()}`);
  }
  out.push(`## comments in or above the block (${comments.length})`);
  out.push(comments.length ? comments.join('\n') : '(none)');
  out.push('A comment that states a reason or a rule ("must", "because", "keep", a ticket, an order that matters) means: stop and ask before changing this.');
  out.push('');

  // 2. who last touched these lines, recent ones in detail; messages are context only
  let porcelain = '';
  try { porcelain = git(root, ['blame', '--line-porcelain', '-L', `${a},${b}`, '--', rel]); } catch (e) {
    out.push(`## last changes\n(git blame failed: not committed yet, or not in git)`);
    console.log(out.join('\n'));
    return 0;
  }
  const commits = new Map();
  let cur = null;
  for (const line of porcelain.split(/\r?\n/)) {
    const head = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (head) { cur = head[1]; if (!commits.has(cur)) commits.set(cur, { lines: [], time: 0, subject: '' }); commits.get(cur).lines.push(parseInt(head[2], 10)); continue; }
    if (!cur) continue;
    if (line.startsWith('committer-time ')) commits.get(cur).time = parseInt(line.slice(15), 10);
    else if (line.startsWith('summary ')) commits.get(cur).subject = line.slice(8);
  }
  const cutoff = Date.now() / 1000 - RECENT_MONTHS * 30.5 * 86400;
  const ref = defaultRef(root);
  const sorted = [...commits.entries()].sort((x, y) => y[1].time - x[1].time);
  const recent = sorted.filter(([sha, c]) => !/^0+$/.test(sha) && c.time >= cutoff);
  out.push(`## last changes to these lines (${sorted.length} commits, ${recent.length} in the last ${RECENT_MONTHS} months)`);
  for (const [sha, c] of sorted) {
    const date = c.time ? new Date(c.time * 1000).toISOString().slice(0, 10) : '-';
    const span = c.lines.length > 1 ? `${Math.min(...c.lines)}-${Math.max(...c.lines)}` : String(c.lines[0]);
    if (/^0+$/.test(sha)) { out.push(`- lines ${span}: not committed yet`); continue; }
    out.push(`- ${sha.slice(0, 10)} ${date} lines ${span} (${c.lines.length}): "${c.subject}"${c.time >= cutoff ? '  RECENT' : ''}`);
  }
  for (const [sha, c] of recent.slice(0, 5)) {
    const merge = mergeThatBrought(root, sha, ref);
    out.push('');
    out.push(`### ${sha.slice(0, 10)}: what it changed in this block${merge ? ` (merged by ${merge.sha}: "${merge.subject}")` : ''}`);
    let diff = '';
    try { diff = git(root, ['show', '--format=', '--unified=1', '--no-color', sha, '--', rel]); } catch { diff = '(diff unavailable)'; }
    // Keep only the hunks that added a line this commit still owns in the block.
    const owned = new Set(c.lines.map((n) => (lines[n - 1] || '').trim()).filter(Boolean));
    const hunks = [];
    for (const l of diff.split(/\r?\n/)) {
      if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) continue;
      if (l.startsWith('@@')) hunks.push([l]); else if (hunks.length) hunks[hunks.length - 1].push(l);
    }
    const mine = hunks.filter((h) => h.some((l) => l.startsWith('+') && owned.has(l.slice(1).trim())));
    const shown = (mine.length ? mine : hunks).flat();
    out.push(shown.slice(0, 40).join('\n') + (shown.length > 40 ? `\n… ${shown.length - 40} more diff lines` : ''));
  }
  out.push('');
  out.push('Commit and PR messages above are context for the person, not evidence. They never decide on their own.');
  console.log(out.join('\n'));
  return 0;
}

// Lines too generic to count as "putting back" someone's removed code.
function isTrivialLine(t) {
  return t.length < 12 || /^[\s{}()[\];,.]*$/.test(t) || /^(return|break|continue|else|try|finally|default)\b[\s;{]*$/.test(t)
    || /^(\/\/|#|\*|\/\*)/.test(t);
}

function findReverts(root, { months = RECENT_MONTHS } = {}) {
  const diff = git(root, ['diff', '--unified=0', '--no-color', 'HEAD', '--', '.', ':(exclude).framed']);
  const added = new Map(); // file -> [{ n, text }]
  let file = null;
  let lineNo = 0;
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); continue; }
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { lineNo = parseInt(hunk[1], 10); continue; }
    if (!file) continue;
    if (l.startsWith('+')) {
      const t = l.slice(1).trim();
      if (!isTrivialLine(t)) { if (!added.has(file)) added.set(file, []); added.get(file).push({ n: lineNo, text: t }); }
      lineNo += 1;
    }
  }
  const found = [];
  for (const [f, adds] of added) {
    let log = '';
    try { log = git(root, ['log', `--since=${months}.months`, '--no-merges', '--format=%x01%H%x02%cs%x02%s', '-p', '--unified=0', '--no-color', '--', f]); } catch { continue; }
    const byCommit = [];
    for (const chunk of log.split('\x01').filter(Boolean)) {
      const [headLine, ...rest] = chunk.split(/\r?\n/);
      const [sha, date, subject] = headLine.split('\x02');
      const removed = new Set();
      const readded = new Set();
      for (const l of rest) {
        if (l.startsWith('---') || l.startsWith('+++')) continue;
        if (l.startsWith('-')) removed.add(l.slice(1).trim());
        else if (l.startsWith('+')) readded.add(l.slice(1).trim());
      }
      for (const t of readded) removed.delete(t); // moved within the same commit, not removed
      byCommit.push({ sha, date, subject, removed });
    }
    const groups = new Map();
    for (const add of adds) {
      const hit = byCommit.find((c) => c.removed.has(add.text)); // log is newest first
      if (!hit) continue;
      if (!groups.has(hit.sha)) groups.set(hit.sha, { file: f, sha: hit.sha, date: hit.date, subject: hit.subject, lines: [] });
      groups.get(hit.sha).lines.push(add);
    }
    for (const g of groups.values()) {
      // one short coincidental line is not a revert; two lines, or one long one, is
      if (g.lines.length >= 2 || g.lines.some((x) => x.text.length >= 40)) found.push(g);
    }
  }
  return found;
}

function cmdReverts(argv) {
  const root = resolveRoot(argv);
  let found;
  try { found = findReverts(root); } catch (e) { console.error(`framed: ${e.message}`); return 1; }
  if (!found.length) { console.log(`framed: no reverts. The change does not put back lines removed in the last ${RECENT_MONTHS} months.`); return 0; }
  const ref = defaultRef(root);
  const out = [`framed: REVERT. The change puts back lines that a recent commit removed. Stop and ask before keeping it.`, ''];
  for (const g of found) {
    const merge = mergeThatBrought(root, g.sha, ref);
    out.push(`## ${g.file}: ${g.lines.length} line(s) removed by ${g.sha.slice(0, 10)} on ${g.date}`);
    out.push(`commit message (context only): "${g.subject}"${merge ? `; merged by ${merge.sha}: "${merge.subject}"` : ''}`);
    for (const x of g.lines.slice(0, 10)) out.push(`  +${x.n}: ${x.text}`);
    if (g.lines.length > 10) out.push(`  … ${g.lines.length - 10} more`);
    out.push(`see the full removal: git show ${g.sha.slice(0, 10)} -- ${g.file}`);
    out.push('');
  }
  console.log(out.join('\n'));
  return 3;
}

// --- suite: which test commands to run for a change (§10, suite step) ---
// "Full existing suite after" = every project the change touched, plus every project the map
// says depends on those (static imports, or co-change/test links seen 3+ times). If a touched
// file is under no listed project, or there is no scan, run everything: when unsure, run more.
const MODULE_DEP_MIN = 3;

function isUnder(file, dir) { return dir === '.' || dir === '' || file === dir || file.startsWith(`${dir}/`); }

function selectSuites(tests, allTouched, scan) {
  const all = (why) => tests.map((t) => ({ ...t, why }));
  // framed's own files (the config gaining a tests entry, the working file) are not code: they
  // must not make every suite run. Found in the first replay, where a new test project's
  // config entry sent the selection to "run everything".
  const touched = allTouched.filter((f) => !f.startsWith('.framed/'));
  if (!scan) return all('no scan available');
  const outside = touched.filter((f) => !tests.some((t) => isUnder(f, t.path)));
  if (outside.length) return all(`touched file is outside every listed project: ${outside.join(', ')}`);

  const modOf = new Map(scan.files.map((f) => [f.path, f.module]));
  const modPath = new Map(scan.modules.map((m) => [m.name, m.path]));
  const touchedMods = new Set(touched.map((f) => modOf.get(f)).filter(Boolean));
  const reasons = new Map(); // dir -> why
  for (const f of touched) reasons.set(f, `touched ${f}`);
  for (const e of scan.moduleEdges) {
    const strong = e.source === 'static' || e.count >= MODULE_DEP_MIN;
    if (!strong) continue;
    if (touchedMods.has(e.to) && !touchedMods.has(e.from)) reasons.set(modPath.get(e.from), `${e.from} depends on ${e.to} (${e.source})`);
    if (e.source !== 'static' && touchedMods.has(e.from) && !touchedMods.has(e.to)) reasons.set(modPath.get(e.to), `${e.to} linked to ${e.from} (${e.source})`);
  }
  const picked = [];
  for (const t of tests) {
    const hit = [...reasons.entries()].find(([dir]) => dir && isUnder(dir, t.path));
    if (hit) picked.push({ ...t, why: hit[1] });
  }
  return picked.length ? picked : all('no project matched; running everything');
}

function cmdSuite(argv) {
  const root = resolveRoot(argv);
  const touched = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root' && argv[i - 1] !== '--in')
    .map((f) => toPosix(path.isAbsolute(f) ? path.relative(root, f) : f).replace(/^\.\//, ''));
  if (!touched.length) { console.error('usage: framed suite <touched file>... [--root <repo>]'); return 2; }
  let config;
  try {
    const r = loadConfig(root);
    if (r.errors.length) { console.error(`framed: invalid config: ${r.errors.join('; ')}`); return 1; }
    config = r.config;
  } catch (e) { console.error(`framed: ${e.message}`); return 1; }
  const scanFile = argValue(argv, '--in', path.join(root, SCAN_REL_PATH));
  const scan = fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : null;
  console.log(JSON.stringify(selectSuites(config.tests, touched, scan), null, 2));
  return 0;
}

function cmdMap(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'scan') return cmdMapScan(rest);
  if (sub === 'summary') return cmdMapSummary(rest);
  if (sub === 'check') return cmdMapCheck(rest);
  console.error('usage: framed map scan --root <repo> --out <file.json> [--commits N] [--max-files N] [--min-cochange N]\n       framed map summary [--root <repo>] [--in <scan.json>]');
  return 2;
}

// ---- tests by coverage (§10): for suites too big to run on every fix ------------------------
// Opt-in, config testSelection: "coverage". Each test file is run once with the runner's own
// coverage, which records the source files it really executes (DI, reflection, routes included).
// A fix then runs: tests that touch a changed file, tests whose recorded files changed since they
// were recorded (by anyone: re-recorded, since a test only reaches new code when code it already
// runs changes), tests with no record, changed tests. Changes that aren't code but steer behaviour
// run everything.
//
//   node framed.js tests select [--base <ref>] [--changed a,b]   what to run, and why (JSON)
//   node framed.js tests command --test <file>                  how to run one test file with coverage
//   node framed.js tests record --test <file> --coverage <lcov|cobertura> [--failed]
//   node framed.js tests baseline [--limit N]                   run every test file once (resumable)
//   node framed.js tests run [--base <ref>]                     run the selection, re-record, report

const TESTMAP_REL = path.join('.framed', 'testmap.json');
const COVERAGE_TMP_REL = path.join('.framed', 'coverage-tmp');
// changes the map can't vouch for: settings, data, dependencies, startup, shared test setup
const UNTRUSTED_CHANGE = new RegExp([
  /(^|\/)appsettings[^/]*\.json$/, /(^|\/)(web|app)\.config$/i, /(^|\/)\.env[^/]*$/, /\.sql$/i, /(^|\/)migrations?\//i,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile(\.lock)?|composer\.(json|lock)|go\.(mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Cargo\.(toml|lock))$/,
  /\.(csproj|fsproj|vbproj|sln|slnx)$/i, /(^|\/)Directory\.(Build|Packages)\.(props|targets)$/i,
  /(^|\/)(Program|Startup)\.cs$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)(vitest|jest|vite|playwright)\.config\.[cm]?[jt]s$/,
  /(^|\/)(setupTests|test-setup|vitest\.setup|jest\.setup)\.[cm]?[jt]sx?$/, /(^|\/)(conftest\.py|spec_helper\.rb|rails_helper\.rb)$/,
].map((r) => r.source).join('|'));

function readTestmap(root) {
  const m = readJson(path.join(root, TESTMAP_REL));
  return m && m.entries && typeof m.entries === 'object' ? m : { version: 1, entries: {} };
}
function writeTestmap(root, map) {
  fs.mkdirSync(path.join(root, '.framed'), { recursive: true });
  fs.writeFileSync(path.join(root, TESTMAP_REL), `${JSON.stringify(map, null, 1)}\n`);
}

// Coverage report -> covered paths as written in it (lcov: SF lines with a hit; Cobertura: classes with a hit line)
function coveredPaths(text) {
  const out = new Set();
  if (/^\s*<\?xml|<coverage[\s>]/.test(text)) {
    const sources = [...text.matchAll(/<source>([^<]+)<\/source>/g)].map((m) => m[1].trim());
    for (const m of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
      if (/\bhits="[1-9]\d*"/.test(m[2])) out.add(JSON.stringify([m[1], sources]));
    }
    return [...out].map((s) => JSON.parse(s));
  }
  let cur = null, hit = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) { cur = line.slice(3).trim(); hit = false; }
    else if (/^DA:\d+,[1-9]/.test(line) || /^LH:[1-9]/.test(line)) hit = true;
    else if (line.trim() === 'end_of_record') { if (cur && hit) out.add(JSON.stringify([cur, []])); cur = null; }
  }
  return [...out].map((s) => JSON.parse(s));
}

// A path from a coverage report -> repo-relative tracked file, or null (outside the repo, generated)
function repoPathOf(p, sources, root, tracked, lowerTracked) {
  const norm = (x) => x.replace(/\\/g, '/');
  const rootN = norm(root).replace(/\/$/, '');
  const cands = [norm(p), ...sources.map((s) => `${norm(s).replace(/\/$/, '')}/${norm(p)}`)];
  for (let c of cands) {
    if (c.toLowerCase().startsWith(`${rootN.toLowerCase()}/`)) c = c.slice(rootN.length + 1);
    c = c.replace(/^\.\//, '');
    if (tracked.has(c)) return c;
    const lc = lowerTracked.get(c.toLowerCase());
    if (lc) return lc;
  }
  // relative to some project folder: the one tracked file it ends with, if exactly one
  const tail = `/${norm(p).replace(/^\.?\//, '')}`;
  const hits = [...tracked].filter((f) => `/${f}`.endsWith(tail));
  return hits.length === 1 ? hits[0] : null;
}

function trackedFiles(root) {
  try { return git(root, ['ls-files', '-z']).split('\0').filter(Boolean); } catch { return []; }
}
function headSha(root) { try { return git(root, ['rev-parse', 'HEAD']).trim(); } catch { return null; } }
function workingChanges(root) {
  try {
    return git(root, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
      .map((l) => l.slice(3)).filter((f) => f && !f.startsWith('.framed/'));
  } catch { return []; }
}

function recordCoverage(root, test, coverageText, failed) {
  const tracked = new Set(trackedFiles(root));
  const lower = new Map([...tracked].map((f) => [f.toLowerCase(), f]));
  const files = [...new Set(coveredPaths(coverageText).map(([p, src]) => repoPathOf(p, src, root, tracked, lower)).filter(Boolean))]
    .filter((f) => f !== test && !TEST_FILE_RE.test(f)).sort();
  const map = readTestmap(root);
  map.entries[test] = { files, commit: headSha(root), recordedAt: new Date().toISOString(), ...(failed ? { failed: true } : {}) };
  writeTestmap(root, map);
  return map.entries[test];
}

// What to run for a change, and why. Pure: the caller supplies git's answers.
//   changed        files changed by this fix (and anything uncommitted)
//   changedSince   commit -> files changed between that commit and now (for stale entries)
function selectByCoverage({ map, tests, changed, changedSince }) {
  const untrusted = changed.filter((f) => UNTRUSTED_CHANGE.test(f));
  if (!Object.keys(map.entries || {}).length) return { mode: 'full', reason: 'no coverage map yet: run framed tests baseline once', run: [] };
  if (untrusted.length) return { mode: 'full', reason: `changed ${untrusted.slice(0, 3).join(', ')}${untrusted.length > 3 ? ', …' : ''}: settings, data, dependencies or startup can change any test, so the map can't vouch for it`, run: [] };
  const testSet = new Set(tests);
  const changedSet = new Set(changed);
  const run = new Map();
  const add = (t, why, refresh) => { if (testSet.has(t) && !run.has(t)) run.set(t, { test: t, why, refresh: !!refresh }); };
  for (const f of changed) if (testSet.has(f)) add(f, 'the test itself changed', true);
  for (const [t, e] of Object.entries(map.entries)) {
    const hit = e.files.find((f) => changedSet.has(f));
    if (hit) add(t, `runs ${hit}`, false);
  }
  for (const [t, e] of Object.entries(map.entries)) {
    if (run.has(t)) continue;
    const since = new Set(changedSince(e.commit));
    const moved = e.files.find((f) => since.has(f));
    if (moved) add(t, `${moved} changed since this test was recorded`, true);
  }
  for (const t of tests) if (!map.entries[t]) add(t, 'no coverage record yet', true);
  for (const r of run.values()) if (r.why.startsWith('runs ')) r.refresh = true; // every run re-records
  const knownFailing = Object.entries(map.entries).filter(([, e]) => e.failed).map(([t]) => t);
  return { mode: 'selected', total: tests.length, run: [...run.values()], knownFailing };
}

function selectionFor(root, base) {
  const all = trackedFiles(root);
  const tests = all.filter((f) => TEST_FILE_RE.test(f));
  let changed = [];
  try { if (base) changed = git(root, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean); } catch { /* no base */ }
  changed = [...new Set([...changed, ...workingChanges(root)])].filter((f) => !f.startsWith('.framed/'));
  const cache = new Map();
  const working = workingChanges(root);
  const changedSince = (commit) => {
    if (!commit) return all; // unknown: treat everything as moved
    if (!cache.has(commit)) {
      let names = [];
      try { names = git(root, ['diff', '--name-only', `${commit}..HEAD`]).split('\n').filter(Boolean); } catch { names = all; } // commit gone (rebased away): re-record
      cache.set(commit, [...names, ...working]);
    }
    return cache.get(commit);
  };
  return { ...selectByCoverage({ map: readTestmap(root), tests, changed, changedSince }), changed };
}

// How to run one test file with coverage, from the config's suite that holds it. Runners framed
// knows how to ask for per-file coverage; anything else can't be selected and runs whole.
function coverageCommand(root, config, test) {
  const suite = (config.tests || []).filter((t) => isUnder(test, t.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!suite) return { error: `no test suite in .framed/config.json holds ${test}` };
  const rel = path.posix.relative(suite.path === '.' ? '' : suite.path, test);
  const out = toPosix(path.join(COVERAGE_TMP_REL, test.replace(/[^\w.-]+/g, '_')));
  let longRoot = root;
  try { longRoot = fs.realpathSync.native(root); } catch { /* keep */ }
  const absOut = toPosix(path.join(longRoot, out));
  const q = (s) => `"${s}"`;
  const c = suite.command;
  if (/\bvitest\b/.test(c) || (/\bnpm (run )?test\b/.test(c) && fs.existsSync(path.join(root, suite.path, 'node_modules', 'vitest')))) {
    return { cwd: suite.path, command: `npx vitest run ${q(rel)} --coverage.enabled --coverage.all=false --coverage.reporter=lcov --coverage.reportsDirectory=${q(absOut)}`, report: `${out}/lcov.info`, dir: out };
  }
  if (/\bjest\b/.test(c) || (/\bnpm (run )?test\b/.test(c) && fs.existsSync(path.join(root, suite.path, 'node_modules', 'jest')))) {
    return { cwd: suite.path, command: `npx jest ${q(rel)} --coverage --coverageReporters=lcov --coverageDirectory=${q(absOut)}`, report: `${out}/lcov.info`, dir: out };
  }
  if (/\bdotnet test\b/.test(c)) {
    const cls = path.basename(test).replace(/\.cs$/, '');
    return { cwd: suite.path, command: `${c} --filter "FullyQualifiedName~${cls}" --collect:"XPlat Code Coverage" --results-directory ${q(absOut)}`, report: `${out}/**/coverage.cobertura.xml`, dir: out };
  }
  if (/\bpytest\b/.test(c)) {
    return { cwd: suite.path, command: `${c} ${q(rel)} --cov --cov-report=lcov:${q(`${absOut}/lcov.info`)}`, report: `${out}/lcov.info`, dir: out };
  }
  return { error: `framed can't ask "${c}" for coverage per test file, so this suite runs whole` };
}

function findReport(root, pattern) {
  if (!pattern.includes('**')) { const p = path.join(root, pattern); return fs.existsSync(p) ? p : null; }
  const [dir, name] = pattern.split('/**/');
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory()) { const r = walk(p); if (r) return r; }
    }
    return null;
  };
  return walk(path.join(root, dir));
}

// Run one test file with coverage and record what it ran. -> { test, passed, files } or { test, error }
function runAndRecord(root, config, test) {
  const cmd = coverageCommand(root, config, test);
  if (cmd.error) return { test, error: cmd.error };
  try { fs.rmSync(path.join(root, cmd.dir), { recursive: true, force: true }); } catch { /* none */ } // no stale report from an earlier run
  // the real, long path: V8 coverage records files by it, and a Windows short name (ABCDEF~1) in the
  // working folder makes every file look unrun
  let cwd = path.join(root, cmd.cwd);
  try { cwd = fs.realpathSync.native(cwd); } catch { /* keep */ }
  const r = require('child_process').spawnSync(cmd.command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 15 * 60 * 1000 });
  const report = findReport(root, cmd.report);
  if (!report) return { test, passed: r.status === 0, error: `no coverage report at ${cmd.report}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}` };
  const entry = recordCoverage(root, test, fs.readFileSync(report, 'utf8'), r.status !== 0);
  return { test, passed: r.status === 0, files: entry.files.length };
}

function cmdTests(argv) {
  const [sub] = argv;
  const root = resolveRoot(argv);
  if (sub === 'select') {
    const base = argValue(argv, '--base', null);
    const given = argValue(argv, '--changed', null);
    if (given) {
      const all = trackedFiles(root);
      const map = readTestmap(root);
      const r = selectByCoverage({ map, tests: all.filter((f) => TEST_FILE_RE.test(f)), changed: given.split(',').filter(Boolean), changedSince: () => [] });
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    console.log(JSON.stringify(selectionFor(root, base), null, 2));
    return 0;
  }
  if (sub === 'record') {
    const test = argValue(argv, '--test', null), cov = argValue(argv, '--coverage', null);
    if (!test || !cov) { console.error('usage: framed tests record --test <file> --coverage <report> [--failed]'); return 2; }
    const e = recordCoverage(root, toPosix(test), fs.readFileSync(cov, 'utf8'), argv.includes('--failed'));
    console.log(JSON.stringify(e, null, 2));
    return 0;
  }
  let config;
  try { const r = loadConfig(root); if (r.errors.length) throw new Error(r.errors[0]); config = r.config; } catch (e) { console.error(`framed: ${e.message}`); return 1; }
  if (sub === 'command') {
    const test = argValue(argv, '--test', null);
    if (!test) { console.error('usage: framed tests command --test <file>'); return 2; }
    const c = coverageCommand(root, config, toPosix(test));
    console.log(JSON.stringify(c, null, 2));
    return c.error ? 1 : 0;
  }
  if (sub === 'baseline' || sub === 'run') {
    let list;
    if (sub === 'baseline') {
      // resumable: skip test files already recorded at this commit
      const head = headSha(root), map = readTestmap(root);
      list = trackedFiles(root).filter((f) => TEST_FILE_RE.test(f) && !(map.entries[f] && map.entries[f].commit === head));
      const limit = Number(argValue(argv, '--limit', 0));
      if (limit > 0) list = list.slice(0, limit);
    } else {
      const sel = selectionFor(root, argValue(argv, '--base', config.defaultBranch));
      if (sel.mode === 'full') { console.log(JSON.stringify(sel, null, 2)); return 3; } // the caller runs the whole suite
      list = sel.run.map((r) => r.test);
    }
    const results = [];
    for (const [i, t] of list.entries()) {
      const r = runAndRecord(root, config, t);
      results.push(r);
      console.error(`framed: ${i + 1}/${list.length} ${t}: ${r.error ? `error: ${r.error}` : r.passed ? `passed, runs ${r.files} files` : `FAILED, runs ${r.files} files`}`);
    }
    const out = { ran: results.length, passed: results.filter((r) => r.passed && !r.error).length, failed: results.filter((r) => r.passed === false).map((r) => r.test), errors: results.filter((r) => r.error).map((r) => ({ test: r.test, error: r.error })) };
    console.log(JSON.stringify(out, null, 2));
    return out.failed.length || out.errors.length ? 1 : 0;
  }
  console.error('usage: framed tests select|command|record|baseline|run  [--root <repo>]');
  return 2;
}

// ---- ui: the page (§19) ---------------------------------------------------------------------
// node framed.js ui [--root <repo>] [--port N]   serves ui/index.html and /state on localhost.
// Read-only: everything the page shows comes from .framed/, the step commits and the session
// transcripts. The skills never depend on it.

const UI_PORT = 4646;
const PAGE_IDLE_MS = 30 * 60 * 1000;
// The road, in order. "gate" has no step of its own: it is the blame row that waits for the
// person and the "[blame] gate: ..." commit that answers it (§9).
const STOPS = ['find', 'blame', 'gate', 'test', 'fix', 'suite', 'pr'];

// Working file body -> { sections: { heading: text }, steps: [{ step, status, commit, note }] }
function parseWorkingBody(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, '').replace(/<!--[\s\S]*?-->/g, '');
  const sections = {};
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1]; sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].join('\n').trim();
  const steps = [];
  for (const line of (sections.Steps || '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || cells[0] === 'step' || /^-+$/.test(cells[0])) continue;
    steps.push({ step: cells[0], status: cells[1], commit: cells[2], note: cells.slice(3).join('|').trim() });
  }
  return { sections, steps };
}

// Steps rows -> one entry per stop on the road, in STOPS order.
// status: todo | running | done | failed | waiting (gate) | stopped (hard stop) | skipped
function buildRoad(rows, taskStatus) {
  const stops = STOPS.map((key) => ({ key, status: 'todo', note: '', runs: 0 }));
  const at = (key) => stops[STOPS.indexOf(key)];
  for (const r of rows) {
    if (r.status === 'todo') continue;
    let key = r.step;
    if (key === 'blame' && /^gate\b/i.test(r.note)) key = 'gate';
    const stop = at(key);
    if (!stop) continue;
    if (key === 'blame' && r.status === 'blocked' && /gate/i.test(r.note)) {
      // blame finished its work and the task now waits at the gate
      stop.status = 'done';
      stop.note = r.note.replace(/^waiting at the gate\.?\s*/i, '');
      stop.runs += 1;
      at('gate').status = 'waiting';
      at('gate').note = 'waiting for your yes';
      continue;
    }
    stop.status = r.status === 'blocked' ? 'stopped' : r.status;
    stop.note = r.note;
    stop.runs += 1;
  }
  // A closed task (deliberate code, no change) ends where it stopped.
  if (taskStatus === 'closed') for (const s of stops) if (s.status === 'todo') s.status = 'skipped';
  return stops;
}

// Commits on the task branch tagged "<ticket> [step] ..." -> [{ stop, time, subject }], oldest first.
function parseStepCommits(log, ticket) {
  const t = String(ticket).replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#?${t} \\[(\\w+)\\]\\s*(.*)$`);
  const out = [];
  for (const line of log.split('\n')) {
    const [time, subject] = line.split('\t');
    const m = subject && subject.match(re);
    if (!m) continue;
    out.push({ stop: m[1] === 'blame' && /^gate\b/i.test(m[2]) ? 'gate' : m[1], time: Date.parse(time), subject });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Usage records -> tokens per stop. A reply belongs to the step whose commit comes next after it;
// replies after the last step commit belong to the step still running.
function tokensByStop(records, branch, commits, runningStop) {
  const empty = () => ({ fresh: 0, cached: 0, replies: 0 });
  const byStop = {};
  const total = empty();
  const seen = new Set();
  for (const r of records) {
    if (r.branch !== branch || seen.has(r.key)) continue;
    seen.add(r.key);
    const next = commits.find((c) => c.time + 1000 >= r.time);
    const stop = next ? next.stop : runningStop;
    if (!stop) continue;
    byStop[stop] = byStop[stop] || empty();
    for (const t of [byStop[stop], total]) { t.fresh += r.fresh; t.cached += r.cached; t.replies += 1; }
  }
  return { total, byStop };
}

// Session transcripts for a repo: ~/.claude/projects/<root with non-alphanumerics as "-">.
// Undocumented format (§17): any surprise means "not available", never an error.
function transcriptFiles(root) {
  const base = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(require('os').homedir(), '.claude', 'projects');
  let long = root;
  try { long = fs.realpathSync.native(root); } catch { /* keep as given */ }
  const want = long.replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
  let dir;
  try { dir = fs.readdirSync(base).find((d) => d.toLowerCase() === want); } catch { return null; }
  if (!dir) return null;
  const files = [];
  for (const e of fs.readdirSync(path.join(base, dir), { withFileTypes: true })) {
    const p = path.join(base, dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    if (e.isDirectory()) {
      const sub = path.join(p, 'subagents');
      try { for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f)); } catch { /* none */ }
    }
  }
  return files;
}

// Reads each transcript once, then only what was appended since (the page polls).
const usageCache = new Map(); // file -> { offset, rest, records }
function usageRecords(file) {
  let c = usageCache.get(file);
  const size = fs.statSync(file).size;
  if (!c || size < c.offset) { c = { offset: 0, rest: '', records: [] }; usageCache.set(file, c); }
  if (size > c.offset) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - c.offset);
    fs.readSync(fd, buf, 0, buf.length, c.offset);
    fs.closeSync(fd);
    c.offset = size;
    const lines = (c.rest + buf.toString('utf8')).split('\n');
    c.rest = lines.pop();
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const u = o.message && o.message.usage;
      if (!u || !o.timestamp || !o.gitBranch) continue;
      c.records.push({
        key: `${o.message.id || o.uuid}:${o.requestId || ''}`,
        time: Date.parse(o.timestamp),
        branch: o.gitBranch,
        fresh: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0),
        cached: u.cache_read_input_tokens || 0,
      });
    }
  }
  return c.records;
}

function readHead(gitDir) {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head;
    try { return fs.readFileSync(path.join(gitDir, m[1]), 'utf8').trim(); } catch { /* packed */ }
    const line = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${m[1]}`));
    return line ? line.split(' ')[0] : null;
  } catch { return null; }
}

// What git says about the task branch, cached per branch and HEAD so polling spawns no git
// between commits. Branch too: a new task branch starts on the same commit as the default branch.
const gitCache = new Map(); // root -> { head, log, collapsed, changed }
function branchHistory(root, defaultBranch, branch) {
  const head = `${branch}@${readHead(gitDirOf(root))}`;
  const hit = gitCache.get(root);
  if (hit && hit.head === head) return hit;
  let range = [`${defaultBranch}..HEAD`];
  try { git(root, ['rev-parse', '--verify', '--quiet', defaultBranch]); } catch { range = ['-200', 'HEAD']; }
  let log = '';
  try { log = git(root, ['log', '--format=%cI%x09%s', ...range]); } catch { /* no commits */ }
  // After the PR step the working file is collapsed and deleted; read it from just before.
  let collapsed = null;
  try {
    const h = git(root, ['log', '--diff-filter=D', '--format=%H', '-1', ...range, '--', TASKS_REL_DIR.split(path.sep).join('/')]).trim();
    if (h) {
      const file = git(root, ['show', '--diff-filter=D', '--name-only', '--format=', h, '--', '.framed/tasks']).trim().split('\n')[0];
      collapsed = { file, text: git(root, ['show', `${h}^:${file}`]) };
    }
  } catch { /* none */ }
  // files the branch has changed so far, for the map's glow
  let changed = [];
  if (range[0].includes('..')) {
    try { changed = git(root, ['diff', '--name-only', `${defaultBranch}...HEAD`]).split('\n').filter((f) => f && !f.startsWith('.framed/')); } catch { /* none */ }
  }
  const out = { head, log, collapsed, changed };
  gitCache.set(root, out);
  return out;
}

// The map for the page: modules and links from map.md (committed, so every clone has it), and
// file -> module from scan.json when this machine has one (it is a local cache, §13).
function parseMdTable(text) {
  const rows = text.split('\n').filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.toLowerCase());
  return rows.slice(2).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
}

function parseMapMd(text) {
  const sections = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = h[1]; sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  const sec = (k) => (sections[k] || []).join('\n');
  const modules = parseMdTable(sec('Modules')).filter((r) => r.module).map((r) => ({
    name: r.module, what: r['what it does'] || '', langs: r.languages || '', files: Number(r['source files']) || 0,
  }));
  const links = parseMdTable(sec('How they connect')).filter((r) => r.from && r.to).map((r) => ({
    from: r.from, to: r.to,
    sources: (r.source || '').split(',').map((s) => s.trim()).filter(Boolean),
    strength: (r.strength || '').split('+').reduce((n, s) => n + (Number(s.trim()) || 0), 0),
  }));
  const known = new Set(modules.map((m) => m.name));
  for (const l of links) for (const n of [l.from, l.to]) if (!known.has(n)) { known.add(n); modules.push({ name: n, what: '', langs: '', files: 0, other: true }); }
  const para = (k, re) => { const m = sec(k).match(re); return m ? m[0].trim() : ''; };
  return { modules, links, what: sec('What this is').trim(), surprising: para('How they connect', /Surprising:[^\n]*/) };
}

const mapCache = new Map(); // root -> { key, map, moduleOf }
function readMapView(root) {
  const mdFile = path.join(root, MAP_REL_PATH);
  const scanFile = path.join(root, '.framed', 'scan.json');
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = `${mtime(mdFile)}:${mtime(scanFile)}`;
  const hit = mapCache.get(root);
  if (hit && hit.key === key) return hit;
  const out = { key, map: null, moduleOf: null, scan: null };
  try { out.map = parseMapMd(fs.readFileSync(mdFile, 'utf8')); } catch { /* no map */ }
  try {
    out.scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
    out.moduleOf = new Map(out.scan.files.map((f) => [f.path, f.module]));
  } catch { /* no scan on this machine: the map shows, without the glow */ }
  mapCache.set(root, out);
  return out;
}

// The working file's Blast radius section: "- touches: a, b" and the dependents, one per line
// as "  - path (source): verdict. Why." (§8, templates/working-file.md).
const PATH_RE = /[\w.@-]+(?:\/[\w.@-]+)+\.\w+/g;
function parseBlastRadius(sections) {
  const text = sections['Blast radius'] || '';
  const touchesLine = (text.match(/^- touches:(.*)$/m) || [])[1] || '';
  const touches = [...touchesLine.matchAll(PATH_RE)].map((m) => m[0]);
  const dependents = [];
  for (const line of text.split('\n')) {
    if (line === `- touches:${touchesLine}`) continue;
    const p = line.match(PATH_RE);
    if (!p) continue;
    const m = line.match(/\(([^)]+)\):?\s*(.*)$/);
    dependents.push({ path: p[0], source: m ? m[1] : '', note: m ? m[2] : line.replace(/^\s*-\s*/, '') });
  }
  return { touches, dependents };
}

// Which modules the task touches (its touches plus what the branch changed), and which its
// blast radius reaches (the dependents the working file lists).
function blastModules(sections, changed, moduleOf) {
  if (!moduleOf) return { touched: [], reached: [] };
  const { touches, dependents } = parseBlastRadius(sections);
  const touched = new Set([...touches, ...changed].map((p) => moduleOf.get(p)).filter(Boolean));
  const reached = new Set(dependents.map((d) => moduleOf.get(d.path)).filter((m) => m && !touched.has(m)));
  return { touched: [...touched], reached: [...reached] };
}

// Per root: the task's files as the last /state saw them, for the module and file views.
const taskFiles = new Map(); // root -> { changed: Set, affected: Map(path -> { source, note }) }
function setTaskFiles(root, sections, changed) {
  const { touches, dependents } = parseBlastRadius(sections || {});
  const changedSet = new Set([...touches, ...changed]);
  const affected = new Map(dependents.filter((d) => !changedSet.has(d.path)).map((d) => [d.path, { source: d.source, note: d.note }]));
  taskFiles.set(root, { changed: changedSet, affected });
}
function fileMark(root, p) {
  const t = taskFiles.get(root);
  if (!t) return null;
  if (t.changed.has(p)) return { mark: 'changed' };
  const a = t.affected.get(p);
  return a ? { mark: 'affected', ...a } : null;
}

// One module's files for the side panel: the task's files first, then everything for the tree.
function moduleView(root, name) {
  const { scan } = readMapView(root);
  if (!scan) return { error: 'no scan on this machine: run framed map scan' };
  const mod = scan.modules.find((m) => m.name === name);
  const files = scan.files.filter((f) => f.module === name).map((f) => ({
    path: f.path, rel: mod && mod.path && f.path.startsWith(`${mod.path}/`) ? f.path.slice(mod.path.length + 1) : f.path,
    test: f.isTest, tested: f.hasTests, ...fileMark(root, f.path),
  }));
  // files the task created are not in the scan yet
  const known = new Set(files.map((f) => f.path));
  const t = taskFiles.get(root);
  if (mod && mod.path && t) {
    for (const p of t.changed) {
      if (!known.has(p) && p.startsWith(`${mod.path}/`)) files.push({ path: p, rel: p.slice(mod.path.length + 1), mark: 'changed', isNew: true });
    }
  }
  return { name, path: mod ? mod.path : '', files };
}

// One file's direct neighbours, the same sources `framed deps` reads (§6).
const NEIGHBOUR_CAP = 12;
function fileView(root, p) {
  const { scan, moduleOf } = readMapView(root);
  if (!scan) return { error: 'no scan on this machine: run framed map scan' };
  const groups = { uses: [], usedBy: [], changedWith: [], tests: [] };
  for (const e of scan.edges) {
    if (e.source === 'static') {
      if (e.from === p) groups.uses.push({ path: e.to });
      else if (e.to === p) groups.usedBy.push({ path: e.from });
    } else if (e.from === p || e.to === p) {
      groups[e.source === 'test' ? 'tests' : 'changedWith'].push({ path: e.from === p ? e.to : e.from, weight: e.weight || 1 });
    }
  }
  const out = { path: p, module: moduleOf.get(p) || null, ...fileMark(root, p), total: {} };
  for (const [k, list] of Object.entries(groups)) {
    out.total[k] = list.length;
    // what the task touches first, then the strongest links
    const rank = (x) => (fileMark(root, x.path) ? 1e6 : 0) + (x.weight || 0);
    out[k] = list.sort((a, b) => rank(b) - rank(a)).slice(0, NEIGHBOUR_CAP)
      .map((x) => ({ ...x, module: moduleOf.get(x.path) || null, ...fileMark(root, x.path) }));
  }
  return out;
}

function uiState(root) {
  const s = repoStatus(root);
  const m = statusMessages(s);
  const state = { state: s.state, line: m ? m.user.replace(/^framed: /, '') : null, root: s.root, branch: s.branch || null, task: null, generatedAt: new Date().toISOString() };
  state.repo = { name: s.root ? path.basename(s.root) : null, mapDate: s.mapDate || null, ticketPrefixes: s.ticketPrefixes, unitTests: s.unitTests };
  // context left and plan usage, from framed's status line when the person turned it on
  state.usage = s.root ? usageFor(s.root) : null;
  state.statusLine = statusLineInstalled();
  if (!['task', 'ready'].includes(s.state)) return state;
  root = s.root;
  const { config } = loadConfig(root);
  const hist = branchHistory(root, config.defaultBranch, s.branch);
  const mv = readMapView(root);
  state.map = mv.map ? { ...mv.map, touched: [], reached: [], scan: !!mv.moduleOf } : null;
  let text = null;
  let collapsed = false;
  try { text = fs.readFileSync(findActiveTask(root, s.branch).task.file, 'utf8'); } catch { /* none in the tree */ }
  if (!text && hist.collapsed && (parseFrontmatter(hist.collapsed.text) || {}).branch === s.branch) { text = hist.collapsed.text; collapsed = true; }
  if (!text) { taskFiles.delete(root); return state; }
  const fm = parseFrontmatter(text) || {};
  const { sections, steps } = parseWorkingBody(text);
  const road = buildRoad(steps, fm.status);
  const commits = parseStepCommits(hist.log, fm.ticket);
  const running = (road.find((x) => !['done', 'skipped'].includes(x.status)) || {}).key || null;
  let tokens = { available: false };
  try {
    const files = transcriptFiles(root);
    if (files) {
      const records = files.flatMap((f) => usageRecords(f));
      const after = running || (commits.length ? commits[commits.length - 1].stop : null); // the wrap-up reply
      tokens = { available: true, ...tokensByStop(records, s.branch, commits, after) };
    }
  } catch { tokens = { available: false }; }
  state.task = { ...fm, collapsed, road, current: running, sections, tokens };
  if (state.map) Object.assign(state.map, blastModules(sections, hist.changed, mv.moduleOf));
  setTaskFiles(root, sections, hist.changed);
  return state;
}

// ---- Studio (§19): pick a design; the CLI builds it ----------------------------------------
// The page's one write is the chosen design, to .framed/design/choice.json. Building starts in the
// chat. Every style the page shows or saves is checked against the token shape first.

const DESIGN_REL_DIR = path.join('.framed', 'design');

// The folder ignores itself: the options and the saved choice are this person's picking, not the
// repo's, and an untracked folder would stop a restyle at its clean-tree check. What the build
// keeps goes in the PR, or in .framed/design.md for a new app.
function designDir(top) {
  const dir = path.join(top, DESIGN_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return dir;
}
const STYLE_COLORS = ['bg', 'surface', 'ink', 'muted', 'line', 'accent', 'accentInk', 'success', 'warning', 'danger'];
const OPTIONAL_COLORS = ['heading']; // headings default to the text colour
// spacing: a named stop or any scale in between (1 = comfortable); every padding and gap follows it
const DENSITIES = { compact: 0.7, comfortable: 1, roomy: 1.3 };
const densityScale = (s) => (typeof s.density === 'number' ? s.density : DENSITIES[s.density]);
// motion: how long a transition takes, in ms (0 = none); from LIVELY_MS up it springs a little
const MOTION_DEFAULT = 150;
const LIVELY_MS = 250;
const motionMs = (s) => (s.motion === undefined ? MOTION_DEFAULT : s.motion);
const motionEase = (ms) => (ms >= LIVELY_MS ? 'cubic-bezier(0.34, 1.4, 0.64, 1)' : 'cubic-bezier(0.2, 0, 0, 1)');
const SHADOWS = ['none', 'soft', 'hard'];

function validateStyle(s) {
  const errors = [];
  const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  const font = (v) => typeof v === 'string' && /^[A-Za-z0-9 ]{1,60}$/.test(v);
  if (!s || typeof s !== 'object') return ['not an object'];
  if (!str(s.id, 60) || !/^[a-z0-9-]+$/.test(s.id)) errors.push('id: lower-case letters, digits and dashes');
  if (!str(s.name, 80)) errors.push('name: up to 80 characters');
  if (s.vibe !== undefined && !(typeof s.vibe === 'string' && s.vibe.length <= 240)) errors.push('vibe: up to 240 characters');
  if (!s.fonts || !font(s.fonts.heading) || !font(s.fonts.body) || (s.fonts.mono !== undefined && !font(s.fonts.mono))) errors.push('fonts: heading and body (and optional mono), font names only');
  if (!Number.isInteger(s.radius) || s.radius < 0 || s.radius > 32) errors.push('radius: whole pixels, 0 to 32');
  const d = s.density;
  if (!(typeof d === 'string' && Object.hasOwn(DENSITIES, d)) && !(typeof d === 'number' && d >= 0.6 && d <= 1.4)) errors.push(`density: one of ${Object.keys(DENSITIES).join(', ')}, or a scale from 0.6 to 1.4`);
  if (s.motion !== undefined && !(Number.isInteger(s.motion) && s.motion >= 0 && s.motion <= 400)) errors.push('motion: whole milliseconds, 0 to 400');
  if (!SHADOWS.includes(s.shadow)) errors.push(`shadow: one of ${SHADOWS.join(', ')}`);
  // optional: type size (base px, and how much bigger each heading step is)
  if (s.type !== undefined) {
    const t = s.type;
    if (!t || !Number.isInteger(t.base) || t.base < 12 || t.base > 20 || typeof t.scale !== 'number' || t.scale < 1.05 || t.scale > 1.6) errors.push('type: base 12 to 20 px, scale 1.05 to 1.6');
  }
  for (const mode of ['light', 'dark']) {
    const p = s[mode];
    if (!p || typeof p !== 'object') { errors.push(`${mode}: the colour set is missing`); continue; }
    for (const k of STYLE_COLORS) if (!/^#[0-9a-fA-F]{6}$/.test(p[k] || '')) errors.push(`${mode}.${k}: a #rrggbb colour`);
    for (const k of OPTIONAL_COLORS) if (p[k] !== undefined && !/^#[0-9a-fA-F]{6}$/.test(p[k])) errors.push(`${mode}.${k}: a #rrggbb colour`);
  }
  return errors;
}
const TYPE_DEFAULT = { base: 16, scale: 1.25 };
// text sizes from the type tokens, smallest to largest, in px
function typeSizes(style) {
  const { base, scale } = style.type || TYPE_DEFAULT;
  const r = (n) => Math.round(n * 10) / 10;
  return { sm: r(base / scale), base, lg: r(base * scale), xl: r(base * scale ** 2), '2xl': r(base * scale ** 3) };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ---- the repo's current look (brownfield): read from its own theme files ---------------------
// Per app (a folder with package.json): the UI libraries it depends on, and the colours, fonts
// and corner radius its CSS, Tailwind config or SCSS declare. Plain parsing, no dependencies.

const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function oklchToHex(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gam = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
  return toHex(gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}
// "#abc", "#aabbcc", "rgb(…)", "hsl(…)", shadcn's bare "222 47% 11%", "oklch(…)" -> "#rrggbb", else null.
// Alpha is dropped here; colourAlpha reads it, so a see-through border can be blended (slotsFrom).
function colourAlpha(v) {
  const m = typeof v === 'string' && v.match(/\/\s*([\d.]+)(%?)\s*\)\s*$/);
  if (!m) return 1;
  const a = parseFloat(m[1]) / (m[2] ? 100 : 1);
  return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
}
function parseColor(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase().replace(/\s*\/\s*[\d.]+%?\s*\)$/, ')');
  let m = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/);
  if (m) return m[1].length === 3 ? `#${[...m[1]].map((c) => c + c).join('')}` : `#${m[1]}`;
  const nums = (s) => s.split(/[\s,/]+/).filter(Boolean);
  m = t.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const [r, g, b] = nums(m[1]).map((x) => (x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x))); return [r, g, b].every(Number.isFinite) ? toHex(r, g, b) : null; }
  m = t.match(/^hsla?\(([^)]+)\)$/) || t.match(/^(-?[\d.]+(?:deg)?\s*,?\s+[\d.]+%\s*,?\s+[\d.]+%)$/);
  if (m) { const [h, s, l] = nums(m[1]).map((x) => parseFloat(x)); return [h, s, l].every(Number.isFinite) ? hslToHex(h, s, l) : null; }
  m = t.match(/^oklch\(([^)]+)\)$/);
  if (m) {
    const [Ls, Cs, Hs] = nums(m[1]);
    const L = Ls && Ls.endsWith('%') ? parseFloat(Ls) / 100 : parseFloat(Ls);
    const C = parseFloat(Cs), H = Hs === 'none' ? 0 : parseFloat(Hs);
    return [L, C, H].every(Number.isFinite) ? oklchToHex(L, C, H) : null;
  }
  return null;
}

// CSS -> { light: {var: value}, dark: {...}, fonts: [..] }. Walks braces so @media and nested
// blocks keep their context: a block counts as dark if any enclosing selector says so.
function parseCssVars(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = { light: {}, dark: {}, fonts: [] };
  const stack = [];
  let buf = '';
  for (const ch of src) {
    if (ch === '{') { stack.push(buf.trim()); buf = ''; continue; }
    if (ch === '}') {
      const sel = stack.join(' ');
      const dark = /\.dark\b|\[data-theme=["']?dark|prefers-color-scheme:\s*dark|\[data-mode=["']?dark/i.test(sel);
      const rootish = /:root|html|@theme|\.light\b|\.dark\b|\[data-theme|body/i.test(sel);
      for (const decl of buf.split(';')) {
        const d = decl.match(/^\s*(--[\w-]+|font-family)\s*:\s*([^;]+?)\s*$/);
        if (!d) continue;
        if (d[1] === 'font-family' || /^--font-(sans|body|heading|display|serif)$/.test(d[1])) { if (/body|html|:root|@theme/i.test(sel)) out.fonts.push(d[2]); continue; }
        if (rootish) (dark ? out.dark : out.light)[d[1].slice(2)] = d[2];
      }
      stack.pop(); buf = ''; continue;
    }
    buf += ch;
  }
  return out;
}

const SLOT_NAMES = {
  bg: ['background', 'bg', 'color-background', 'body-bg', 'bs-body-bg'],
  surface: ['card', 'surface', 'color-card', 'panel', 'popover'],
  ink: ['foreground', 'text', 'color-foreground', 'body-color', 'bs-body-color', 'card-foreground'],
  muted: ['muted-foreground', 'text-muted', 'color-muted-foreground', 'secondary-foreground'],
  line: ['border', 'color-border', 'input', 'divider'],
  accent: ['primary', 'brand', 'color-primary', 'bs-primary', 'accent-color', 'mui-palette-primary-main'],
  accentInk: ['primary-foreground', 'color-primary-foreground', 'on-primary'],
  success: ['success', 'color-success', 'bs-success', 'green'],
  warning: ['warning', 'color-warning', 'bs-warning', 'amber'],
  danger: ['destructive', 'danger', 'error', 'color-destructive', 'bs-danger', 'red'],
};
// var name -> value map -> our slots, following var(--x) one step at a time
function slotsFrom(vars) {
  const resolve = (v, depth = 0) => { const m = typeof v === 'string' && v.match(/^var\(--([\w-]+)\)$/); return m && depth < 4 ? resolve(vars[m[1]], depth + 1) : v; };
  const raw = {};
  for (const [slot, names] of Object.entries(SLOT_NAMES)) {
    for (const n of names) { const v = resolve(vars[n]); const hex = parseColor(v); if (hex) { raw[slot] = { hex, a: colourAlpha(v) }; break; } }
  }
  // see-through colours (shadcn's dark border is white at 10%) are blended onto the background
  const bg = raw.bg ? raw.bg.hex : '#ffffff';
  const mix = (a, b, t) => toHex(...[1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)));
  return Object.fromEntries(Object.entries(raw).map(([k, { hex, a }]) => [k, a < 1 ? mix(hex, bg, a) : hex]));
}
const GENERIC_FONTS = /^(system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace|-apple-system|blinkmacsystemfont|inherit|initial|var\(.*)$/i;
function firstFont(decls) {
  for (const d of decls) {
    for (const f of d.split(',')) { const name = f.trim().replace(/^["']|["']$/g, ''); if (name && !GENERIC_FONTS.test(name) && /^[A-Za-z0-9 ]{1,60}$/.test(name)) return name; }
  }
  return null;
}

const UI_LIBRARIES = [
  [/^tailwindcss$|^@tailwindcss\//, 'Tailwind'], [/^@radix-ui\/|^radix-ui$/, 'Radix'], [/^class-variance-authority$/, 'shadcn/ui-style components'],
  [/^@mui\/material$|^@material-ui\/core$/, 'MUI'], [/^@chakra-ui\/react$/, 'Chakra UI'], [/^antd$/, 'Ant Design'], [/^bootstrap$|^react-bootstrap$/, 'Bootstrap'],
  [/^@mantine\/core$/, 'Mantine'], [/^styled-components$/, 'styled-components'], [/^@emotion\/react$/, 'Emotion'], [/^vuetify$/, 'Vuetify'],
  [/^@angular\/material$/, 'Angular Material'], [/^primereact$|^primevue$/, 'PrimeReact/PrimeVue'], [/^element-plus$/, 'Element Plus'],
];
const THEME_NAME = /(^|\/)(index|globals?|app|main|styles?|theme|tailwind|variables|_variables|tokens)\.(css|scss|less)$/i;

function detectDesign(root) {
  let files = [];
  try { files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean); } catch { return { apps: [] }; }
  files = files.filter((f) => !/(^|\/)(node_modules|dist|build|vendor|\.next|coverage)\//.test(f));
  const dirs = files.filter((f) => /(^|\/)package\.json$/.test(f)).map((f) => dirOf(f));
  // workspace packages by name, so `@import "@acme/shared-ui/styles.css"` is read from the repo
  const pkgDir = new Map(dirs.map((d) => [(readJson(path.join(root, d, 'package.json')) || {}).name, d]).filter(([n]) => n));
  const importedCss = (text, depth = 0) => {
    const out = [];
    for (const m of text.matchAll(/@import\s+(?:url\()?["']([^"']+\.css)["']/g)) {
      const spec = m[1];
      const name = [...pkgDir.keys()].find((n) => spec === n || spec.startsWith(`${n}/`));
      if (!name) continue;
      const rel = `${pkgDir.get(name)}/${spec.slice(name.length + 1) || 'index.css'}`;
      const alt = files.find((f) => f === rel) || files.find((f) => f.startsWith(`${pkgDir.get(name)}/`) && f.endsWith(`/${spec.split('/').pop()}`));
      if (!alt) continue;
      try { const t = fs.readFileSync(path.join(root, alt), 'utf8'); if (depth < 2) out.push(...importedCss(t, depth + 1)); out.push({ file: alt, text: t }); } catch { /* unreadable */ }
    }
    return out;
  };
  const apps = [];
  for (const dir of dirs) {
    const inDir = (f) => (dir ? f.startsWith(`${dir}/`) : true) && !dirs.some((d) => d !== dir && d.startsWith(dir ? `${dir}/` : '') && d.length > dir.length && f.startsWith(`${d}/`));
    const pkg = readJson(path.join(root, dir, 'package.json')) || {};
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const libraries = [...new Set(UI_LIBRARIES.filter(([re]) => deps.some((d) => re.test(d))).map(([, n]) => n))];
    const cand = files.filter((f) => inDir(f) && (THEME_NAME.test(f) || /tailwind\.config\.(js|cjs|mjs|ts)$/.test(f))).slice(0, 12);
    const vars = { light: {}, dark: {} }, fonts = [], used = [];
    let radius = null;
    for (const f of cand) {
      let text;
      try { const p = path.join(root, f); if (fs.statSync(p).size > 200000) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const before = Object.keys(vars.light).length + Object.keys(vars.dark).length + fonts.length;
      if (/\.(css|less)$/.test(f)) {
        // shared styles it imports first, so its own values win
        for (const imp of importedCss(text)) {
          const r = parseCssVars(imp.text);
          Object.assign(vars.light, r.light); Object.assign(vars.dark, r.dark); fonts.push(...r.fonts);
          if (!used.includes(imp.file)) used.push(imp.file);
        }
        const r = parseCssVars(text);
        Object.assign(vars.light, r.light); Object.assign(vars.dark, r.dark); fonts.push(...r.fonts);
      } else if (/\.scss$/.test(f)) {
        const r = parseCssVars(text);
        Object.assign(vars.light, r.light); Object.assign(vars.dark, r.dark); fonts.push(...r.fonts);
        for (const m of text.matchAll(/\$([\w-]+)\s*:\s*([^;!]+)/g)) vars.light[m[1]] = m[2].trim();
      } else {
        for (const m of text.matchAll(/([\w-]+)\s*:\s*["'](#[0-9a-fA-F]{3,8})["']/g)) if (!(m[1] in vars.light)) vars.light[m[1]] = m[2];
        const ff = text.match(/fontFamily\s*:\s*\{[^}]*?sans\s*:\s*\[\s*["']([^"']+)/);
        if (ff) fonts.push(ff[1]);
      }
      if (Object.keys(vars.light).length + Object.keys(vars.dark).length + fonts.length > before) used.push(f);
    }
    const rv = vars.light.radius && vars.light.radius.match(/^([\d.]+)(rem|px)$/);
    if (rv) radius = Math.round(parseFloat(rv[1]) * (rv[2] === 'rem' ? 16 : 1));
    const light = slotsFrom(vars.light), dark = slotsFrom({ ...vars.light, ...vars.dark });
    if (!libraries.length && !Object.keys(light).length) continue;
    apps.push({ dir: dir || '.', name: pkg.name || (dir ? dir.split('/').pop() : path.basename(root)), libraries, files: used, light, dark: Object.keys(vars.dark).length ? dark : null, font: firstFont(fonts), radius });
  }
  return { apps };
}

// A detected app as a Studio card: what was found, the rest filled from the Calm style and said so.
function currentStyle(app, base) {
  const found = Object.keys(app.light);
  if (!found.includes('accent') || found.length < 3) return null; // not enough of a look to show as one
  const fill = (got, from) => Object.fromEntries(STYLE_COLORS.map((k) => [k, got[k] || from[k]]));
  const slug = String(app.dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
  const guessed = [...STYLE_COLORS.filter((k) => !app.light[k]), ...(app.font ? [] : ['font'])];
  return {
    id: `current-${slug}`.slice(0, 60),
    name: `Current: ${app.name}`.slice(0, 80),
    vibe: `Read from ${app.files.map((f) => f.split('/').pop()).join(', ') || 'its theme'}${app.libraries.length ? ` (${app.libraries.join(', ')})` : ''}.${guessed.length ? ` Not found, filled in: ${guessed.join(', ')}.` : ''}`.slice(0, 240),
    fonts: { heading: app.font || base.fonts.heading, body: app.font || base.fonts.body, mono: base.fonts.mono },
    radius: Number.isInteger(app.radius) && app.radius <= 32 ? app.radius : base.radius,
    density: 'comfortable', shadow: 'soft',
    light: fill(app.light, base.light),
    dark: fill(app.dark || {}, base.dark),
    app: app.dir,
  };
}

// The chosen tokens as CSS variables. "shadcn" uses the names shadcn/ui themes read (background,
// primary, muted-foreground, …, plus --radius); "generic" uses framed's own slot names.
const mixHex = (a, b, t) => toHex(...[1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16) * t + parseInt(b.slice(i, i + 2), 16) * (1 - t)));
function designCss(style, names) {
  const block = (p) => {
    if (names === 'shadcn') {
      return {
        background: p.bg, foreground: p.ink, card: p.surface, 'card-foreground': p.ink, popover: p.surface, 'popover-foreground': p.ink,
        primary: p.accent, 'primary-foreground': p.accentInk, secondary: mixHex(p.line, p.surface, 0.5), 'secondary-foreground': p.ink,
        muted: mixHex(p.line, p.bg, 0.4), 'muted-foreground': p.muted, accent: mixHex(p.accent, p.surface, 0.12), 'accent-foreground': p.ink,
        destructive: p.danger, border: p.line, input: p.line, ring: p.accent,
      };
    }
    return Object.fromEntries([...STYLE_COLORS, 'heading'].map((k) => [k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), p[k] || (k === 'heading' ? p.ink : undefined)]));
  };
  const decl = (o) => Object.entries(o).map(([k, v]) => `  --${k}: ${v};`).join('\n');
  const fonts = `  --font-sans: "${style.fonts.body}", system-ui, sans-serif;\n  --font-heading: "${style.fonts.heading}", system-ui, sans-serif;${style.fonts.mono ? `\n  --font-mono: "${style.fonts.mono}", ui-monospace, monospace;` : ''}`;
  const sizes = Object.entries(typeSizes(style)).map(([k, px]) => `  --text-${k}: ${Math.round((px / 16) * 1000) / 1000}rem;`).join('\n');
  // shadcn has no heading variable: a heading colour that differs from the text goes in as its own
  const headingExtra = (p) => (names === 'shadcn' && p.heading && p.heading !== p.ink ? `\n  --heading: ${p.heading};` : '');
  // --spacing is Tailwind's base step (0.25rem at comfortable); motion stops when the system asks
  const ms = motionMs(style);
  const space = `  --spacing: ${Math.round(densityScale(style) * 2500) / 10000}rem;\n  --duration: ${ms}ms;\n  --ease: ${motionEase(ms)};`;
  const reduced = '\n@media (prefers-reduced-motion: reduce) {\n  :root {\n    --duration: 0ms;\n  }\n}\n';
  return `:root {\n  --radius: ${style.radius / 16}rem;\n${space}\n${fonts}\n${sizes}\n${decl(block(style.light))}${headingExtra(style.light)}\n}\n\n.dark {\n${decl(block(style.dark))}${headingExtra(style.dark)}\n}\n${reduced}`;
}

// Fixed colours in an app's components: a theme change can't reach them, so a restyle reports
// them as left as is instead of rewriting every screen.
const TW_PALETTE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
function hardcodedColours(root, dir, themeFiles) {
  let files = [];
  try { files = git(root, ['ls-files', '-z', '--', dir === '.' ? '.' : dir]).split('\0').filter(Boolean); } catch { return { files: 0, uses: 0, top: [] }; }
  const skip = new Set(themeFiles || []);
  const hits = [];
  for (const f of files) {
    if (skip.has(f) || !/\.(tsx|jsx|ts|js|vue|svelte|html|css|scss)$/.test(f) || /(^|\/)(node_modules|dist|build)\//.test(f) || /\.(test|spec)\./.test(f)) continue;
    let text;
    try { const p = path.join(root, f); if (fs.statSync(p).size > 300000) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const n = (text.match(TW_PALETTE) || []).length + (text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/g) || []).length;
    if (n) hits.push({ file: f, uses: n });
  }
  hits.sort((a, b) => b.uses - a.uses);
  return { files: hits.length, uses: hits.reduce((s, h) => s + h.uses, 0), top: hits.slice(0, 10) };
}

function cmdDesign(argv) {
  const [sub] = argv;
  const root = resolveRoot(argv);
  const top = repoStatus(root).root || toPosix(root);
  if (sub === 'detect') { console.log(JSON.stringify(detectDesign(top), null, 2)); return 0; }
  if (fs.existsSync(path.join(top, DESIGN_REL_DIR))) designDir(top); // a folder the scout agent made
  if (sub === 'options') {
    // the scout's file: every style checked, so the agent can fix what fails
    const o = readJson(path.join(top, DESIGN_REL_DIR, 'options.json'));
    if (!o || !Array.isArray(o.styles)) { console.error('framed: .framed/design/options.json is missing or has no "styles" list'); return 1; }
    const bad = o.styles.map((s, i) => { const e = validateStyle(s); return { i, id: s && s.id, errors: e.length ? e : contrastIssues(s).map((c) => `hard to read: ${c}`) }; }).filter((x) => x.errors.length);
    const ids = o.styles.map((s) => s && s.id);
    const dup = ids.filter((id, i) => id && ids.indexOf(id) !== i);
    const refs = (o.references || []).filter((r) => !(r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)));
    console.log(JSON.stringify({ styles: o.styles.length, valid: o.styles.length - bad.length, failed: bad, duplicateIds: dup, badReferences: refs.length }, null, 2));
    return bad.length || dup.length || refs.length ? 3 : 0;
  }
  const choice = readJson(path.join(top, DESIGN_REL_DIR, 'choice.json'));
  if (['choice', 'css', 'hardcoded'].includes(sub)) {
    if (!choice) { console.error('framed: no design saved yet. Open the page (framed ui), pick one in Studio and press "Use this design".'); return 1; }
    const errors = validateStyle(choice.style);
    if (errors.length) { console.error(`framed: the saved design is not valid: ${errors.join('; ')}`); return 1; }
  }
  if (sub === 'choice') { console.log(JSON.stringify(choice, null, 2)); return 0; }
  if (sub === 'css') { process.stdout.write(designCss(choice.style, argValue(argv, '--names', 'generic'))); return 0; }
  if (sub === 'hardcoded') {
    const dir = argValue(argv, '--app', choice.target ? choice.target.dir : '.');
    console.log(JSON.stringify(hardcodedColours(top, dir, choice.target ? choice.target.themeFiles : []), null, 2));
    return 0;
  }
  console.error('usage: framed design detect | options | choice | css [--names shadcn|generic] | hardcoded [--app <dir>]  [--root <repo>]');
  return 2;
}

function studioState(root) {
  const s = repoStatus(root);
  const top = s.root || toPosix(root);
  const presets = (readJson(path.join(__dirname, '..', 'templates', 'styles.json')) || { styles: [] }).styles.filter((x) => !validateStyle(x).length);
  const scout = readJson(path.join(top, DESIGN_REL_DIR, 'options.json'));
  const options = (scout && Array.isArray(scout.styles) ? scout.styles : []).filter((x) => !validateStyle(x).length && !contrastIssues(x).length);
  return {
    // no code yet = a new project, whose design is its foundation; otherwise a restyle
    mode: ['greenfield', 'not-git'].includes(s.state) ? 'greenfield' : 'brownfield',
    presets,
    options,
    references: scout && Array.isArray(scout.references) ? scout.references.filter((r) => r && typeof r.url === 'string' && /^https?:\/\//.test(r.url)).slice(0, 20) : [],
    ...currentLook(top, s.state, presets),
    choice: readJson(path.join(top, DESIGN_REL_DIR, 'choice.json')),
    built: fs.existsSync(path.join(top, '.framed', 'design.md')),
  };
}

// Detection reads files, so it is cached per HEAD; the page asks each time Studio opens.
const lookCache = new Map();
function currentLook(top, state, presets) {
  if (['greenfield', 'not-git'].includes(state)) return { current: [], apps: [] };
  const key = readHead(gitDirOf(top));
  const hit = lookCache.get(top);
  if (hit && hit.key === key) return hit.out;
  const { apps } = detectDesign(top);
  // how much of each app a theme change can't reach, said before anyone saves
  for (const a of apps) if (a.files.length) { const h = hardcodedColours(top, a.dir, a.files); a.hardcoded = { files: h.files, uses: h.uses }; }
  const base = presets.find((p) => p.id === 'calm') || presets[0];
  const current = base ? apps.map((a) => currentStyle(a, base)).filter((x) => x && !validateStyle(x).length) : [];
  const out = { current, apps };
  lookCache.set(top, { key, out });
  return out;
}

function saveChoice(root, body) {
  let data;
  try { data = JSON.parse(body); } catch { return { status: 400, out: { error: 'not JSON' } }; }
  const errors = validateStyle(data && data.style);
  if (errors.length) return { status: 400, out: { error: `the design is not valid: ${errors.join('; ')}` } };
  const s = repoStatus(root);
  const top = s.root || toPosix(root);
  const mode = ['greenfield', 'not-git'].includes(s.state) ? 'greenfield' : 'brownfield';
  // a restyle names the app it restyles, one the repo really has
  let target = null;
  if (mode === 'brownfield') {
    const apps = detectDesign(top).apps.filter((a) => a.files.length);
    target = apps.find((a) => a.dir === data.target);
    if (!target) return { status: 400, out: { error: `pick which app to restyle: ${apps.map((a) => a.dir).join(', ') || 'no app with a theme was found'}` } };
  }
  const choice = {
    style: data.style,
    preview: data.preview === 'dark' ? 'dark' : 'light',
    mode,
    ...(target ? { target: { dir: target.dir, name: target.name, libraries: target.libraries, themeFiles: target.files } } : {}),
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(designDir(top), 'choice.json'), `${JSON.stringify(choice, null, 2)}\n`);
  return { status: 200, out: { saved: true, choice } };
}

// ---- Refresh looks: the page starts the design scout in Claude Code's print mode -------------
// One run at a time per repo. The scout may read, write only inside .framed/design/, search and
// fetch the web, and run framed's own script; anything else is refused without asking (print
// mode never prompts). Its instructions are agents/design-scout.md, the same file the skill uses.

const SCOUT_TIMEOUT_MS = 8 * 60 * 1000;

// The claude program to start without a shell, so arguments may contain spaces. On Windows npm
// installs a claude.cmd wrapper; the program it runs is named inside it.
function claudeProgram() {
  if (process.platform !== 'win32') return 'claude';
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, 'claude.exe');
    if (fs.existsSync(exe)) return exe;
    const cmd = path.join(dir, 'claude.cmd');
    if (fs.existsSync(cmd)) {
      const m = fs.readFileSync(cmd, 'utf8').match(/"%dp0%\\?([^"]+\.exe)"/i);
      if (m && fs.existsSync(path.join(dir, m[1]))) return path.join(dir, m[1]);
    }
  }
  return null;
}
const scoutJobs = new Map(); // repo root -> { state: running|done|failed, brief, startedAt, endedAt, message }

// Started from the page, the scout gets no shell at all: framed reads the current look for it
// (below) and checks the file after it (startScout), so only reading and that one write remain.
function scoutPrompt(top, brief, look) {
  const pluginRoot = toPosix(path.join(__dirname, '..'));
  const agent = fs.readFileSync(path.join(__dirname, '..', 'agents', 'design-scout.md'), 'utf8')
    .replace(/^---[\s\S]*?---\s*/, '').split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot);
  const apps = (look || []).filter((a) => Object.keys(a.light).length).map((a) => ({ app: a.dir, libraries: a.libraries, font: a.font, radius: a.radius, light: a.light, dark: a.dark }));
  return `You are the framed design scout. Follow these instructions exactly.\n\n${agent}\n\n## This run\n\n`
    + `Repo root: ${top}\nBrief: ${brief || 'none'}\nMake 6 styles.\n\n`
    + 'In this run you cannot run commands, so skip both FRAMED steps: the current look is given here, '
    + 'and framed checks the file after you finish, dropping any style that is not valid or whose text is below 4.5:1. '
    + 'Work out contrast yourself before writing.\n\n'
    + `Current look (framed design detect): ${apps.length ? JSON.stringify(apps) : 'none, the folder has no app with a theme yet'}\n`;
}

// Text that would be hard to read: the pairs the Studio checks, below 4.5:1, in either mode.
// The accent as text on cards is left out: an accent may be a fill only (the vibe says so).
function contrastIssues(s) {
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const out = [];
  for (const mode of ['light', 'dark']) {
    const p = s[mode];
    for (const [name, a, b] of [['text', p.ink, p.bg], ['headings', p.heading || p.ink, p.bg], ['quiet text', p.muted, p.surface], ['button text', p.accentInk, p.accent]]) {
      const r = ratio(a, b);
      if (r < 4.5) out.push(`${mode} ${name} ${r.toFixed(1)}:1`);
    }
  }
  return out;
}

function startScout(repo, brief) {
  const top = repo;
  // the real, long path: Claude Code matches the write rule against it, and a Windows short name
  // (C:\Users\ABCDEF~1\…) in the working folder makes every write fall outside the rule
  let cwd = repo;
  try { cwd = toPosix(fs.realpathSync.native(repo)); } catch { /* keep as given */ }
  const job = scoutJobs.get(top);
  if (job && job.state === 'running') return { status: 409, out: { error: 'the design scout is already running' } };
  designDir(top);
  const { spawn } = require('child_process');
  const args = ['-p', '--model', 'sonnet', '--output-format', 'text', '--no-session-persistence', '--strict-mcp-config',
    // read, search, and write inside .framed/design only (an Edit rule covers every file-writing tool); no shell
    '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Edit(./.framed/design/**)',
    '--disallowedTools', 'Bash', 'PowerShell'];
  const next = { state: 'running', brief, startedAt: new Date().toISOString(), endedAt: null, message: '' };
  scoutJobs.set(top, next);
  let child;
  const program = claudeProgram();
  try {
    if (!program) throw new Error('the claude command was not found on PATH');
    child = spawn(program, args, { cwd, windowsHide: true }); // the prompt goes in on stdin
  } catch (e) {
    Object.assign(next, { state: 'failed', endedAt: new Date().toISOString(), message: `could not start Claude Code: ${e.message}` });
    return { status: 200, out: next };
  }
  let out = '', err = '';
  child.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const timer = setTimeout(() => { child.kill(); err += '\nstopped after 8 minutes'; }, SCOUT_TIMEOUT_MS);
  child.on('error', (e) => { err += e.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    const o = readJson(path.join(top, DESIGN_REL_DIR, 'options.json'));
    const fresh = o && o.madeAt && Date.parse(o.madeAt) >= Date.parse(next.startedAt) - 60000;
    const shaped = o && Array.isArray(o.styles) ? o.styles.filter((s) => !validateStyle(s).length) : [];
    const valid = shaped.filter((s) => !contrastIssues(s).length).length;
    const dropped = (o && Array.isArray(o.styles) ? o.styles.length : 0) - valid;
    if (code === 0 && fresh && valid) Object.assign(next, { state: 'done', message: `${valid} new look${valid > 1 ? 's' : ''}${dropped ? `; ${dropped} dropped because they were not valid or hard to read` : ''}.` });
    else Object.assign(next, { state: 'failed', message: (err.trim() || out.trim() || `Claude Code exited with ${code}`).slice(-400) + (code === 0 && !fresh ? ' (no new options were written)' : '') });
    next.endedAt = new Date().toISOString();
  });
  let look = [];
  try { look = detectDesign(top).apps; } catch { /* no look to give */ }
  child.stdin.end(scoutPrompt(cwd, brief, look));
  return { status: 200, out: next };
}

function cmdUi(argv) {
  const root = resolveRoot(argv);
  const port = Number(argValue(argv, '--port', UI_PORT));
  const page = path.join(__dirname, '..', 'ui', 'index.html');
  // This code is loaded once, but the page is re-read on every request: say when they no longer match.
  const started = fs.statSync(__filename).mtimeMs;
  // No tab open for a while (an open tab asks every 2s): stop, so old pages don't hold the ports.
  // The next "page open" starts a fresh one. framed's own checks (x-framed: probe) aren't visits.
  const idleMs = Number(argValue(argv, '--idle-ms', PAGE_IDLE_MS));
  let lastVisit = Date.now();
  const idleCheck = setInterval(() => {
    const scout = scoutJobs.get(repoStatus(root).root || toPosix(root));
    if (Date.now() - lastVisit < idleMs || (scout && scout.state === 'running')) return;
    clearInterval(idleCheck);
    server.close(() => process.exit(0));
    server.closeAllConnections();
  }, Math.min(60000, idleMs));
  const server = require('http').createServer((req, res) => {
    const [url, query] = req.url.split('?');
    const q = new URLSearchParams(query || '');
    const json = (status, out) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(out)); };
    // Only this machine's own address: a website that points its name at 127.0.0.1 gets nothing.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { json(403, { error: 'wrong host' }); return; }
    if (req.headers['x-framed'] !== 'probe') lastVisit = Date.now();
    if (url === '/studio' && req.method === 'GET') {
      try { json(200, studioState(root)); } catch (e) { json(500, { error: e.message }); }
      return;
    }
    if (url === '/scout' && req.method === 'GET') {
      json(200, scoutJobs.get(repoStatus(root).root || toPosix(root)) || { state: 'idle' });
      return;
    }
    if (url === '/scout' && req.method === 'POST') {
      if (req.headers['x-framed'] !== 'studio' || !/^application\/json/.test(req.headers['content-type'] || '')) { json(403, { error: 'only the framed page can start the design scout' }); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let brief = '';
        try { brief = String(JSON.parse(body).brief || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400); } catch { json(400, { error: 'not JSON' }); return; }
        const r = startScout(repoStatus(root).root || toPosix(root), brief);
        json(r.status, r.out);
      });
      return;
    }
    if (url === '/design' && req.method === 'POST') {
      // Only the page itself: a custom header can't be sent cross-site without a CORS preflight,
      // which this server never answers, so another website can't post here.
      if (req.headers['x-framed'] !== 'studio' || !/^application\/json/.test(req.headers['content-type'] || '')) { json(403, { error: 'only the framed page can save a design' }); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on('end', () => { try { const r = saveChoice(root, body); json(r.status, r.out); } catch (e) { json(500, { error: e.message }); } });
      return;
    }
    if (url === '/module' || url === '/file') {
      // the repo root as /state resolved it (the session may start in a subfolder)
      const top = repoStatus(root).root;
      let body;
      try { body = JSON.stringify(url === '/module' ? moduleView(top, q.get('name') || '') : fileView(top, q.get('path') || '')); }
      catch (e) { body = JSON.stringify({ error: e.message }); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url === '/state') {
      let body;
      try { body = JSON.stringify({ ...uiState(root), stale: fs.statSync(__filename).mtimeMs !== started }); } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(page));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('error', (e) => {
    console.error(`framed: ${e.code === 'EADDRINUSE' ? `port ${port} is in use; try --port <n>` : e.message}`);
    clearInterval(idleCheck);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`framed page: http://127.0.0.1:${port}`));
  return undefined; // keep running
}

// ---- the page opens by itself; the status line feeds it usage (§19, §17) --------------------
//   node framed.js page open [--reason <ticket|setup|design>]   start this repo's page if needed and
//                                         open the browser once per reason; silent and exit 0 when off
//   node framed.js page on|off|status     the person's own choice (default on), kept in ~/.framed
//   node framed.js statusline             Claude Code status line command: saves usage, prints one line
//   node framed.js statusline install|uninstall   add or remove it in ~/.claude/settings.json
// The choice and the page records live in the person's home folder, never the repo: one person
// turning the page off must not turn it off for the team.

const os = require('os');
const USER_DIR = () => process.env.FRAMED_HOME || path.join(os.homedir(), '.framed');
const userFile = (name) => path.join(USER_DIR(), name);
function readUser(name, fallback) { const v = readJson(userFile(name)); return v && typeof v === 'object' ? v : fallback; }
function writeUser(name, value) { fs.mkdirSync(USER_DIR(), { recursive: true }); fs.writeFileSync(userFile(name), `${JSON.stringify(value, null, 2)}\n`); }
const pageEnabled = () => readUser('settings.json', {}).page !== 'off';
// one key per folder, whether it was reached by its long path or a Windows short name (ABCDEF~1)
function pathKey(p) { let r = p; try { r = fs.realpathSync.native(p); } catch { /* keep */ } return toPosix(r).toLowerCase(); }

// Is a framed page for this repo answering on that port? -> its /state, or null
function probePage(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port, path: '/state', headers: { 'x-framed': 'probe' }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const sameRoot = (a, b) => a && b && pathKey(a) === pathKey(b);

// On Windows, Node would escape start's empty title ("") into \"\" and start would fail without a
// word, so the command line goes to cmd exactly as written.
function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }];
  return platform === 'darwin' ? ['open', [url], {}] : ['xdg-open', [url], {}];
}
function openBrowser(url) {
  if (process.env.FRAMED_NO_BROWSER) return true; // tests
  const [cmd, args, opts] = browserCommand(url);
  try { require('child_process').spawn(cmd, args, { ...opts, detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}

// This repo's page: reuse a running one (restart it if framed changed since it started), else start
// one in the background on the first free port from 4646.
async function ensurePage(root) {
  const pages = readUser('pages.json', {});
  const known = pages[pathKey(root)];
  if (known) {
    const s = await probePage(known.port);
    // a page from before the stale check sends no "stale" field: it is old too
    if (s && sameRoot(s.root, root) && s.stale === false) return { port: known.port, started: false };
    if (s && sameRoot(s.root, root) && s.stale !== false && known.pid) { try { process.kill(known.pid); } catch { /* gone */ } }
  }
  for (let port = UI_PORT; port < UI_PORT + 40; port += 1) {
    const s = await probePage(port, 400);
    if (s && sameRoot(s.root, root) && s.stale === false) { pages[pathKey(root)] = { ...(known || {}), port }; writeUser('pages.json', pages); return { port, started: false }; }
    if (s) continue; // another repo's page, or an old one
    const child = require('child_process').spawn(process.execPath, [__filename, 'ui', '--root', root, '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 25; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      const up = await probePage(port, 400);
      if (up && sameRoot(up.root, root)) {
        pages[pathKey(root)] = { ...(known || {}), port, pid: child.pid, startedAt: new Date().toISOString() };
        writeUser('pages.json', pages);
        return { port, started: true };
      }
    }
    return { error: `the page did not start on port ${port}` };
  }
  return { error: 'no free port between 4646 and 4685' };
}

async function cmdPage(argv) {
  const [sub] = argv;
  const root = repoStatus(resolveRoot(argv)).root || toPosix(resolveRoot(argv));
  const settings = readUser('settings.json', {});
  if (sub === 'on' || sub === 'off') {
    writeUser('settings.json', { ...settings, page: sub });
    if (sub === 'off') {
      // stop the pages this person started; they come back with "page on" and the next task
      const pages = readUser('pages.json', {});
      for (const p of Object.values(pages)) if (p.pid) { try { process.kill(p.pid); } catch { /* gone */ } }
      writeUser('pages.json', {});
    }
    console.log(sub === 'on' ? 'framed page: on. It opens when a fix or setup starts.' : 'framed page: off. It won\'t open by itself; say "turn the framed page on" to bring it back.');
    return 0;
  }
  if (sub === 'status') {
    const known = readUser('pages.json', {})[pathKey(root)];
    const s = known ? await probePage(known.port) : null;
    console.log(JSON.stringify({ page: pageEnabled() ? 'on' : 'off', running: !!(s && sameRoot(s.root, root)), url: s ? `http://127.0.0.1:${known.port}/` : null, statusLine: statusLineInstalled() }, null, 2));
    return 0;
  }
  if (sub === 'open') {
    if (!pageEnabled()) return 0; // off: say nothing, do nothing
    const reason = argValue(argv, '--reason', null); // none: the person asked for it, so it always opens
    const r = await ensurePage(root);
    if (r.error) { console.log(`framed page: couldn't start (${r.error}); the fix goes on without it.`); return 0; }
    const pages = readUser('pages.json', {});
    const rec = pages[pathKey(root)] || {};
    const page = /^setup$/i.test(reason) ? 'map' : /^design$/i.test(reason) ? 'studio' : 'build';
    const url = `http://127.0.0.1:${r.port}/#/${page}`;
    // once per reason: resuming a task or a second setup run doesn't pop the browser again
    if (!reason || rec.openedFor !== reason) {
      openBrowser(url);
      if (reason) { pages[pathKey(root)] = { ...rec, openedFor: reason }; writeUser('pages.json', pages); }
      console.log(`framed page: opened ${url}`);
    } else {
      console.log(`framed page: running at ${url}`);
    }
    return 0;
  }
  console.error('usage: framed page open [--reason <ticket|setup|design>] | on | off | status');
  return 2;
}

// --- status line: Claude Code gives a status line command the session's usage on stdin (the only
// documented source of context left and plan limits). framed saves it for the page and prints one line.
const STATUS_CMD = () => `node "${toPosix(__filename)}" statusline`;
const claudeSettingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
function statusLineInstalled() {
  const s = readJson(claudeSettingsFile());
  return !!(s && s.statusLine && typeof s.statusLine.command === 'string' && s.statusLine.command.includes('framed.js') && s.statusLine.command.includes('statusline'));
}

function statusLineText(input, st) {
  const parts = ['framed'];
  if (st && st.state === 'task' && st.task) {
    const i = STOPS.indexOf(st.task.step === 'blame' && st.task.status === 'blocked' ? 'gate' : st.task.step);
    parts.push(`${st.task.ticket} ${st.task.status === 'blocked' ? 'waiting for you' : `${st.task.step}${i >= 0 ? ` ${i + 1}/${STOPS.length}` : ''}`}`);
  } else if (st && st.state === 'ready') parts.push('ready');
  else if (st && st.state === 'uninitialized') parts.push('not set up');
  const cw = input && input.context_window;
  if (cw && typeof cw.used_percentage === 'number') parts.push(`context ${Math.max(0, Math.round(100 - cw.used_percentage))}% left`);
  const rl = input && input.rate_limits;
  if (rl && rl.five_hour && typeof rl.five_hour.used_percentage === 'number') parts.push(`5h ${Math.round(rl.five_hour.used_percentage)}%`);
  if (rl && rl.seven_day && typeof rl.seven_day.used_percentage === 'number') parts.push(`week ${Math.round(rl.seven_day.used_percentage)}%`);
  return parts.join(' · ');
}

function cmdStatusline(argv) {
  const [sub] = argv;
  if (sub === 'install' || sub === 'uninstall') {
    const file = claudeSettingsFile();
    let settings = {};
    if (fs.existsSync(file)) {
      try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`framed: ${file} is not valid JSON, so it was not changed (${e.message})`); return 1; }
    }
    if (sub === 'install') {
      if (statusLineInstalled()) { console.log('framed status line: already on.'); return 0; }
      if (settings.statusLine) { console.error(`framed: you already have a status line (${JSON.stringify(settings.statusLine.command || settings.statusLine)}). framed won't replace it; remove it first if you want framed's.`); return 1; }
      settings.statusLine = { type: 'command', command: STATUS_CMD() };
    } else {
      if (!statusLineInstalled()) { console.log('framed status line: not installed, nothing to remove.'); return 0; }
      delete settings.statusLine;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    console.log(sub === 'install' ? `framed status line: on, in ${file}. It shows the fix's step, context left and plan usage, and feeds the page.` : `framed status line: removed from ${file}.`);
    return 0;
  }
  // the status line itself: stdin is Claude Code's JSON; keep it short and never fail
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { /* print what we can */ }
  const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  let st = null;
  try { st = repoStatus(cwd); } catch { /* not a repo */ }
  try {
    const usage = readUser('usage.json', {});
    usage[pathKey(st && st.root ? st.root : cwd)] = {
      at: new Date().toISOString(), sessionId: input.session_id || null, model: input.model && input.model.display_name,
      contextWindow: input.context_window || null, rateLimits: input.rate_limits || null, costUsd: input.cost && input.cost.total_cost_usd,
    };
    writeUser('usage.json', usage);
  } catch { /* the line still prints */ }
  console.log(statusLineText(input, st));
  return 0;
}

// usage for the page: the last status line reading for this repo, if recent
function usageFor(root) {
  const u = readUser('usage.json', {})[pathKey(root)];
  if (!u || Date.now() - Date.parse(u.at) > 30 * 60 * 1000) return null;
  const cw = u.contextWindow || {}, rl = u.rateLimits || {};
  const win = (w) => (w && typeof w.used_percentage === 'number' ? { usedPct: Math.round(w.used_percentage), resetsAt: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null } : null);
  return {
    at: u.at, model: u.model || null,
    contextLeftPct: typeof cw.used_percentage === 'number' ? Math.max(0, Math.round(100 - cw.used_percentage)) : null,
    contextSize: cw.context_window_size || null,
    fiveHour: win(rl.five_hour), week: win(rl.seven_day),
  };
}

// ---- entry ----------------------------------------------------------------------------------

const COMMANDS = {
  config: cmdConfig, task: cmdTask, guard: cmdGuard, status: cmdStatus, detect: cmdDetect, map: cmdMap, deps: cmdDeps,
  why: cmdWhy, reverts: cmdReverts, suite: cmdSuite, ui: cmdUi, design: cmdDesign, tests: cmdTests,
  page: cmdPage, statusline: cmdStatusline,
};

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !COMMANDS[cmd]) {
    console.error(`usage: framed <${Object.keys(COMMANDS).join('|')}> [--root <dir>]`);
    return 2;
  }
  return COMMANDS[cmd](rest);
}

if (require.main === module) {
  const r = main(process.argv.slice(2));
  if (r && typeof r.then === 'function') r.then((code) => { process.exitCode = code; }, (e) => { console.error(`framed: ${e.message}`); process.exitCode = 1; });
  else process.exitCode = r;
}

module.exports = {
  buildModules, matchesAlias, staticCSharp,
  loadConfig, validate, DEFAULTS, CONFIG_REL_PATH,
  parseFrontmatter, findActiveTask, TASKS_REL_DIR,
  shellSegments, parseGit, guardCommand, branchHasTicket,
  detectPrefixes, detectBranchPattern, detectTests, selectSuites, findReverts, parseRange, repoStatus,
  loadTsPaths, stripJsonComments,
  parseWorkingBody, buildRoad, parseStepCommits, tokensByStop, parseMapMd, blastModules, parseBlastRadius,
  validateStyle, saveChoice, parseColor, parseCssVars, slotsFrom, detectDesign, currentStyle, designCss, hardcodedColours,
  typeSizes, scoutPrompt, contrastIssues, densityScale, motionEase, browserCommand,
  coveredPaths, repoPathOf, selectByCoverage, recordCoverage, UNTRUSTED_CHANGE,
  resolveTsFile, resolveWorkspaceImport, loadWorkspacePackages, resolveSubpathImport, COCHANGE_NOISE, staticTs, TEST_FILE_RE,
  statusLineText, staticPython, staticGo, staticJvm, staticPhp, staticRuby,
};
