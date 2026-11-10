'use strict';
// Tests for scripts/framed.js. Run with `node --test` from the repo root. No dependencies.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadTsPaths } = require('./framed.js');

// Each fixture is a throwaway folder holding the given files; loadTsPaths reads them by
// relative path, the way map scan hands it the tracked file list.
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-test-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return { root, files: Object.keys(files) };
}

describe('loadTsPaths', () => {
  const roots = [];
  const make = (files) => { const f = fixture(files); roots.push(f.root); return f; };
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

  // --- characterization: what works today and must keep working ---

  test('reads paths and baseUrl from a plain tsconfig', () => {
    const { root, files } = make({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: 'src', paths: { '~/*': ['lib/*'] } } }),
    });
    assert.deepEqual(loadTsPaths(root, files), [{ dir: '', baseDir: 'src', paths: { '~/*': ['lib/*'] } }]);
  });

  test('skips a tsconfig without compilerOptions.paths', () => {
    const { root, files } = make({ 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }) });
    assert.deepEqual(loadTsPaths(root, files), []);
  });

  test('ignores files that are not tsconfig*.json', () => {
    const { root, files } = make({
      'package.json': JSON.stringify({ compilerOptions: { paths: { 'x/*': ['*'] } } }),
      'src/app.ts': 'export const a = 1;',
    });
    assert.deepEqual(loadTsPaths(root, files), []);
  });

  test('tolerates // and /* */ comments outside strings, and trailing commas', () => {
    const { root, files } = make({
      'tsconfig.json': [
        '{',
        '  // line comment',
        '  "compilerOptions": {',
        '    /* block',
        '       comment */',
        '    "paths": { "~/*": ["lib/*"], },',
        '  },',
        '}',
      ].join('\n'),
    });
    assert.deepEqual(loadTsPaths(root, files), [{ dir: '', baseDir: '.', paths: { '~/*': ['lib/*'] } }]);
  });

  test('a tsconfig that is not valid JSON is skipped, not thrown', () => {
    const { root, files } = make({ 'tsconfig.json': '{ this is not json' });
    assert.deepEqual(loadTsPaths(root, files), []);
  });

  test('resolves baseDir relative to the tsconfig folder for nested configs', () => {
    const { root, files } = make({
      'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    });
    assert.deepEqual(loadTsPaths(root, files), [{ dir: 'apps/web', baseDir: 'apps/web', paths: { '@/*': ['src/*'] } }]);
  });

  // --- the bug (FRM-1) ---

  test('FRM-1: paths survive when the tsconfig has "@/*" and "**/*.ts" strings', () => {
    const { root, files } = make({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./*'] } },
        include: ['**/*.ts'],
      }, null, 2),
    });
    assert.deepEqual(loadTsPaths(root, files), [{ dir: '', baseDir: '.', paths: { '@/*': ['./*'] } }]);
  });
});

// ---- guard, conventions, suite selection ----------------------------------------------------

const {
  guardCommand, branchHasTicket, detectPrefixes, detectBranchPattern, selectSuites, validate,
} = require('./framed.js');

describe('guard', () => {
  const ctx = (branch, extra = {}) => ({
    branch, defaultBranches: ['main'], ticketPrefixes: ['PROJ', 'OPS'], branchPattern: 'bugfix/{ticket}-{slug}', ...extra,
  });
  const blocked = (cmd, c) => assert.ok(guardCommand(cmd, c), `expected block: ${cmd}`);
  const allowed = (cmd, c) => assert.equal(guardCommand(cmd, c), null, `expected allow: ${cmd}`);

  test('push and force rules are unchanged', () => {
    blocked('git push origin main', ctx('bugfix/PROJ-1-x'));
    blocked('git push', ctx('main'));
    blocked('git push --force origin bugfix/PROJ-1-x', ctx('bugfix/PROJ-1-x'));
    blocked('git push origin +bugfix/PROJ-1-x', ctx('bugfix/PROJ-1-x'));
    allowed('git push -u origin bugfix/PROJ-1-x', ctx('bugfix/PROJ-1-x'));
  });

  test("the repo's own branch convention passes", () => {
    for (const b of ['bugfix/PROJ-4840-ref-no', 'feature/admin-portal/PROJ-3811-add', 'bugFix/PROJ-5963_original', 'OPS-12-x', 'PROJ-7']) {
      allowed(`git checkout -b ${b}`, ctx('main'));
      allowed('git commit -m x', ctx(b));
    }
  });

  test('branches without a configured ticket are blocked', () => {
    for (const b of ['hotfix-1', 'feature/dashboard-redesign', 'bugfix/QA-12-x', 'xPROJ-12', 'bugfix/PROJ-x']) {
      blocked(`git checkout -b ${b}`, ctx('main'));
      blocked('git commit -m x', ctx(b));
    }
  });

  test('the block message shows the configured pattern', () => {
    assert.match(guardCommand('git checkout -b wip', ctx('main')), /bugfix\/PROJ-123-short-slug/);
  });

  test('framed-init is always allowed; commits on main never are', () => {
    allowed('git commit -m x', ctx('framed-init'));
    blocked('git commit -m x', ctx('main'));
  });

  test('PowerShell commands are guarded the same way', () => {
    const ps = (cmd, c) => guardCommand(cmd, c, 'powershell');
    assert.ok(ps('Set-Location C:\\repo; git push origin main', ctx('bugfix/PROJ-1-x')));
    assert.ok(ps('& git commit -m x', ctx('main')));
    assert.ok(ps('git.exe push --force', ctx('bugfix/PROJ-1-x')));
    assert.ok(ps('& "C:\\Program Files\\Git\\cmd\\git.exe" push origin main', ctx('bugfix/PROJ-1-x')));
    assert.ok(ps('git checkout -b wip', ctx('main')));
    assert.equal(ps('git -C C:\\repo push -u origin bugfix/PROJ-1-x', ctx('bugfix/PROJ-1-x')), null);
    assert.equal(ps('git commit -m "fix: `"quoted`" name"', ctx('bugfix/PROJ-1-x')), null);
  });

  test('without prefixes the branch rule is skipped', () => {
    allowed('git checkout -b anything', ctx('main', { ticketPrefixes: null }));
  });

  test('branchHasTicket needs the key at a segment start', () => {
    assert.ok(branchHasTicket('bugfix/PROJ-1-a', ['PROJ']));
    assert.ok(!branchHasTicket('bugfix/APROJ-1-a', ['PROJ']));
    assert.ok(!branchHasTicket('bugfix/PROJ-a', ['PROJ']));
  });
});

describe('detectPrefixes', () => {
  test('keeps every board seen on several tickets, by distinct ticket count', () => {
    const branches = [];
    for (let i = 0; i < 40; i += 1) branches.push(`feature/PROJ-${100 + i}-x`);
    for (let i = 0; i < 6; i += 1) branches.push(`bugfix/OPS-${i}-y`);
    branches.push('feature/QA-1-z', 'feature/QA-1-z2');
    const r = detectPrefixes(branches, ['fix UTF-8 handling', 'PROJ-100 again', 'PROJ-100 and again']);
    assert.deepEqual(r.prefixes, ['PROJ', 'OPS']);
  });

  test('one busy ticket does not make a prefix', () => {
    const r = detectPrefixes(Array.from({ length: 30 }, () => 'feature/ABC-1-x'), []);
    assert.deepEqual(r.prefixes, []);
  });

  test('stoplisted look-alikes are ignored', () => {
    const subjects = Array.from({ length: 20 }, (_, i) => `support ISO-${8000 + i} and UTF-${i}`);
    assert.deepEqual(detectPrefixes([], subjects).prefixes, []);
  });
});

