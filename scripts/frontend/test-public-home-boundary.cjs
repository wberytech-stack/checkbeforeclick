const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');

const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const deps = createRequire(path.join(root, 'package.json'));
const ts = deps('typescript');
const proxySource = fs.readFileSync(path.join(root, 'proxy.ts'), 'utf8');
let calls = 0, user = null;
const moduleExports = {};
const compiled = ts.transpileModule(proxySource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
vm.runInNewContext(compiled, { exports: moduleExports, process: { env: {} }, require(name) {
  if (name === '@supabase/ssr') return { createServerClient() { calls++; return { auth: { async getUser() { return { data: { user } }; } } }; } };
  if (name === 'next/server') return { NextResponse: { next: () => ({ kind: 'next', cookies: { set() {} } }), redirect: url => ({ kind: 'redirect', url: url.href }) } };
  throw Error('Unexpected dependency ' + name);
} });
function request(urlPath) {
  const nextUrl = new URL(urlPath, 'https://checkbeforeclick.com');
  nextUrl.clone = () => new URL(nextUrl.href);
  return { nextUrl, cookies: { getAll: () => [], set() {} } };
}
(async () => {
  for (const state of [null, { id: 'fixture-user' }]) {
    user = state; calls = 0;
    const result = await moduleExports.proxy(request('/?campaign=fixture'));
    assert.equal(result.kind, 'next'); assert.equal(calls, 0);
  }
  user = null;
  for (const route of ['/dashboard', '/dashboard/item', '/scan/new', '/history', '/watchlist', '/settings']) {
    calls = 0;
    const result = await moduleExports.proxy(request(route));
    const url = new URL(result.url);
    assert.equal(result.kind, 'redirect'); assert.equal(url.pathname, '/login'); assert.equal(url.searchParams.get('next'), route); assert.equal(calls, 1);
  }
  for (const route of ['/dashboard-extra', '/login', '/register']) {
    calls = 0;
    assert.equal((await moduleExports.proxy(request(route))).kind, 'next'); assert.equal(calls, 1);
  }
  user = { id: 'fixture-user' };
  for (const route of ['/login', '/register']) assert.equal(new URL((await moduleExports.proxy(request(route))).url).pathname, '/dashboard');
  console.log('PASS public homepage skips auth; private route checks and signed-in login redirects remain intact (mocked, offline).');
})().catch(error => { console.error(error); process.exitCode = 1; });