describe('detectBranchPattern', () => {
  const many = (lead, n, key = 'PROJ') => Array.from({ length: n }, (_, i) => `${lead}${key}-${i + 1}-x`);

  test('a bug-ish folder wins for a patch even when feature/ is more common', () => {
    const r = detectBranchPattern([...many('feature/', 50), ...many('bugfix/', 12), 'main-copy'], ['PROJ']);
    assert.equal(r.pattern, 'bugfix/{ticket}-{slug}');
    assert.equal(r.convention, true);
  });

  test('no bug folder: the most common lead is used', () => {
    assert.equal(detectBranchPattern([...many('', 15), ...many('story/', 5)], ['PROJ']).pattern, '{ticket}-{slug}');
    assert.equal(detectBranchPattern([...many('story/', 15), ...many('', 5)], ['PROJ']).pattern, 'story/{ticket}-{slug}');
  });

  test('few keyed branches means no convention, framed default applies', () => {
    const branches = [...many('bugfix/', 12), ...Array.from({ length: 200 }, (_, i) => `wip-${i}`)];
    const r = detectBranchPattern(branches, ['PROJ']);
    assert.equal(r.convention, false);
    assert.equal(r.pattern, '{ticket}-{slug}');
  });
});

describe('selectSuites', () => {
  const tests = [
    { path: 'backend', command: 'dotnet test' },
    { path: 'web', command: 'npx nx run-many -t test' },
    { path: 'mobile', command: 'npm test' },
  ];
  const scan = {
    files: [
      { path: 'backend/Core/Invoice.cs', module: 'Core' },
      { path: 'backend/Api/Controller.cs', module: 'Api' },
      { path: 'web/libs/ui/Billing.tsx', module: 'ui' },
      { path: 'mobile/app/Home.tsx', module: 'mobile' },
    ],
    modules: [
      { name: 'Core', path: 'backend/Core' }, { name: 'Api', path: 'backend/Api' },
      { name: 'ui', path: 'web/libs/ui' }, { name: 'mobile', path: 'mobile' },
    ],
    moduleEdges: [
      { from: 'Api', to: 'Core', source: 'static', count: 40 },
      { from: 'Core', to: 'ui', source: 'co-change', count: 12 },
      { from: 'mobile', to: 'ui', source: 'co-change', count: 2 },
    ],
  };
  const paths = (r) => r.map((t) => t.path).sort();

  test('touched project plus projects linked to it', () => {
    assert.deepEqual(paths(selectSuites(tests, ['backend/Core/Invoice.cs'], scan)), ['backend', 'web']);
  });

  test('weak co-change links (under 3) do not pull a project in', () => {
    assert.deepEqual(paths(selectSuites(tests, ['mobile/app/Home.tsx'], scan)), ['mobile']);
  });

  test('a touched file outside every project, or no scan, runs everything', () => {
    assert.equal(selectSuites(tests, ['docs/readme.md'], scan).length, 3);
    assert.equal(selectSuites(tests, ['mobile/app/Home.tsx'], null).length, 3);
  });
});

describe('config', () => {
  const base = { defaultBranch: 'main', branchPattern: '{ticket}-{slug}', protectedPaths: [], models: { mapPass: 'sonnet' }, budgets: { mapPass: 25 } };

  test('lists are required and checked', () => {
    const { errors } = validate({ ...base, tests: [{ path: '.', command: '' }], ticketPrefixes: ['proj'] }, {});
    assert.equal(errors.length, 2);
  });

  test('branchPattern needs both placeholders', () => {
    const { errors } = validate({ ...base, branchPattern: 'bugfix/{ticket}', tests: [{ path: '.', command: 'x' }], ticketPrefixes: ['PROJ'] }, {});
    assert.equal(errors.length, 1);
  });
});

// ---- reverts: putting back lines a recent commit removed (§11) ------------------------------

const { execFileSync } = require('node:child_process');
const { findReverts, parseRange } = require('./framed.js');

describe('findReverts', () => {
  const roots = [];
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

  // A throwaway repo; commit() writes the file and commits it, optionally back-dated.
  function repo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-revert-'));
    roots.push(root);
    const g = (args, env = {}) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    g(['init', '-q', '-b', 'main']);
    const write = (text) => fs.writeFileSync(path.join(root, 'Billing.cs'), text);
    const commit = (text, msg, date) => {
      write(text);
      g(['add', '-A']);
      const env = date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {};
      g(['commit', '-q', '-m', msg], env);
    };
    return { root, write, commit };
  }

  const KEEP = 'invoiceData.TaxTotal = existingTaxTotal; // restore preserved tax fields';
  const KEEP2 = 'invoiceData.VATApplicable = existingVATApplicable;';
  const body = (...lines) => ['class Billing {', '  void Save() {', ...lines.map((l) => `    ${l}`), '  }', '}', ''].join('\n');

  test('putting back two lines a recent commit removed is a revert', () => {
    const r = repo();
    r.commit(body(KEEP, KEEP2, 'Save();'), 'initial');
    r.commit(body('Save();'), 'fix');
    r.write(body(KEEP, KEEP2, 'Save();'));
    const found = findReverts(r.root);
    assert.equal(found.length, 1);
    assert.equal(found[0].subject, 'fix');
    assert.equal(found[0].lines.length, 2);
  });

  test('lines a commit only moved are not a removal', () => {
    const r = repo();
    r.commit(body(KEEP, KEEP2, 'Save();'), 'initial');
    r.commit(body('Save();', KEEP, KEEP2), 'reorder');
    r.write(body(KEEP, KEEP2, 'Save();', KEEP, KEEP2));
    assert.deepEqual(findReverts(r.root), []);
  });

  test('one short line in common is a coincidence, not a revert', () => {
    const r = repo();
    r.commit(body('var total = 0m;', 'Save();'), 'initial');
    r.commit(body('Save();'), 'fix');
    r.write(body('var total = 0m;', 'Save();'));
    assert.deepEqual(findReverts(r.root), []);
  });

  test('a removal older than the window does not count', () => {
    const r = repo();
    r.commit(body(KEEP, KEEP2, 'Save();'), 'initial', '2022-01-01T10:00:00');
    r.commit(body('Save();'), 'old removal', '2022-02-01T10:00:00');
    r.write(body(KEEP, KEEP2, 'Save();'));
    assert.deepEqual(findReverts(r.root), []);
  });
});

describe('parseRange', () => {
  test('accepts a-b, a,b and a single line; rejects nonsense', () => {
    assert.deepEqual(parseRange('10-20'), [10, 20]);
    assert.deepEqual(parseRange('10,20'), [10, 20]);
    assert.deepEqual(parseRange('7'), [7, 7]);
    assert.equal(parseRange('20-10'), null);
    assert.equal(parseRange('x'), null);
  });
});

// ---- status: what the session-start greeting says (§18) -------------------------------------

const { repoStatus } = require('./framed.js');

describe('repoStatus', () => {
  const roots = [];
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
  const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-status-')); roots.push(r); return r; };
  const g = (root, args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const repo = (files) => {
    const r = tmp();
    g(r, ['init', '-q', '-b', 'main']);
    for (const [rel, text] of Object.entries(files)) put(r, rel, text);
    g(r, ['add', '-A']);
    g(r, ['commit', '-q', '--allow-empty', '-m', 'init']);
    return r;
  };
  const CONFIG = JSON.stringify({ tests: [{ path: '.', command: 'npm test' }], ticketPrefixes: ['ABC'] });
  const MAP = '# Map: x\n## What this is\n## Modules\n## How they connect\n## Watch out\n## Unsure\n- a\n## Hand-maintained\n';

  test('outside a git repo it is silent', () => {
    assert.equal(repoStatus(tmp()).state, 'not-git');
  });

  test('a repo with no code is greenfield', () => {
    assert.equal(repoStatus(repo({ 'README.md': '# hi' })).state, 'greenfield');
  });

  test('code but no setup is uninitialized, also from a subfolder', () => {
    const r = repo({ 'src/app.ts': 'export const a = 1;' });
    assert.equal(repoStatus(r).state, 'uninitialized');
    assert.equal(repoStatus(path.join(r, 'src')).state, 'uninitialized');
  });

  test('setup on an unmerged framed-init branch is pending, not uninitialized', () => {
    const r = repo({ 'src/app.ts': 'export const a = 1;' });
    g(r, ['branch', 'framed-init']);
    assert.equal(repoStatus(r).state, 'setup-pending');
  });

  test('config and map present is ready; a broken config says so', () => {
    const r = repo({ 'src/app.ts': 'x', '.framed/config.json': CONFIG, '.framed/map.md': MAP });
    const s = repoStatus(r);
    assert.equal(s.state, 'ready');
    assert.deepEqual(s.ticketPrefixes, ['ABC']);
    put(r, '.framed/config.json', '{ not json');
    assert.equal(repoStatus(r).state, 'setup-invalid');
  });

  test('a working file for the current branch is a task in progress', () => {
    const r = repo({ 'src/app.ts': 'x', '.framed/config.json': CONFIG, '.framed/map.md': MAP });
    g(r, ['checkout', '-q', '-b', 'ABC-7-fix-it']);
    put(r, '.framed/tasks/ABC-7.md', '---\nticket: ABC-7\ntitle: Fix it\ntier: patch\nbranch: ABC-7-fix-it\nstatus: blocked\nstep: suite\n---\n');
    const s = repoStatus(r);
    assert.equal(s.state, 'task');
    assert.equal(s.task.step, 'suite');
  });
});

// ---- detectTests: real runners only (§10, §13) ----------------------------------------------

const { detectTests } = require('./framed.js');

describe('detectTests', () => {
  const roots = [];
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
  const make = (files) => { const f = fixture(files); roots.push(f.root); return f; };

  test('a solution without a test project is not a suite', () => {
    const f = make({ 'api/Api.sln': '', 'api/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'api/Api/Program.cs': '' });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests, []);
    assert.match(r.noRunner[0].why, /no test project/);
  });

  test('a solution with an xUnit project is, with its test file count', () => {
    const f = make({
      'api/Api.sln': 'Project("{FAE04EC0}") = "Api.Tests", "Api.Tests\\Api.Tests.csproj", "{1}"\nEndProject\n',
      'api/Api/Api.csproj': '<Project/>',
      'api/Api.Tests/Api.Tests.csproj': '<PackageReference Include="xunit" Version="2.9.0" />',
      'api/Api.Tests/InvoiceTests.cs': '', 'api/Api.Tests/DiscountTests.cs': '',
    });
    const r = detectTests(f.root, f.files);
    assert.equal(r.tests.length, 1);
    assert.equal(r.tests[0].command, 'dotnet test Api.sln');
    assert.equal(r.tests[0].testFiles, 2);
  });

  test('an MSTest.Sdk project counts, and a nested solution it already covers adds nothing', () => {
    const f = make({
      'App.slnx': '<Solution><Project Path="tests/Unit/Unit.csproj" /></Solution>',
      'tests/Unit/Unit.slnx': '<Solution><Project Path="Unit.csproj" /></Solution>',
      'tests/Unit/Unit.csproj': '<Project Sdk="MSTest.Sdk"></Project>',
      'tests/Unit/CartTests.cs': '',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests.map((t) => t.command), ['dotnet test App.slnx']);
    assert.deepEqual(r.noRunner, []);
  });

  test('a Rails app with rspec gets its runner next to npm', () => {
    const f = make({
      'Gemfile': "group :test do\n  gem 'rspec-rails'\nend\n",
      'package.json': '{"scripts":{"test":"vitest run"}}',
      'spec/models/user_spec.rb': '', 'app/javascript/a.test.ts': '',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests.map((t) => `${t.command}:${t.testFiles}`).sort(), ['bundle exec rspec:1', 'npm test:1']);
    assert.deepEqual(r.unrun, []);
  });

  test('test files no runner covers are reported, config files are not', () => {
    const f = make({ 'lib/foo_test.exs': '', 'test/foo.test.exs': '', 'app/tsconfig.spec.json': '' });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests, []);
    assert.deepEqual(r.unrun.map((u) => `${u.ext}:${u.testFiles}`), ['exs:1']);
  });

  test('an Nx workspace with only a build vite.config has no runner', () => {
    const f = make({
      'nx.json': '{ "targetDefaults": { "build": {} } }',
      'apps/web/vite.config.ts': 'export default defineConfig({ plugins: [react()] })',
      'apps/web/src/main.tsx': '',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests, []);
    assert.match(r.noRunner[0].why, /Nx workspace/);
  });

  test('a vite.config that configures vitest is a runner', () => {
    const f = make({
      'nx.json': '{}',
      'apps/web/vite.config.ts': 'export default defineConfig({ test: { environment: "jsdom" } })',
      'apps/web/src/a.spec.ts': '',
    });
    assert.equal(detectTests(f.root, f.files).tests.length, 1);
  });

  test('a Playwright suite inside the workspace is skipped, and its specs do not count as unit tests', () => {
    const f = make({
      'nx.json': '{}',
      'Tests/UI-Automation/package.json': '{ "scripts": { "test": "playwright test" } }',
      'Tests/UI-Automation/TestSpecs/login.spec.ts': '',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests, []);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].path, 'Tests/UI-Automation');
  });
});

describe('config with no unit tests', () => {
  test('an empty tests list is valid', () => {
    const { errors } = validate({
      defaultBranch: 'main', branchPattern: '{ticket}-{slug}', protectedPaths: [], models: { mapPass: 'sonnet' }, budgets: { mapPass: 25 },
      tests: [], ticketPrefixes: ['APP'],
    }, {});
    assert.deepEqual(errors, []);
  });

  test('suite selection with no tests selects nothing', () => {
    assert.deepEqual(selectSuites([], ['src/a.ts'], null), []);
  });
});

describe('buildModules', () => {
  const { buildModules } = require('./framed.js');

  test('a project file inside a dot-folder is not a module', () => {
    // Vite's cache folder holds a package.json; when someone commits it, it must not become a module.
    const r = buildModules([
      'portal/package.json', 'portal/src/main.ts',
      'portal/.vite/deps/package.json', 'portal/.vite/deps/_metadata.json',
    ]);
    assert.deepEqual([...r.modules.keys()], ['portal']);
    assert.equal(r.moduleOf.get('portal/.vite/deps/package.json'), 'portal');
  });

  test('real projects still nest', () => {
    const r = buildModules(['package.json', 'libs/ui/package.json', 'libs/ui/a.ts', 'b.ts']);
    assert.equal(r.moduleOf.get('libs/ui/a.ts'), 'ui');
    assert.equal(r.moduleOf.get('b.ts'), '(root)');
  });
});

describe('matchesAlias', () => {
  const { matchesAlias } = require('./framed.js');

  test('a scoped npm package is not an "@/*" alias', () => {
    assert.equal(matchesAlias('@reduxjs/toolkit', '@/*'), false);
    assert.equal(matchesAlias('@/mastodon/store', '@/*'), true);
  });

  test('an exact alias matches itself and its subpaths only', () => {
    assert.equal(matchesAlias('mastodon', 'mastodon'), true);
    assert.equal(matchesAlias('mastodon/actions', 'mastodon'), true);
    assert.equal(matchesAlias('mastodonx', 'mastodon'), false);
  });
});

describe('staticCSharp project visibility', () => {
  const { staticCSharp } = require('./framed.js');
  const roots = [];
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

  test('a same-named type in an unreferenced project is not a dependency', () => {
    const ext = 'namespace Microsoft.Extensions.Hosting;\npublic static partial class Extensions { }\n';
    const f = fixture({
      'Basket/Basket.csproj': '<Project><ItemGroup><ProjectReference Include="..\\Shared\\Shared.csproj" /></ItemGroup></Project>',
      'Basket/Extensions.cs': ext,
      'Basket/Program.cs': 'using Microsoft.Extensions.Hosting;\nvar b = Extensions.Add(); var s = new Helper();\n',
      'Catalog/Catalog.csproj': '<Project></Project>',
      'Catalog/Extensions.cs': ext,
      'Shared/Shared.csproj': '<Project></Project>',
      'Shared/Helper.cs': 'namespace Microsoft.Extensions.Hosting;\npublic class Helper { }\n',
    });
    roots.push(f.root);
    const edges = [];
    staticCSharp(f.root, f.files, (from, to) => edges.push(`${from} -> ${to}`));
    const fromProgram = edges.filter((e) => e.startsWith('Basket/Program.cs')).sort();
    assert.deepEqual(fromProgram, ['Basket/Program.cs -> Basket/Extensions.cs', 'Basket/Program.cs -> Shared/Helper.cs']);
  });
});

describe('numbered tickets ("#")', () => {
  const { branchHasTicket, detectPrefixes, detectBranchPattern, validate, DEFAULTS } = require('./framed.js');

  test('a branch segment starting with the number is a ticket; a version is not', () => {
    assert.equal(branchHasTicket('bugfix/1234-fix-login', ['#']), true);
    assert.equal(branchHasTicket('1234_fix', ['#']), true);
    assert.equal(branchHasTicket('release/2.0', ['#']), false);
    assert.equal(branchHasTicket('fix-login', ['#']), false);
    assert.equal(branchHasTicket('feature/APP-12-x', ['APP', '#']), true);
  });

  test('detection counts branch numbers and ticket links, not pull-request numbers', () => {
    const branches = ['bugfix/101-a', 'bugfix/102-b', 'bugfix/103-c', 'fix/104-d', 'bugfix/105-e', 'docs'];
    const subjects = ['Merge pull request #900 from me/x', 'Add thing (#901)', 'fixes #902', 'AB#903 tweak'];
    const d = detectPrefixes(branches, subjects);
    assert.deepEqual(d.prefixes, ['#']);
    assert.equal(d.evidence[0].tickets, 7);
    assert.equal(detectBranchPattern(branches, d.prefixes).evidence.withTicket, 5);
  });

  test('"#" is a valid ticketPrefixes entry', () => {
    assert.deepEqual(validate({ ...DEFAULTS, tests: [], ticketPrefixes: ['#'] }, {}).errors, []);
  });
});

describe('splitting large modules', () => {
  const { buildModules } = require('./framed.js');
  const many = (dir, n, ext = 'rb') => Array.from({ length: n }, (_, i) => `${dir}/f${i}.${ext}`);

  test('a one-project app is divided by subfolders; small folders stay in the parent', () => {
    const files = ['Gemfile', 'package.json', ...many('app/models', 200), ...many('app/controllers', 150), ...many('app/mailers', 5), ...many('lib', 10)];
    const r = buildModules(files);
    assert.equal(r.moduleOf.get('app/models/f0.rb'), 'app/models');
    assert.equal(r.moduleOf.get('app/controllers/f0.rb'), 'app/controllers');
    assert.equal(r.moduleOf.get('app/mailers/f0.rb'), '(root)');
    assert.equal(r.moduleOf.get('lib/f0.rb'), '(root)');
    assert.equal(r.projectOf.get('app/models/f0.rb'), '(root)');
  });

  test('a wrapper folder holding all the code is stepped through', () => {
    const files = ['web/package.json', ...many('web/src/orders', 200, 'ts'), ...many('web/src/billing', 150, 'ts')];
    const r = buildModules(files);
    assert.equal(r.moduleOf.get('web/src/orders/f0.ts'), 'web/src/orders');
    assert.equal([...r.modules.keys()].includes('web/src'), false);
  });

  test('a module under the limit is left whole', () => {
    const r = buildModules(['api/Api.csproj', ...many('api/Orders', 100, 'cs'), ...many('api/Billing', 100, 'cs')]);
    assert.deepEqual([...r.modules.keys()], ['Api']);
  });
});

describe('selectSuites ignores framed files', () => {
  const { selectSuites } = require('./framed.js');
  test('a config change alongside a project change runs only that project', () => {
    const tests = [{ path: 'web', command: 'npm test' }, { path: 'api', command: 'dotnet test' }];
    const scan = { files: [{ path: 'web/a.ts', module: 'web' }], modules: [{ name: 'web', path: 'web' }], moduleEdges: [] };
    const picked = selectSuites(tests, ['web/a.ts', '.framed/config.json'], scan);
    assert.deepEqual(picked.map((t) => t.path), ['web']);
  });
});

describe('the page: road and tokens (§19)', () => {
  const { parseWorkingBody, buildRoad, parseStepCommits, tokensByStop } = require('./framed.js');
  const file = [
    '---', 'ticket: APP-1', 'branch: APP-1-x', 'status: in-progress', 'step: suite', '---',
    '<!-- template comment -->', '## Plan', '1. Change it.', '',
    '## Steps', '| step | status | commit | note |', '|------|--------|--------|------|',
    '| find | done | a1 | bug is in the page |',
    '| blame | blocked | | waiting at the gate. Nothing protected. |',
    '| blame | done | b2 | gate: yes |',
    '| test | done | c3 | 1 failing for the bug |',
    '| fix | done | d4 | two files |',
    '| suite | failed | e5 | a list test now fails |',
    '| fix | done | f6 | kept the list |',
    '| suite | running | | |',
    '| pr | todo | | |',
  ].join('\n');

  test('reads sections and step rows, without template comments', () => {
    const { sections, steps } = parseWorkingBody(file);
    assert.equal(sections.Plan, '1. Change it.');
    assert.equal(steps.length, 9);
    assert.deepEqual(steps[0], { step: 'find', status: 'done', commit: 'a1', note: 'bug is in the page' });
  });

  test('the gate is its own stop, and a step that ran twice says so', () => {
    const road = buildRoad(parseWorkingBody(file).steps, 'in-progress');
    const by = Object.fromEntries(road.map((s) => [s.key, s]));
    assert.equal(by.blame.status, 'done');
    assert.equal(by.blame.note, 'Nothing protected.');
    assert.equal(by.gate.status, 'done');
    assert.equal(by.fix.runs, 2);
    assert.equal(by.suite.status, 'running');
    assert.equal(by.pr.status, 'todo');
  });

  test('a task waiting at the gate, and a hard stop', () => {
    const waiting = buildRoad([{ step: 'find', status: 'done', note: '' }, { step: 'blame', status: 'blocked', note: 'waiting at the gate.' }], 'blocked');
    assert.equal(waiting.find((s) => s.key === 'gate').status, 'waiting');
    const stopped = buildRoad([{ step: 'fix', status: 'blocked', note: 'the bug test cannot pass' }], 'blocked');
    assert.equal(stopped.find((s) => s.key === 'fix').status, 'stopped');
  });

  test('step commits: numbered tickets and the gate commit', () => {
    const log = ['2026-11-02T10:00:00+05:30\t#1234 [find] where it is', '2026-11-02T10:05:00+05:30\t#1234 [blame] gate: yes',
      '2026-11-02T10:06:00+05:30\tunrelated commit'].join('\n');
    assert.deepEqual(parseStepCommits(log, '1234').map((c) => c.stop), ['find', 'gate']);
  });

  test('tokens go to the step whose commit comes next; duplicates and other branches are skipped', () => {
    const commits = [{ stop: 'find', time: 1000_000 }, { stop: 'gate', time: 2000_000 }];
    const r = (key, time, branch = 'APP-1-x') => ({ key, time, branch, fresh: 10, cached: 100 });
    const t = tokensByStop([r('a', 500_000), r('a', 500_000), r('b', 1500_000), r('c', 2500_000), r('d', 600_000, 'main')], 'APP-1-x', commits, 'test');
    assert.deepEqual(t.byStop.find, { fresh: 10, cached: 100, replies: 1 });
    assert.equal(t.byStop.gate.replies, 1);
    assert.equal(t.byStop.test.replies, 1); // after the last commit: the step still running
    assert.equal(t.total.replies, 3);
  });
});

describe('the page: map (§19)', () => {
  const { parseMapMd, blastModules } = require('./framed.js');
  const md = [
    '# Map: x', '', '## What this is', 'A shop.', '',
    '## Modules', '| module | what it does | languages | source files |', '|---|---|---|---|',
    '| Api | web API | C# | 50 |', '| web | the site | TypeScript | 80 |', '',
    '## How they connect', '| from | to | source | strength |', '|---|---|---|---|',
    '| Api | Shared | static, co-change | 40 + 3 |', '| web | Api | co-change | 7 |', '',
    'Surprising: web and Api never import each other.',
  ].join('\n');

  test('modules, links with summed strength, and modules only named in links', () => {
    const m = parseMapMd(md);
    assert.equal(m.what, 'A shop.');
    assert.deepEqual(m.modules.map((x) => x.name), ['Api', 'web', 'Shared']);
    assert.equal(m.modules[2].other, true);
    assert.deepEqual(m.links[0], { from: 'Api', to: 'Shared', sources: ['static', 'co-change'], strength: 43 });
    assert.match(m.surprising, /^Surprising: web/);
  });

  test('touched modules come from touches and the branch changes; reached from the dependents', () => {
    const moduleOf = new Map([['api/Orders.cs', 'Api'], ['web/src/a.ts', 'web'], ['lib/x.ts', 'Shared']]);
    const sections = { 'Blast radius': '- touches: api/Orders.cs\n- dependents from map:\n  - web/src/a.ts (co-change): no change. Why.\n  - api/Orders.cs (static): updated.' };
    assert.deepEqual(blastModules(sections, ['lib/x.ts'], moduleOf), { touched: ['Api', 'Shared'], reached: ['web'] });
    assert.deepEqual(blastModules(sections, [], null), { touched: [], reached: [] });
  });
});

describe('the page: blast radius files (§19)', () => {
  const { parseBlastRadius } = require('./framed.js');
  test('touches, and each dependent with its source and reason', () => {
    const r = parseBlastRadius({ 'Blast radius': [
      '- touches: web/src/a.ts, api/Orders.cs',
      '- No touched file is a hub.',
      '- dependents from map:',
      '  - a.ts dependents:',
      '    - web/src/App.tsx (static): no change. Only routes to the page.',
      '    - api/.../Orders.cs (co-change): no change. Abbreviated, not matched.',
    ].join('\n') });
    assert.deepEqual(r.touches, ['web/src/a.ts', 'api/Orders.cs']);
    assert.deepEqual(r.dependents[0], { path: 'web/src/App.tsx', source: 'static', note: 'no change. Only routes to the page.' });
  });
});

describe('Studio: design choices (§19)', () => {
  const { validateStyle, saveChoice } = require('./framed.js');
  const styles = require('../templates/styles.json').styles;

  test('every named style is a valid set of tokens', () => {
    for (const s of styles) assert.deepEqual(validateStyle(s), [], s.id);
  });

  test('a broken style is refused with reasons, and nothing like CSS can sneak into a font', () => {
    const bad = { ...styles[0], radius: 99, fonts: { heading: 'Inter;}body{x', body: 'Inter' }, light: { ...styles[0].light, accent: 'red' } };
    const errors = validateStyle(bad);
    assert.ok(errors.some((e) => e.startsWith('radius')));
    assert.ok(errors.some((e) => e.startsWith('fonts')));
    assert.ok(errors.some((e) => e.startsWith('light.accent')));
  });

  test('saving writes the choice under .framed/design, and refuses an invalid one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-studio-'));
    try {
      assert.equal(saveChoice(root, JSON.stringify({ style: { id: 'x' } })).status, 400);
      assert.equal(fs.existsSync(path.join(root, '.framed', 'design', 'choice.json')), false);
      const r = saveChoice(root, JSON.stringify({ style: styles[1], preview: 'dark' }));
      assert.equal(r.status, 200);
      const saved = JSON.parse(fs.readFileSync(path.join(root, '.framed', 'design', 'choice.json'), 'utf8'));
      assert.equal(saved.style.id, 'editorial');
      assert.equal(saved.preview, 'dark');
      assert.equal(saved.mode, 'greenfield'); // not a git repo, no code: a new project
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('a saved choice leaves the working tree clean, so a restyle can start', () => {
    const { execFileSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-studio-'));
    try {
      const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' });
      git('init', '-q');
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"tailwindcss":"4"}}');
      fs.writeFileSync(path.join(root, 'src', 'index.css'), ':root { --background: #ffffff; --foreground: #111111; --primary: #2255ee; }\n');
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      const r = saveChoice(root, JSON.stringify({ style: styles[1], target: '.' }));
      assert.equal(r.status, 200, JSON.stringify(r.out));
      assert.equal(git('status', '--porcelain'), '');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Studio: reading the current look (§19)', () => {
  const { parseColor, parseCssVars, slotsFrom, detectDesign, currentStyle } = require('./framed.js');
  const { execFileSync } = require('node:child_process');

  test('colours in every notation a theme uses', () => {
    assert.equal(parseColor('#25e'), '#2255ee');
    assert.equal(parseColor('rgb(37, 99, 235)'), '#2563eb');
    assert.equal(parseColor('222.2 47.4% 11.2%'), '#0f172a'); // shadcn v3, bare hsl
    assert.equal(parseColor('oklch(0.145 0 0)'), '#0a0a0a'); // shadcn v4
    assert.equal(parseColor('oklch(0.577 0.245 27.325)'), '#e7000b');
    assert.equal(parseColor('var(--x)'), null);
  });

  test('dark blocks, @media dark, and see-through colours', () => {
    const css = ':root { --background: #ffffff; --primary: #2563eb; --border: #e5e5e5 }\n'
      + '.dark { --background: oklch(0.145 0 0); --border: oklch(1 0 0 / 10%) }\n'
      + '@media (prefers-color-scheme: dark) { :root { --foreground: #fafafa } }\n'
      + 'body { font-family: "Fraunces", serif }';
    const r = parseCssVars(css);
    assert.equal(r.light.primary, '#2563eb');
    assert.equal(r.dark.foreground, '#fafafa');
    assert.deepEqual(r.fonts, ['"Fraunces", serif']);
    const dark = slotsFrom({ ...r.light, ...r.dark });
    assert.equal(dark.line, '#232323'); // white at 10% on #0a0a0a, not solid white
  });

  test('per app, following an import of a shared package; too little to call a look is skipped', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-look-'));
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    try {
      write('ui/package.json', '{"name":"@acme/ui","dependencies":{"@radix-ui/react-slot":"1"}}');
      write('ui/src/styles.css', ':root { --background: #ffffff; --foreground: #111111; --primary: #171717; --border: #e5e5e5; --radius: 0.5rem }');
      write('web/package.json', '{"name":"web","dependencies":{"tailwindcss":"4"}}');
      write('web/src/index.css', '@import "tailwindcss";\n@import "@acme/ui/styles.css";\n:root { --primary: #2563eb; --primary-foreground: #ffffff }');
      write('login/package.json', '{"name":"login"}');
      write('login/src/main.css', ':root { --success: #10b981; --danger: #ef4444; --warning: #f59e0b }');
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      const { apps } = detectDesign(root);
      const web = apps.find((a) => a.dir === 'web');
      assert.equal(web.light.accent, '#2563eb'); // its own blue over the shared base
      assert.equal(web.light.ink, '#111111'); // from the shared package
      assert.deepEqual(web.files, ['ui/src/styles.css', 'web/src/index.css']);
      assert.deepEqual(web.libraries, ['Tailwind']);
      const base = require('../templates/styles.json').styles[0];
      const card = currentStyle(web, base);
      assert.equal(card.app, 'web');
      assert.match(card.vibe, /filled in: .*font/);
      assert.equal(currentStyle(apps.find((a) => a.dir === 'login'), base), null); // no main colour
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Studio: building the design (§19)', () => {
  const { designCss, hardcodedColours, guardCommand } = require('./framed.js');
  const { execFileSync } = require('node:child_process');
  const calm = require('../templates/styles.json').styles[0];

  test('the tokens as shadcn variables, light and dark, with radius and fonts', () => {
    const css = designCss(calm, 'shadcn');
    assert.match(css, /:root \{\n {2}--radius: 0\.75rem;/);
    assert.match(css, /--font-sans: "Inter", system-ui, sans-serif;/);
    assert.match(css, /--primary: #3b6fe0;/);
    assert.match(css, /--muted-foreground: #5f6778;/);
    assert.match(css, /\.dark \{[\s\S]*--background: #12151c;/);
    assert.match(designCss(calm, 'generic'), /--accent-ink: #ffffff;/);
  });

  test('fixed colours in components are counted; theme files and tests are not', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-hard-'));
    const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    try {
      write('web/src/index.css', ':root { --primary: #2563eb }');
      write('web/src/Button.tsx', 'export const B = () => <button className="bg-blue-600 text-white hover:bg-blue-700" style={{ color: "#ff0000" }} />;');
      write('web/src/Card.tsx', 'export const C = () => <div className="bg-card text-foreground" />;');
      write('web/src/Button.test.tsx', 'expect("bg-red-500")');
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      const r = hardcodedColours(root, 'web', ['web/src/index.css']);
      assert.deepEqual(r.top, [{ file: 'web/src/Button.tsx', uses: 3 }]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('framed-design is allowed without a ticket, like framed-init', () => {
    const ctx = { branch: 'framed-design', defaultBranches: ['main'], ticketPrefixes: ['APP'], branchPattern: '{ticket}-{slug}' };
    assert.equal(guardCommand('git commit -m x', ctx), null);
    assert.equal(guardCommand('git checkout -b framed-design', { ...ctx, branch: 'main' }), null);
  });
});

describe('Studio: type sizes, heading colour, the scout prompt (§19)', () => {
  const { validateStyle, designCss, typeSizes, scoutPrompt } = require('./framed.js');
  const calm = require('../templates/styles.json').styles[0];

  test('type and heading colour are optional, and checked when given', () => {
    assert.deepEqual(validateStyle({ ...calm, type: { base: 17, scale: 1.333 }, light: { ...calm.light, heading: '#123456' } }), []);
    assert.ok(validateStyle({ ...calm, type: { base: 30, scale: 1.25 } }).some((e) => e.startsWith('type')));
    assert.ok(validateStyle({ ...calm, dark: { ...calm.dark, heading: 'blue' } }).some((e) => e.startsWith('dark.heading')));
  });

  test('sizes from the base and scale, and in the CSS', () => {
    assert.deepEqual(typeSizes({ type: { base: 16, scale: 1.25 } }), { sm: 12.8, base: 16, lg: 20, xl: 25, '2xl': 31.3 });
    const css = designCss({ ...calm, type: { base: 18, scale: 1.2 }, light: { ...calm.light, heading: '#123456' } }, 'shadcn');
    assert.match(css, /--text-base: 1\.125rem;/);
    assert.match(css, /--heading: #123456;/);
    assert.match(designCss(calm, 'generic'), /--heading: #1b2030;/); // defaults to the text colour
  });

  test('spacing is a named stop or a scale between, motion is optional milliseconds', () => {
    assert.deepEqual(validateStyle({ ...calm, density: 1.15, motion: 300 }), []);
    assert.deepEqual(validateStyle({ ...calm, motion: undefined }), []);
    assert.ok(validateStyle({ ...calm, density: 2 }).some((e) => e.startsWith('density')));
    assert.ok(validateStyle({ ...calm, density: 'toString' }).some((e) => e.startsWith('density')));
    assert.ok(validateStyle({ ...calm, motion: 1000 }).some((e) => e.startsWith('motion')));
    assert.ok(validateStyle({ ...calm, motion: '200ms' }).some((e) => e.startsWith('motion')));
  });

  test('spacing and motion in the CSS, and motion stops for reduced-motion users', () => {
    const css = designCss({ ...calm, density: 'compact', motion: 300 }, 'generic');
    assert.match(css, /--spacing: 0\.175rem;/);
    assert.match(css, /--duration: 300ms;/);
    assert.match(css, /--ease: cubic-bezier\(0\.34, 1\.4, 0\.64, 1\);/); // lively springs
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n {2}:root \{\n {4}--duration: 0ms;/);
    const plain = designCss({ ...calm, density: 1.15, motion: undefined }, 'shadcn');
    assert.match(plain, /--spacing: 0\.2875rem;/);
    assert.match(plain, /--duration: 150ms;/); // the default
    assert.match(plain, /--ease: cubic-bezier\(0\.2, 0, 0, 1\);/);
  });

  test('the scout prompt carries the instructions, the brief and the current look, and says there is no shell', () => {
    const p = scoutPrompt('C:/repo', 'warmer, for a bakery', [{ dir: 'web', libraries: ['Tailwind'], font: null, radius: 8, light: { accent: '#2563eb' }, dark: null }]);
    assert.match(p, /You find new looks for an app/);
    assert.match(p, /Brief: warmer, for a bakery/);
    assert.doesNotMatch(p, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.match(p, /cannot run commands/);
    assert.match(p, /"app":"web".*"accent":"#2563eb"/);
  });

  test('hard-to-read text is caught in either mode', () => {
    const { contrastIssues } = require('./framed.js');
    assert.deepEqual(contrastIssues(calm), []);
    assert.deepEqual(contrastIssues({ ...calm, dark: { ...calm.dark, muted: '#2a2f3a' } }), ['dark quiet text 1.2:1']);
  });
});

describe('tests by coverage (§10)', () => {
  const { coveredPaths, repoPathOf, selectByCoverage, UNTRUSTED_CHANGE, validate, DEFAULTS } = require('./framed.js');

  test('lcov: files with at least one hit line; cobertura: classes with a hit, with their source roots', () => {
    const lcov = 'SF:/repo/src/Price.ts\nDA:1,0\nDA:2,3\nend_of_record\nSF:/repo/src/Unused.ts\nDA:1,0\nLH:0\nend_of_record\n';
    assert.deepEqual(coveredPaths(lcov), [['/repo/src/Price.ts', []]]);
    const xml = '<?xml version="1.0"?><coverage><sources><source>C:\\repo\\Api\\</source></sources><packages><package><classes>'
      + '<class name="Price" filename="Services\\PriceCalculator.cs"><lines><line number="3" hits="2"/></lines></class>'
      + '<class name="Cold" filename="Services\\Cold.cs"><lines><line number="3" hits="0"/></lines></class></classes></package></packages></coverage>';
    assert.deepEqual(coveredPaths(xml), [['Services\\PriceCalculator.cs', ['C:\\repo\\Api\\']]]);
  });

  test('coverage paths become repo paths: absolute, under a source root, or a unique tail', () => {
    const tracked = new Set(['Api/Services/PriceCalculator.cs', 'web/src/price.ts', 'a/x.ts', 'b/x.ts']);
    const lower = new Map([...tracked].map((f) => [f.toLowerCase(), f]));
    assert.equal(repoPathOf('C:\\repo\\web\\src\\price.ts', [], 'C:/repo', tracked, lower), 'web/src/price.ts');
    assert.equal(repoPathOf('Services\\PriceCalculator.cs', ['C:\\repo\\Api\\'], 'C:/repo', tracked, lower), 'Api/Services/PriceCalculator.cs');
    assert.equal(repoPathOf('src/price.ts', [], 'C:/elsewhere', tracked, lower), 'web/src/price.ts');
    assert.equal(repoPathOf('x.ts', [], 'C:/elsewhere', tracked, lower), null); // two files end with it: not a guess
  });

  const tests = ['test/PriceTests.cs', 'test/InvoiceTests.cs', 'test/CustomerTests.cs', 'test/NewTests.cs'];
  const map = { entries: {
    'test/PriceTests.cs': { files: ['src/Price.cs'], commit: 'c1' },
    'test/InvoiceTests.cs': { files: ['src/Invoice.cs'], commit: 'c1' },
    'test/CustomerTests.cs': { files: ['src/Customer.cs'], commit: 'c1' },
  } };

  test('a change runs the tests that run it, tests with no record, and skips the rest', () => {
    const r = selectByCoverage({ map, tests, changed: ['src/Price.cs'], changedSince: () => [] });
    assert.equal(r.mode, 'selected');
    assert.deepEqual(r.run.map((x) => x.test).sort(), ['test/NewTests.cs', 'test/PriceTests.cs']);
  });

  test('the stale entry: Invoice.cs changed since InvoiceTests was recorded, so it reruns and is re-recorded', () => {
    // someone (not framed) changed Invoice.cs to call Price.cs; the map still says InvoiceTests only runs Invoice.cs
    const r = selectByCoverage({ map, tests, changed: ['src/Price.cs'], changedSince: () => ['src/Invoice.cs'] });
    const inv = r.run.find((x) => x.test === 'test/InvoiceTests.cs');
    assert.ok(inv, 'InvoiceTests runs');
    assert.equal(inv.refresh, true);
    assert.match(inv.why, /Invoice\.cs changed since/);
    assert.equal(r.run.find((x) => x.test === 'test/CustomerTests.cs'), undefined); // still unrelated
  });

  test('settings, data, dependencies and startup run everything', () => {
    for (const f of ['Api/appsettings.Development.json', 'db/migrations/0042_add.sql', 'web/package.json', 'Api/Program.cs', 'spec/rails_helper.rb', 'Api/Api.csproj']) {
      assert.ok(UNTRUSTED_CHANGE.test(f), f);
      assert.equal(selectByCoverage({ map, tests, changed: ['src/Price.cs', f], changedSince: () => [] }).mode, 'full', f);
    }
    assert.equal(UNTRUSTED_CHANGE.test('src/Price.cs'), false);
    assert.equal(selectByCoverage({ map: { entries: {} }, tests, changed: ['src/Price.cs'], changedSince: () => [] }).mode, 'full'); // no map yet
  });

  test('testSelection is opt-in and only "coverage"', () => {
    const base = { ...DEFAULTS, tests: [], ticketPrefixes: ['APP'] };
    assert.deepEqual(validate({ ...base, testSelection: 'coverage' }, { testSelection: 'coverage' }).errors, []);
    assert.equal(validate({ ...base, testSelection: 'magic' }, { testSelection: 'magic' }).errors.length, 1);
  });
});

describe('found on 21 public repos (2026-11-03)', () => {
  const { resolveTsFile, staticTs, COCHANGE_NOISE, detectTests, TEST_FILE_RE } = require('./framed.js');
  const roots = [];
  const make = (files) => { const f = fixture(files); roots.push(f.root); return f; };
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
  const edgesOf = (f) => { const out = []; staticTs(f.root, f.files, new Set(f.files), (a, b) => out.push(`${a} -> ${b}`)); return out.sort(); };

  test('ESM imports name the compiled file: "./x.js" is x.ts', () => {
    const set = new Set(['src/a.ts', 'src/b.tsx', 'src/c.mts']);
    assert.equal(resolveTsFile(set, 'src/a.js'), 'src/a.ts');
    assert.equal(resolveTsFile(set, 'src/b.jsx'), 'src/b.tsx');
    assert.equal(resolveTsFile(set, 'src/c.mjs'), 'src/c.mts');
  });

  test('a monorepo: workspace packages by name and subpath, aliases without "*", Node subpath imports', () => {
    const f = make({
      'packages/lib/package.json': '{"name":"@acme/lib","exports":{"./utils/*":"./src/utils/*.ts"}}',
      'packages/lib/src/index.ts': 'export const x = 1;',
      'packages/lib/src/utils/date.ts': 'export const d = 1;',
      'packages/lib/server-only/audit.ts': 'export const a = 1;',
      'apps/web/package.json': '{"name":"web","imports":{"#lib/*":"./src/lib/*"}}',
      'apps/web/tsconfig.json': '{"compilerOptions":{"paths":{"@acme/lib":["../../packages/lib"]}}}',
      'apps/web/src/lib/util.ts': 'export const u = 1;',
      'apps/web/src/page.ts': "import { x } from '@acme/lib';\nimport { d } from '@acme/lib/utils/date';\nimport { a } from '@acme/lib/server-only/audit';\nimport { u } from '#lib/util.ts';",
    });
    assert.deepEqual(edgesOf(f), [
      'apps/web/src/page.ts -> apps/web/src/lib/util.ts',
      'apps/web/src/page.ts -> packages/lib/server-only/audit.ts',
      'apps/web/src/page.ts -> packages/lib/src/index.ts',
      'apps/web/src/page.ts -> packages/lib/src/utils/date.ts',
    ]);
  });

  test('co-change leaves out files that change with everything', () => {
    for (const f of ['package-lock.json', 'CHANGES.rst', 'docs/guide.md', 'web/src/locales/en/translation.json', 'lang/fr.json',
      'src/__snapshots__/a.test.ts.snap', 'api/openapi.yaml', 'Directory.Packages.props', 'Api/Api.csproj', 'web/package.json', 'Cargo.lock']) {
      assert.ok(COCHANGE_NOISE.test(f), f);
    }
    for (const f of ['src/flask/app.py', 'web/src/price.ts', 'Api/Program.cs', 'config/settings.yml']) assert.equal(COCHANGE_NOISE.test(f), false, f);
  });

  test('test-file names across languages, without env files', () => {
    for (const f of ['OwnerTests.java', 'NewsRepositoryTest.kt', 'widget_test.dart', 'x_test.py', 'a.test.ts', 'foo.test.exs']) assert.ok(TEST_FILE_RE.test(f), f);
    for (const f of ['.env.test.example', 'a.spec.example', 'src/Test.cs.bak']) assert.equal(TEST_FILE_RE.test(f), false, f);
  });

  test('suites that need a running app or a database are skipped, wherever they live', () => {
    const f = make({
      'frontend/package.json': '{"scripts":{"test":"playwright test"}}', 'frontend/tests/login.spec.ts': '',
      'api/package.json': '{"scripts":{"test":"php artisan migrate:fresh && phpunit"}}',
      'lib/package.json': '{"scripts":{"test":"vitest run"}}', 'lib/a.test.ts': '',
      'package.json': '{"scripts":{"test":"bun run --filter lib test"}}',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests.map((t) => `${t.path}: ${t.command}`), ['lib: npm test']); // the root only forwarded to lib
    assert.deepEqual(r.skipped.map((t) => t.path).sort(), ['api', 'frontend']);
  });

  test('a .NET solution with a browser-test project is split into its unit projects', () => {
    const f = make({
      'App.slnx': '<Solution><Project Path="tests/Unit/Unit.csproj" /><Project Path="tests/Web.AcceptanceTests/Web.AcceptanceTests.csproj" /></Solution>',
      'tests/Unit/Unit.csproj': '<PackageReference Include="xunit" />', 'tests/Unit/PriceTests.cs': '',
      'tests/Web.AcceptanceTests/Web.AcceptanceTests.csproj': '<PackageReference Include="Microsoft.NET.Test.Sdk" /><PackageReference Include="Microsoft.Playwright" />',
      'tests/Web.AcceptanceTests/LoginTests.cs': '',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests.map((t) => `${t.path}: ${t.command}`), ['tests/Unit: dotnet test']);
    assert.deepEqual(r.skipped.map((t) => t.path), ['tests/Web.AcceptanceTests']);
  });

  test('one runner per JVM project; a Flutter app uses flutter test, not its android shell', () => {
    const f = make({
      'pom.xml': '<project/>', 'build.gradle': '', 'src/test/java/OwnerTests.java': '',
      'mobile/pubspec.yaml': 'name: app\nflutter:\n  uses-material-design: true', 'mobile/android/build.gradle': '', 'mobile/test/widget_test.dart': '',
    });
    const r = detectTests(f.root, f.files);
    assert.deepEqual(r.tests.map((t) => `${t.path}: ${t.command}`).sort(), ['.: mvn -q test', 'mobile: flutter test']);
  });
});

describe('the page opens by itself; the status line (§19, §17)', () => {
  const { statusLineText } = require('./framed.js');
  const { spawnSync } = require('node:child_process');
  const script = path.join(__dirname, 'framed.js');
  const run = (args, env, input) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, input, encoding: 'utf8' });

  test('one short line: the task step, context left, plan usage', () => {
    const input = { context_window: { used_percentage: 37 }, rate_limits: { five_hour: { used_percentage: 22.4 }, seven_day: { used_percentage: 41 } } };
    assert.equal(statusLineText(input, { state: 'task', task: { ticket: 'APP-1', step: 'fix', status: 'in-progress' } }), 'framed · APP-1 fix 5/7 · context 63% left · 5h 22% · week 41%');
    assert.equal(statusLineText({}, { state: 'task', task: { ticket: 'APP-1', step: 'blame', status: 'blocked' } }), 'framed · APP-1 waiting for you');
    assert.equal(statusLineText({}, { state: 'ready' }), 'framed · ready');
  });

  test('install keeps the other settings, never replaces someone else\'s status line, uninstall removes only framed\'s', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-claude-'));
    try {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }));
      assert.equal(run(['statusline', 'install'], { CLAUDE_CONFIG_DIR: dir }).status, 0);
      let s = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(s.theme, 'dark');
      assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
      assert.match(s.statusLine.command, /framed\.js" statusline$/);
      assert.equal(run(['statusline', 'uninstall'], { CLAUDE_CONFIG_DIR: dir }).status, 0);
      s = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(s.statusLine, undefined);
      assert.equal(s.theme, 'dark');
      fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-line.sh' } }));
      assert.equal(run(['statusline', 'install'], { CLAUDE_CONFIG_DIR: dir }).status, 1);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'my-own-line.sh');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('off is the person\'s choice, kept outside the repo; "page open" then does nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-home-'));
    try {
      assert.equal(run(['page', 'off'], { FRAMED_HOME: home }).status, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).page, 'off');
      const r = run(['page', 'open', '--root', os.tmpdir()], { FRAMED_HOME: home, FRAMED_NO_BROWSER: '1' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(fs.existsSync(path.join(home, 'pages.json')), true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test('on Windows the browser command reaches cmd as written, with the empty title intact', { skip: process.platform !== 'win32' }, () => {
    const { browserCommand } = require('./framed.js');
    const [cmd, args, opts] = browserCommand('http://127.0.0.1:4647/#/build');
    const seen = spawnSync(cmd, args.map((a) => (a === 'start' ? 'echo' : a)), { ...opts, encoding: 'utf8', windowsHide: true });
    assert.equal(seen.stdout.trim(), '"" "http://127.0.0.1:4647/#/build"');
  });

  test('a page nobody has open stops by itself, so it doesn\'t hold a port', async () => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [script, 'ui', '--root', os.tmpdir(), '--port', '0', '--idle-ms', '300'], { stdio: 'ignore' });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve('still running'); }, 8000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.equal(code, 0);
  });

  test('the status line never fails, even with no input', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'framed-home-'));
    try {
      const r = run(['statusline'], { FRAMED_HOME: home }, 'not json');
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^framed/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

describe('imports for Python, Go, Java/Kotlin, PHP and Ruby', () => {
  const { staticPython, staticGo, staticJvm, staticPhp, staticRuby } = require('./framed.js');
  const roots = [];
  const make = (files) => { const f = fixture(files); roots.push(f.root); return f; };
  after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
  const edges = (fn, f) => { const out = []; fn(f.root, f.files, (a, b) => out.push(`${a} -> ${b}`)); return [...new Set(out)].sort(); };

  test('Python: absolute, from-import of a submodule, relative, under a src layout', () => {
    const f = make({
      'src/shop/__init__.py': '', 'src/shop/price.py': 'def price(): pass', 'src/shop/tax.py': '',
      'src/shop/invoice.py': 'from .price import price\nfrom . import tax\nimport os',
      'tests/test_invoice.py': 'from shop.invoice import total\nimport shop.price as p',
    });
    assert.deepEqual(edges(staticPython, f), [
      'src/shop/invoice.py -> src/shop/price.py', 'src/shop/invoice.py -> src/shop/tax.py',
      'tests/test_invoice.py -> src/shop/invoice.py', 'tests/test_invoice.py -> src/shop/price.py',
    ]);
  });

  test('Go: an import of a package under the module path links to its files, not its tests', () => {
    const f = make({
      'go.mod': 'module example.com/shop\n', 'price/price.go': 'package price', 'price/price_test.go': 'package price',
      'cmd/main.go': 'package main\nimport (\n  "fmt"\n  p "example.com/shop/price"\n)',
    });
    assert.deepEqual(edges(staticGo, f), ['cmd/main.go -> price/price.go']);
  });

  test('Java and Kotlin: imports, a wildcard, and a class of the same package used without an import', () => {
    const f = make({
      'src/main/java/shop/Price.java': 'package shop;\npublic class Price {}',
      'src/main/java/shop/Invoice.java': 'package shop;\nclass Invoice { Price p; }',
      'src/main/java/web/Api.java': 'package web;\nimport shop.Invoice;\nimport shop.*;',
      'src/main/kotlin/web/Page.kt': 'package web\nimport shop.Price\nclass Page',
    });
    assert.deepEqual(edges(staticJvm, f), [
      'src/main/java/shop/Invoice.java -> src/main/java/shop/Price.java',
      'src/main/java/web/Api.java -> src/main/java/shop/Invoice.java',
      'src/main/java/web/Api.java -> src/main/java/shop/Price.java',
      'src/main/kotlin/web/Page.kt -> src/main/java/shop/Price.java',
    ]);
  });

  test('PHP: use statements through composer PSR-4', () => {
    const f = make({
      'composer.json': '{"autoload":{"psr-4":{"App\\\\":"app/"}}}',
      'app/Models/Song.php': '<?php\nnamespace App\\Models;\nclass Song {}',
      'app/Http/SongController.php': '<?php\nnamespace App\\Http;\nuse App\\Models\\Song;',
    });
    assert.deepEqual(edges(staticPhp, f), ['app/Http/SongController.php -> app/Models/Song.php']);
  });

  test('Rails: constants to autoloaded files, namespaced and from specs', () => {
    const f = make({
      'app/models/account.rb': 'class Account; end',
      'app/controllers/admin/users_controller.rb': 'module Admin; class UsersController; def x; Account.first; end; end; end',
      'app/controllers/api/v1/things_controller.rb': 'class Api::V1::ThingsController; end',
      'spec/requests/admin_spec.rb': 'RSpec.describe Admin::UsersController do; API::V1::ThingsController; end',
    });
    assert.deepEqual(edges(staticRuby, f), [
      'app/controllers/admin/users_controller.rb -> app/models/account.rb',
      'spec/requests/admin_spec.rb -> app/controllers/admin/users_controller.rb',
      'spec/requests/admin_spec.rb -> app/controllers/api/v1/things_controller.rb',
    ]);
  });
});
