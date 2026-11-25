// Tests of restep-export against the reference server (ports 8895 and 8896).
// Usage, from restep/:  node tools/restep-export/test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, 'vendor/restep-server.mjs');
const CLI = join(here, 'restep-export.mjs');
const PORT = 8895, PORT_OAUTH = 8896, TOKEN = 'secreto-de-prueba';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; console.log(`  FAIL: ${msg}`); }
}

async function startServer(port, env = {}) {
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${port}/health`); return p; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  p.kill();
  throw new Error(`the reference server does not start on ${port}`);
}

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

// ── Mini-parser for .http (subset common to REST Client and JetBrains) ────────
function parseHttp(text, env) {
  const vars = { ...env };
  const reqs = [];
  text.split(/^###/m).forEach((block, idx) => {
    const lines = block.split('\n');
    const name = idx ? lines.shift().trim() : null;
    let i = 0;
    const take = () => lines[i++];
    // File variables and comments up to the request line.
    let reqLine = null;
    while (i < lines.length) {
      const l = take();
      if (!l.trim() || l.startsWith('#') || l.startsWith('//')) continue;
      const v = /^@([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(l);
      if (v) { vars[v[1]] = v[2].trim(); continue; }
      reqLine = l; break;
    }
    if (!reqLine) return;
    const m = /^(GET|POST|PATCH|PUT|DELETE|HEAD|QUERY)\s+(\S+)(\s+HTTP\/[\d.]+)?$/.exec(reqLine);
    if (!m) throw new Error(`invalid request line: ${reqLine}`);
    const headers = [];
    while (i < lines.length && lines[i].trim()) {
      const h = take(), c = h.indexOf(':');
      if (c < 1) throw new Error(`invalid header: ${h}`);
      headers.push([h.slice(0, c).trim(), h.slice(c + 1).trim()]);
    }
    const body = lines.slice(i).join('\n').trim();
    reqs.push({ name, method: m[1], url: m[2], headers, body: body || undefined, vars: { ...vars } });
  });
  const subst = (s, v) => s.replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    if (!(k in v)) throw new Error(`undefined variable: ${k}`);
    return v[k];
  });
  return reqs.map((r) => ({ ...r, url: subst(r.url, r.vars), headers: r.headers.map(([k, v]) => [k, subst(v, r.vars)]), body: r.body && subst(r.body, r.vars) }));
}

// Minimal .bru parser: top-level blocks "name {…}" or "name […]".
function parseBru(text) {
  const blocks = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z:-]+)\s*([{[])$/.exec(lines[i]);
    if (!m) { if (lines[i].trim()) throw new Error(`line outside a block: ${lines[i]}`); continue; }
    const close = m[2] === '{' ? '}' : ']';
    const body = [];
    for (i++; i < lines.length && lines[i] !== close; i++) body.push(lines[i]);
    if (lines[i] !== close) throw new Error(`block ${m[1]} not closed`);
    blocks[m[1]] = body;
  }
  const kv = (name) => Object.fromEntries((blocks[name] ?? []).map((l) => { const c = l.indexOf(':'); return [l.slice(0, c).trim(), l.slice(c + 1).trim()]; }));
  return { blocks, kv };
}

function checkPostman(file, { auth }) {
  const col = JSON.parse(readFileSync(file, 'utf8'));
  ok(col.info?.schema === 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', 'postman: info.schema v2.1');
  ok(typeof col.info?._postman_id === 'string' && typeof col.info?.name === 'string', 'postman: info with _postman_id and name');
  ok(col.variable.some((v) => v.key === 'base_url') && col.variable.some((v) => v.key === 'token'), 'postman: base_url and token variables');
  ok(Boolean(col.auth) === auth, `postman: auth ${auth ? 'present' : 'absent'}`);
  let n = 0;
  for (const folder of col.item) {
    ok(Array.isArray(folder.item) && folder.item.length > 0, `postman: folder ${folder.name} with requests`);
    for (const it of folder.item) {
      n++;
      const r = it.request;
      ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(r.method), `postman: method of ${it.name}`);
      ok(r.url.raw.startsWith('{{base_url}}/') && r.url.host[0] === '{{base_url}}', `postman: url of ${it.name}`);
      if (r.body) ok(JSON.parse(r.body.raw) !== undefined && r.body.options.raw.language === 'json', `postman: JSON body in ${it.name}`);
      if (r.url.query) ok(r.url.raw.includes('?'), `postman: query in raw of ${it.name}`);
    }
  }
  return { col, n };
}

function checkBruno(dir, { auth }) {
  const meta = JSON.parse(readFileSync(join(dir, 'bruno.json'), 'utf8'));
  ok(meta.type === 'collection' && meta.version === '1', 'bruno: bruno.json');
  const env = parseBru(readFileSync(join(dir, 'environments', 'local.bru'), 'utf8'));
  ok(env.kv('vars').base_url?.startsWith('http'), 'bruno: base_url in the environment');
  ok(env.blocks['vars:secret']?.map((l) => l.trim()).includes('token'), 'bruno: token as a secret');
  const files = walk(dir).filter((f) => f.endsWith('.bru') && !f.includes('environments') && !f.endsWith('folder.bru'));
  for (const f of files) {
    const b = parseBru(readFileSync(f, 'utf8'));
    const m = b.kv('meta');
    ok(m.name && m.type === 'http' && /^\d+$/.test(m.seq), `bruno: meta of ${f}`);
    const verb = ['get', 'post', 'patch', 'delete'].find((v) => b.blocks[v]);
    ok(verb, `bruno: method block in ${f}`);
    const v = b.kv(verb);
    ok(v.url?.startsWith('{{base_url}}/'), `bruno: url in ${f}`);
    ok(v.auth === (auth ? 'bearer' : 'none'), `bruno: auth in ${f}`);
    if (v.body === 'json') ok(JSON.parse(b.blocks['body:json'].join('\n')) !== undefined, `bruno: JSON body in ${f}`);
  }
  return files.length;
}

const unlistable = new Set(); // collections whose methods leave out GET (§4.3)
async function execHttpReads(dir, envOverride = {}) {
  const env = { ...JSON.parse(readFileSync(join(dir, 'http-client.env.json'), 'utf8')).local, ...envOverride };
  const vs = JSON.parse(readFileSync(join(dir, '.vscode', 'settings.json'), 'utf8'))['rest-client.environmentVariables'].local;
  ok(vs.base_url === env.base_url || envOverride.base_url, 'http: same base_url in JetBrains and VS Code');
  let reads = 0, total = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.http'))) {
    const reqs = parseHttp(readFileSync(join(dir, f), 'utf8'), env);
    total += reqs.length;
    for (const r of reqs) {
      if (r.method !== 'GET') { if (r.body) ok(JSON.parse(r.body) !== undefined, `http: JSON body in ${r.name}`); continue; }
      reads++;
      const res = await fetch(r.url, { headers: Object.fromEntries(r.headers) });
      const text = res.status >= 300 ? await res.text() : '';
      let p = null;
      try { p = JSON.parse(text); } catch { /* not JSON */ }
      // The sample value of a GET action's parameter is an example the API may reject (§11.1), and a
      // collection that cannot be listed (§4.3) gives no sample id for "Get".
      const sampleParam = r.name.startsWith('Action ') && res.status === 400 && p?.code === 'invalid_parameter' && new URL(r.url).searchParams.has(p.parameter);
      const unlisted = /^Get /.test(r.name) && res.status === 404 && unlistable.has(r.name.slice(4));
      ok((res.status >= 200 && res.status < 300) || sampleParam || unlisted, `http: ${r.name} (${r.url}) answers ${res.status}: ${text}`);
    }
  }
  return { reads, total };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'restep-export-'));
const servers = [];
try {
  servers.push(await startServer(PORT), await startServer(PORT_OAUTH, { RESTEP_TOKEN: TOKEN }));
  const disc = await (await fetch(`http://localhost:${PORT}/`)).json();
  const collections = Object.keys(disc.collections);
  for (const [n, c] of Object.entries(disc.collections)) if (Array.isArray(c.methods) && !c.methods.includes('GET')) unlistable.add(n);

  console.log('1. The three formats from the reference server URL');
  const out = join(tmp, 'todo');
  const r1 = await run([`http://localhost:${PORT}/`, '--out', out]);
  ok(r1.code === 0, `exits with 0 (exited ${r1.code}: ${r1.err})`);
  for (const f of ['http', 'bruno', 'postman']) ok(existsSync(join(out, f)), `folder ${f} exists`);
  for (const c of collections) ok(existsSync(join(out, 'http', `${c}.http`)), `http: ${c}.http`);
  const pm = checkPostman(walk(join(out, 'postman')).find((f) => f.endsWith('.postman_collection.json')), { auth: false });
  const nBru = checkBruno(join(out, 'bruno'), { auth: false });
  ok(nBru === pm.n, `bruno and postman have the same requests (${nBru} and ${pm.n})`);
  const books = pm.col.item.find((x) => x.name === 'books').item;
  const byName = (n) => books.find((x) => x.name === n)?.request;
  ok(byName('Create in books')?.header.some((h) => h.key === 'Idempotency-Key' && /^"[0-9a-f-]{36}"$/.test(h.value)), 'create carries Idempotency-Key as a Structured Fields string');
  ok(byName('Update books')?.header.some((h) => h.key === 'If-Match' && h.value === '{{books_etag}}'), 'update carries If-Match');
  ok(byName('Update books')?.header.some((h) => h.value === 'application/merge-patch+json'), 'update is a merge patch');
  ok(byName('Delete books')?.header.some((h) => h.key === 'If-Match'), 'delete carries If-Match');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key.startsWith('filter['))), 'there are filter examples');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key === 'sort')), 'there is a sort example');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key === 'fields')), 'there is a fields example');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key === 'count')), 'there is a count example');
  ok(books.find((x) => x.name === 'Get books')?.event?.[0].script.exec.join('\n').includes('books_etag'), 'get saves the ETag');
  // §5.9: the standalone resources of the discovery document (the shop, /shop) come out with their GET and PATCH.
  for (const s of Object.keys(disc.singletons ?? {})) ok(existsSync(join(out, 'http', `${s}.http`)), `http: singleton ${s}.http`);
  const shop = pm.col.item.find((x) => x.name === 'shop')?.item ?? [];
  ok(shop.some((x) => x.name === 'Get shop' && x.request.method === 'GET' && x.request.url.raw === '{{base_url}}/shop'), 'singleton: GET /shop');
  const shopPatch = shop.find((x) => x.name === 'Update shop')?.request;
  ok(shopPatch?.method === 'PATCH' && shopPatch.header.some((h) => h.key === 'If-Match' && h.value === '{{shop_etag}}'), 'singleton: PATCH with If-Match');
  // §3: every write with a body carries its Content-Type.
  ok(pm.col.item.flatMap((f) => f.item).every((x) => !x.request.body || x.request.header.some((h) => h.key === 'Content-Type')), 'every body with Content-Type');

  console.log('2. Read requests from the .http files against the server');
  const h = await execHttpReads(join(out, 'http'));
  ok(h.reads >= collections.length * 3, `reads are run (${h.reads} of ${h.total})`);

  console.log('3. The sample writes are acceptable: create and update with the ETag');
  // The server accepts the shop's sample PATCH with the ETag of its GET.
  const sg = await fetch(`http://localhost:${PORT}/shop`);
  const sp = await fetch(`http://localhost:${PORT}/shop`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': sg.headers.get('etag') }, body: shopPatch.body.raw });
  ok(sp.status === 200, `the server accepts the update shop body (${sp.status})`);
  await fetch(`http://localhost:${PORT}/shop`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(await sg.json()) });
  const createBody = JSON.parse(byName('Create in books').body.raw);
  const cr = await fetch(`http://localhost:${PORT}/books`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` }, body: JSON.stringify(createBody) });
  ok(cr.status === 201, `the server accepts the books create body (${cr.status})`);
  const created = await cr.json();
  const etag = cr.headers.get('etag');
  const pr = await fetch(`http://localhost:${PORT}/books/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag }, body: byName('Update books').body.raw });
  ok(pr.status === 200, `the server accepts the books update body (${pr.status})`);
  await fetch(`http://localhost:${PORT}/books/${created.id}`, { method: 'DELETE' });

  console.log('3b. Subcollections, include, relations and actions of the reference');
  const vars = Object.fromEntries(pm.col.variable.map((v) => [v.key, v.value]));
  const expand = (raw) => raw.replace(/\{\{([^}]+)\}\}/g, (_, k) => vars[k]).replace('{{base_url}}', vars.base_url);
  const pmFolder = (n) => pm.col.item.find((x) => x.name === n)?.item ?? [];
  const req = (f, n) => pmFolder(f).find((x) => x.name === n)?.request;
  const call = async (r, extra = {}) => {
    const res = await fetch(expand(r.url.raw), { method: r.method, headers: Object.fromEntries(r.header.map((x) => [x.key, x.value])), body: r.body?.raw, ...extra });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // reviews hangs from books: the parent variable is a book that has reviews, and its sample id is one of them.
  const revs = await (await fetch(`http://localhost:${PORT}/books/${vars.reviews_path_book_id}/reviews`)).json();
  ok(revs.items?.some((x) => x.id === vars.reviews_id), `subcollection: the sample parent (${vars.reviews_path_book_id}) has review ${vars.reviews_id}`);
  ok(req('reviews', 'Get reviews')?.url.raw === '{{base_url}}/books/{{reviews_path_book_id}}/reviews/{{reviews_id}}', 'subcollection: item path with the template');
  ok((await call(req('reviews', 'Get reviews'))).status === 200, 'subcollection: getting a review gives 200');
  // include with depth 2 (products declares include_depth 2) and relations with href and type.
  const incP = req('products', 'Include relations of products');
  ok(incP?.url.query.find((q) => q.key === 'include')?.value === 'category,category.parent,category.showcase', `include up to include_depth 2: ${JSON.stringify(incP?.url.query)}`);
  const ip = await call(incP);
  ok(ip.status === 200 && ip.json.items.some((x) => x.category?.parent?.name), 'include: category.parent is included');
  const ib = await call(req('books', 'Include relations of books'));
  const hl = ib.json?.items.map((x) => x.highlight).find(Boolean);
  ok(!hl || (typeof hl.href === 'string' && (await fetch(`http://localhost:${PORT}${hl.href}`)).status === 200), 'include: highlight carries href and leads to the review');
  const ic = await call(req('categories', 'Include relations of categories'));
  const shown = (ic.json?.items ?? []).map((x) => x.showcase).filter(Boolean);
  ok(shown.length && shown.every((x) => ['books', 'products'].includes(x.type)), 'include: showcase carries type');
  ok(req('categories', 'Include relations of categories')?.url.query.find((q) => q.key === 'include')?.value === 'parent,showcase', 'include: categories without include_depth, first level only');
  // Actions: collection GET, item POST with input and non-idempotent, idempotent ones without a key.
  const low = req('products', 'Action low_stock (collection)');
  ok(low?.method === 'GET' && !low.body && low.url.raw === '{{base_url}}/products:low_stock', 'collection GET action without a body');
  ok((await call(low)).json?.items.every((x) => x.stock < 5), 'low_stock answers the list');
  const rs = req('products', 'Action restock (item)');
  ok(rs?.method === 'POST' && JSON.parse(rs.body.raw).quantity >= 1 && rs.header.some((x) => x.key === 'Idempotency-Key'), 'restock: POST with a body from its input and Idempotency-Key');
  const rsr = await call(rs);
  ok(rsr.status === 200 && typeof rsr.json?.stock === 'number', `the server accepts the sample restock (${rsr.status})`);
  const foc = req('authors', 'Action find_or_create (collection)');
  ok(foc && !foc.header.some((x) => x.key === 'Idempotency-Key') && JSON.parse(foc.body.raw).name, 'find_or_create: idempotent, no key and with name');
  const f1 = await call(foc), f2 = await call(foc);
  // §11.1 (draft 7): an unsafe action on a collection answers 201 with Location or 204, never 200.
  ok([201, 204].includes(f1.status) && (f1.status === 204 || typeof f1.json?.id === 'string') && f2.status === 204, `repeated find_or_create creates once, then finds it (${f1.status}, ${f2.status})`);
  const it = req('categories', 'Action inherit_tax (item)');
  ok(it && JSON.parse(it.body.raw) && !it.header.some((x) => x.key === 'Idempotency-Key'), 'inherit_tax: body {} without a key');
  // The sample item may have no own rate: then the state does not allow it (409 conflict, 11.1), which still
  // shows the request reached the action well formed.
  const itr = await call(it);
  ok(itr.status === 200 || (itr.status === 409 && itr.json?.code === 'conflict'), `the server accepts inherit_tax (${itr.status})`);

  console.log('4. With oauth: Authorization: Bearer {{token}} and reads with a token');
  const outO = join(tmp, 'oauth');
  const r2 = await run([`http://localhost:${PORT_OAUTH}/`, '--to', 'http', '--out', outO, '--token', TOKEN]);
  ok(r2.code === 0, `exits with 0 (exited ${r2.code}: ${r2.err})`);
  ok(existsSync(join(outO, 'books.http')), 'a single format goes straight to --out');
  ok(readFileSync(join(outO, 'books.http'), 'utf8').includes('Authorization: Bearer {{token}}'), 'carries Authorization');
  ok(!walk(outO).some((f) => readFileSync(f, 'utf8').includes(TOKEN)), 'the token is not written to the files');
  await execHttpReads(outO, { token: TOKEN });
  const r3 = await run([`http://localhost:${PORT_OAUTH}/`, '--to', 'http', '--out', join(tmp, 'x')]);
  ok(r3.code === 2 && /401/.test(r3.err), 'without a token, clear error with 401');

  console.log('5. From a file: actions, subcollections and no declared methods');
  const fixture = {
    restep: '1.0', version: '1', profiles: ['core', 'query', 'writes'], extensions: ['actions', 'oauth'],
    collections: {
      orders: {
        path: '/orders', methods: ['GET'], item_methods: ['GET', 'PATCH'],
        filter: { status: { type: 'enum', values: ['paid', 'sent'], ops: ['in'] }, created: { type: 'datetime', ops: ['ge'] } },
        actions: {
          cancel: { on: 'item', safe: false, idempotent: false, description: 'Cancela el pedido.', input: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } },
          preview: { on: 'item', safe: true, idempotent: true, method: 'GET' },
          import: { on: 'collection', safe: false, idempotent: true },
        },
      },
      lines: { path: '/orders/{id}/lines', sort: ['id'] },
    },
  };
  const fx = join(tmp, 'discovery.json');
  writeFileSync(fx, JSON.stringify(fixture));
  const outF = join(tmp, 'file');
  const r4 = await run([fx, '--to', 'postman,bruno', '--out', outF, '--base-url', 'https://api.example.com/', '--name', 'Tienda']);
  ok(r4.code === 0, `exits with 0 (exited ${r4.code}: ${r4.err})`);
  const pf = checkPostman(join(outF, 'postman', 'Tienda.postman_collection.json'), { auth: true });
  checkBruno(join(outF, 'bruno'), { auth: true });
  ok(pf.col.variable.find((v) => v.key === 'base_url').value === 'https://api.example.com', 'base_url without a trailing slash');
  const orders = pf.col.item.find((x) => x.name === 'orders').item;
  const names = orders.map((x) => x.name);
  ok(!names.some((n) => n.startsWith('Create') || n.startsWith('Delete')), 'respects methods and item_methods');
  const cancel = orders.find((x) => x.name.startsWith('Action cancel')).request;
  ok(cancel.method === 'POST' && cancel.url.raw === '{{base_url}}/orders/{{orders_id}}:cancel', 'item action');
  ok(JSON.parse(cancel.body.raw).reason === 'example', 'action body from input');
  ok(cancel.header.some((h) => h.key === 'Idempotency-Key'), 'non-idempotent action with Idempotency-Key');
  const preview = orders.find((x) => x.name.startsWith('Action preview')).request;
  ok(preview.method === 'GET' && !preview.body, 'GET action without a body');
  const imp = orders.find((x) => x.name.startsWith('Action import')).request;
  ok(imp.url.raw === '{{base_url}}/orders:import' && !imp.header.some((h) => h.key === 'Idempotency-Key'), 'idempotent collection action without a key');
  ok(orders.some((x) => x.request.url.raw.includes('filter[status][in]=paid,sent')), 'in filter with two values');
  ok(orders.some((x) => x.request.url.raw.includes('filter[created][ge]=2026-01-01T10:00:00Z')), 'datetime filter');
  const lines = pf.col.item.find((x) => x.name === 'lines').item;
  ok(lines[0].request.url.raw.startsWith('{{base_url}}/orders/{{lines_path_id}}/lines'), 'URI template as a variable');
  ok(pf.col.variable.some((v) => v.key === 'lines_path_id'), 'the template variable is in the environment');
  ok(lines.some((x) => x.name.startsWith('Create')), 'without declared methods, generates all');

  console.log('6. Versions, unknown values, id_from, anonymous and links');
  const d6 = {
    restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions'], idempotency: { anonymous: false },
    collections: {
      tags: { path: '/tags', id_from: 'client', schemas: { create: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } },
        filter: { geo: { type: 'geo', ops: ['eq'] }, name: { type: 'string', ops: ['near', 'eq'] } },
        actions: { go: { on: 'everywhere', safe: true, idempotent: true }, put: { on: 'item', safe: false, idempotent: true, method: 'PUT' }, ok: { on: 'item', safe: false, idempotent: false } } },
      notes: { path: '/notes', id_from: 'someday', schemas: { create: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } } },
      plain: { path: '/plain', schemas: { create: { type: 'object', required: ['id', 'x'], properties: { id: { type: 'string' }, x: { type: 'string' } } } } },
      shelf: { path: '/shelf', schemas: { create: { type: 'object', required: ['x'], properties: { x: { type: 'string' },
        kind: { anyOf: [{ type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, { type: 'null' }], default: 'b' } } } } },
    },
    singletons: { me: { path: '/me', methods: ['GET'] }, tpl: { path: '/users/{u}/prefs' }, sub: { path: '/tags/{t}/x', parent: 'nowhere' } },
  };
  const f6 = join(tmp, 'd6.json');
  writeFileSync(f6, JSON.stringify(d6));
  const r8 = await run([f6, '--to', 'postman', '--out', join(tmp, 'd6'), '--name', 'D6']);
  ok(r8.code === 0, `accepts "1.0-draft.7" (exited ${r8.code}: ${r8.err})`);
  const c6 = JSON.parse(readFileSync(join(tmp, 'd6', 'D6.postman_collection.json'), 'utf8'));
  const folder = (n) => c6.item.find((x) => x.name === n)?.item ?? [];
  const tags = folder('tags');
  ok(!tags.some((x) => x.name.includes(' geo ')) && tags.some((x) => x.request.url.raw.includes('filter[name]=example')) && !tags.some((x) => x.request.url.raw.includes('near')),
    'a filter of unknown type is not used; of a filter, only the known operators (§4.2)');
  ok(!tags.some((x) => /Action (go|put)/.test(x.name)) && tags.some((x) => x.name.startsWith('Action ok')), 'an action with an unknown on or method is not used (§4.2)');
  const tagBody = JSON.parse(tags.find((x) => x.name === 'Create in tags').request.body.raw);
  ok(/^[0-9a-f-]{36}$/.test(tagBody.id), 'id_from "client": the POST carries a random id (§5.1)');
  ok(!('id' in JSON.parse(folder('notes').find((x) => x.name === 'Create in notes').request.body.raw)), 'unknown id_from: the POST carries no id (§5.1)');
  ok(!('id' in JSON.parse(folder('plain').find((x) => x.name === 'Create in plain').request.body.raw)), 'no id_from: the POST carries no id (§5.1)');
  ok(JSON.parse(folder('shelf').find((x) => x.name === 'Create in shelf').request.body.raw).kind === 'b',
    'an optional scalar with default and oneOf const options goes in the body, with its default (§4.3)');
  ok(!c6.item.flatMap((f) => f.item).some((x) => x.request.header.some((h) => h.key === 'Idempotency-Key')), '"anonymous": false without credentials: no Idempotency-Key (§7.1)');
  const me = folder('me');
  ok(me.length === 1 && me[0].request.method === 'GET', 'singleton with methods [GET]: GET only');
  ok(!folder('tpl').length && !folder('sub').length && /tpl/.test(r8.err) && /sub/.test(r8.err), 'singleton with a template and no parent, or a parent that names nothing: ignored with a warning (§5.9)');
  for (const v of ['2.0', '1.0-beta', '01.0', '1']) {
    writeFileSync(f6, JSON.stringify({ ...d6, restep: v }));
    const r = await run([f6, '--out', join(tmp, 'v')]);
    ok(r.code === 2 && /Restep 1/.test(r.err), `"restep": "${v}" is not Restep 1: clear error (§1.1)`);
  }
  for (const v of ['1.0-rc.1', '1.3']) {
    writeFileSync(f6, JSON.stringify({ ...d6, restep: v }));
    ok((await run([f6, '--to', 'http', '--out', join(tmp, 'v')])).code === 0, `"restep": "${v}" is accepted`);
  }
  // service-desc to another origin: requested without credentials; to a scheme that is neither https nor the root's, not requested.
  {
    const { createServer } = await import('node:http');
    const seen = [];
    const other = createServer((req, res) => { seen.push(req.headers.authorization ?? null); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ restep: '1.0-draft.7', collections: {} })); });
    await new Promise((r) => other.listen(8974, '127.0.0.1', r));
    const front = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', link: '<data:application/json,{"restep":"1.0"}>; rel="service-desc", <http://127.0.0.1:8974/d.json>; rel="service-desc"' }); res.end('<p>hola</p>'); });
    await new Promise((r) => front.listen(8975, '127.0.0.1', r));
    const r = await run(['http://localhost:8975/', '--to', 'http', '--out', join(tmp, 'sd'), '--token', 'secreto', '-H', 'X-Api-Key: otro']);
    ok(r.code === 0 && seen.length === 1 && seen[0] === null, `service-desc on another origin: no credentials (§4.3), and data: is not followed (§3) (${r.err} ${JSON.stringify(seen)})`);
    other.close(); front.close();
  }

  console.log('7. Draft 7: filters, default and required filters, localized fields, effects, params and singletons with parent');
  const d7 = {
    restep: '1.0-draft.7', profiles: ['core', 'query', 'writes'], extensions: ['actions'],
    collections: {
      events: { path: '/events',
        schemas: { create: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, name: { type: 'string' }, name_i18n: { type: 'object' } } } },
        localized: { name: { source: 'name_i18n' } }, upsert: true, id_from: 'client',
        filter: { starts_at: { type: 'localdatetime', ops: ['ge'] }, zone: { type: 'timezone', ops: ['eq'] }, tag: { type: 'string', ops: ['nin'] },
          title: { type: 'string', ops: ['prefix', 'contains'] }, 'reviews.rating': { type: 'integer', ops: ['ge'], quantifier: 'some' },
          'formats': { type: 'string', ops: ['eq'], quantifier: 'all' }, reviews: { type: 'string', ops: ['null'] }, labels: { type: 'string', ops: ['null'] },
          pages: { type: 'integer', ops: ['eq'] }, shelves: { type: 'string', ops: ['null', 'in'], quantifier: 'some' } },
        relations: { reviews: { to: 'reviews', many: true } },
        named_filters: { active: { description: 'Not archived.', default: true }, search: { type: 'string', description: 'Text.' } },
        actions: {
          cancel: { on: 'item', safe: false, idempotent: true, effects: ['external'] },
          purge: { on: 'collection', safe: false, idempotent: true },
          compare: { on: 'item', safe: true, idempotent: true, method: 'GET', params: { with: { type: 'string', required: true }, as: { type: 'enum', values: ['pdf'] }, ids: { type: 'integer', list: true, required: true } } },
          new: { on: 'collection', safe: true, idempotent: true, method: 'GET' },
          quote: { on: 'item', safe: true, idempotent: true, method: 'GET', effects: ['charges'] },
          ping: { on: 'item', safe: true, idempotent: true, method: 'GET' } } },
      books: { path: '/books', filter: { isbn: { type: 'string', ops: ['eq'], required: true } }, named_filters: { active: { description: 'x', default: true } } },
      payments: { path: '/payments', methods: ['POST'], item_methods: ['GET'] },
      readers: { path: '/readers' },
      scans: { path: '/scans', methods: ['POST'], upload: { media_types: ['image/png'] } },
      docs: { path: '/docs', methods: ['POST'], upload: { media_types: ['application/*'], multipart: true }, schemas: { create: { type: 'object', properties: { title: { type: 'string' } } } } },
      dumps: { path: '/dumps', methods: ['GET', 'POST'], upload: { media_types: ['*/*'] },
        relations: { notes: { to: 'readers', many: true } },
        filter: { notes: { type: 'string', ops: ['null'] }, 'notes.id': { type: 'string', ops: ['null'], quantifier: 'some' }, required_tag: { type: 'string', ops: ['null', 'eq'], required: true } } },
    },
    singletons: {
      settings: { path: '/readers/{reader_id}/settings', parent: 'readers', actions: { reset: { safe: false, idempotent: true, effects: [] } } },
      theme: { path: '/readers/{reader_id}/settings/theme', parent: 'settings' },
      lost: { path: '/x/{y}/z', parent: 'nowhere' },
      prefs: { path: '/prefs', methods: ['GET', 'PATCH'], method_effects: { PATCH: ['external'] } },
      quiet: { path: '/quiet', method_effects: { PATCH: [] } },
    },
  };
  const f7 = join(tmp, 'd7.json');
  writeFileSync(f7, JSON.stringify(d7));
  const r9 = await run([f7, '--to', 'postman', '--out', join(tmp, 'd7'), '--name', 'D7']);
  ok(r9.code === 0, `accepts "1.0-draft.7" (exited ${r9.code}: ${r9.err})`);
  const c7 = JSON.parse(readFileSync(join(tmp, 'd7', 'D7.postman_collection.json'), 'utf8'));
  const f7d = (n) => c7.item.find((x) => x.name === n)?.item ?? [];
  const evs = f7d('events'), raw = (n) => evs.find((x) => x.name === n)?.request.url.raw ?? '';
  ok(raw('Filter events by starts_at (ge)').includes('filter[starts_at][ge]=2026-01-01T10:00:00') && raw('Filter events by zone (eq)').includes('filter[zone]=Europe%2FMadrid'),
    'localdatetime and timezone filters (§3, §4.2)');
  ok(raw('Filter events by tag (nin)').includes('filter[tag][nin]=') && raw('Filter events by title (prefix)').includes('filter[title][prefix]=example'), 'operators nin and prefix (§6.1)');
  ok(raw('Filter events by reviews.rating (ge)').includes('filter[reviews.rating][ge]=') && !evs.some((x) => x.name.includes('formats')),
    'quantifier some is used, an unknown quantifier is not (§4.2)');
  const all = evs.find((x) => x.name === 'List all events');
  ok(all && all.request.url.raw.includes('filter[active]=false') && /full copy/.test(all.request.description) && /Default filters apply: active/.test(evs.find((x) => x.name === 'List events').request.description),
    'a request for a full copy turns off the default filters (§5.2, §6.1)');
  const bks = f7d('books');
  ok(bks.filter((x) => x.request.method === 'GET' && !x.request.url.raw.includes('{{books_id}}')).every((x) => x.request.url.raw.includes('filter[isbn]=')) && !bks.some((x) => x.name === 'List all books'),
    'a required filter goes in every list request, and there is no full copy (§6.1)');
  const pays = f7d('payments');
  ok(!pays.some((x) => x.name.startsWith('List')) && pays.some((x) => x.name === 'Create in payments'), 'a collection without GET is not listed (§4.3)');
  const evBody = JSON.parse(evs.find((x) => x.name === 'Create in events').request.body.raw);
  const evPatch = JSON.parse(evs.find((x) => x.name === 'Update events').request.body.raw);
  ok(!('name' in evBody) && !('name' in evPatch) && evBody.title, 'a localized field is not written (§3)');
  ok(/upsert/.test(evs.find((x) => x.name === 'Update events').request.description), 'upsert is explained on the PATCH (§5.1)');
  const desc = (n) => evs.find((x) => x.name.startsWith(`Action ${n}`))?.request.description ?? '';
  ok(/Effects: external \(/.test(desc('cancel')) && /Effects: destroys, external, charges \(undeclared/.test(desc('purge')) && !/Effects/.test(desc('compare')),
    'effects in the notes, all three where undeclared (§11.1)');
  ok(/Effects: charges \(/.test(desc('quote')) && !/Effects/.test(desc('new')), 'a safe action: its declared effects, none where undeclared (§11.1)');
  const cmp = evs.find((x) => x.name.startsWith('Action compare')).request.url.raw;
  ok(/:compare\?/.test(cmp) && cmp.includes('with=example') && cmp.includes('ids=2000,2001') && !cmp.includes('as='), 'the required params of a GET action, a list with two values (§11.1)');
  ok(evs.some((x) => x.name.startsWith('Action new') && x.request.method === 'GET' && x.request.url.raw.endsWith('/events:new')), 'the new action (§11.1)');
  const st = f7d('settings'), th = f7d('theme');
  ok(st[0]?.request.url.raw === '{{base_url}}/readers/{{settings_path_reader_id}}/settings' && th[0]?.request.url.raw === '{{base_url}}/readers/{{theme_path_reader_id}}/settings/theme',
    'singletons under an item and under another singleton (§5.9)');
  ok(st.some((x) => x.name === 'Action reset' && x.request.method === 'POST' && x.request.url.raw.endsWith('/settings:reset') && /Effects: none/.test(x.request.description)),
    'a singleton action at {path}:{name} (§5.9, §11.1)');
  ok(!f7d('lost').length && /lost/.test(r9.err), 'a singleton whose parent names nothing is ignored (§5.9)');
  // Council round 1: null without quantifier (1), 20.0 (3), GET action without params (6), a singleton's method_effects (8).
  const nullDesc = (f) => evs.find((x) => x.name === `Filter events by ${f} (null)`);
  ok(nullDesc('reviews')?.request.url.raw.includes('filter[reviews][null]=true') && /reviews\[null\] tests the whole list, never each element: true gives the items with no related item/.test(nullDesc('reviews').request.description),
    'null without quantifier on a to-many relationship is offered and explained (§6.1)');
  ok(nullDesc('labels')?.request.url.raw.includes('filter[labels][null]=true'), 'null without quantifier on a list field is offered (§6.1)');
  ok(raw('Filter events by pages (eq)').includes('filter[pages]=2000'), 'an integer filter (§6.1)');
  // Council round 3: null on a group with quantifier some (8, 9); create only where schemas.create says so beside upload (1, 2).
  ok(/shelves\[null\] tests the whole list.*next to other filters on shelves, true gives the items where no element meets them all at once and false those where some does/.test(nullDesc('shelves')?.request.description ?? ''),
    'null with quantifier some tests the whole list, alone and next to other filters on it (§6.1, round 3)');
  ok(!f7d('scans').some((x) => x.name === 'Create in scans'), 'a collection with upload and without schemas.create gets no JSON create (§5.1, round 3)');
  ok(/always creates an item from its fields, never a file; a JSON file goes as the file part of multipart\/form-data, with a filename \(a generic one such as file if it has none\), and a \+json body/.test(f7d('docs').find((x) => x.name === 'Create in docs')?.request.description ?? ''),
    'a collection with upload and schemas.create gets a JSON create that explains JSON files go as multipart, with a filename (§5.1, rounds 3 and 4)');
  // Council round 4: an upload-only collection whose media_types admit JSON by */* gets no JSON create (1a); no
  // request carries two null filters on one group (5a), and null next to other filters negates them all at once (5b).
  const dumps = f7d('dumps');
  ok(dumps.length && !dumps.some((x) => x.request.method === 'POST'), 'an upload-only collection with */* gets no JSON create: a JSON body there is a file (§5.1, round 4)');
  const nullsPerGroup = (u) => { const g = [...new URL(u.replace('{{base_url}}', 'http://x')).searchParams.keys()].map((k) => /^filter\[([^\]]+)\]\[null\]$/.exec(k)?.[1]).filter(Boolean).map((f) => f.split('.')[0]); return g.length !== new Set(g).size; };
  ok(c7.item.flatMap((f) => f.item ?? []).every((x) => !nullsPerGroup(x.request.url.raw)) && dumps.some((x) => x.request.url.raw.includes('filter[notes.id][null]=true') && x.request.url.raw.includes('filter[required_tag]=')),
    'no request carries two null filters on one group, also with a required filter (§6.1, round 4)');
  ok(/no element meets them all at once.*only one null filter per group/.test(nullDesc('shelves')?.request.description ?? ''), 'null next to other filters negates them all at once, one per group (§6.1, round 4)');
  ok(/takes no query parameters/.test(desc('ping')) && evs.find((x) => x.name.startsWith('Action ping')).request.url.raw.endsWith('/events/{{events_id}}:ping')
    && !/takes no query parameters/.test(desc('compare')) && !/takes no query parameters/.test(desc('cancel')), 'a GET action without params takes none (§5.3, §11.1)');
  const patchNote = (n) => f7d(n).find((x) => x.request.method === 'PATCH')?.request.description ?? '';
  ok(/Effects: external \(§4\.3/.test(patchNote('prefs')) && /Effects: none \(/.test(patchNote('quiet')) && /Effects: destroys, external, charges \(undeclared/.test(patchNote('settings')),
    "a singleton's PATCH notes its method_effects, all three where undeclared (§4.3, §5.9)");
  {
    // §4.2: of several service-desc links, the first target that is a discovery document of Restep 1.
    const { createServer } = await import('node:http');
    const docs = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v2.json' ? { restep: '2.0', collections: { two: { path: '/two' } } } : { restep: '1.0-draft.7', collections: { one: { path: '/one' } } })); });
    await new Promise((r) => docs.listen(0, '127.0.0.1', r));
    const p = docs.address().port;
    const front = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', link: `</v2.json>; rel="service-desc", </v1.json>; rel="service-desc"` }); res.end('<p>hola</p>'); });
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const docsUrl = `http://127.0.0.1:${p}`;
    front.removeAllListeners('request');
    front.on('request', (req, res) => { res.writeHead(200, { 'content-type': 'text/html', link: `<${docsUrl}/v2.json>; rel="service-desc", <${docsUrl}/v1.json>; rel="service-desc"` }); res.end('<p>hola</p>'); });
    const r = await run([`http://127.0.0.1:${front.address().port}/`, '--to', 'postman', '--out', join(tmp, 'sd7'), '--name', 'SD7', '--no-samples']);
    const col = r.code === 0 ? JSON.parse(readFileSync(join(tmp, 'sd7', 'SD7.postman_collection.json'), 'utf8')) : null;
    ok(col && col.item.some((x) => x.name === 'one') && !col.item.some((x) => x.name === 'two'), `the first service-desc of Restep 1 is used (§4.2) (${r.code}: ${r.err})`);
    docs.close(); front.close();
  }

  console.log('8. Clear errors');
  const r5 = await run([join(tmp, 'no-existe.json'), '--out', join(tmp, 'y')]);
  ok(r5.code === 2 && /does not exist/.test(r5.err), 'missing file');
  const r6 = await run([fx, '--to', 'insomnia', '--out', join(tmp, 'y')]);
  ok(r6.code === 2 && /Unknown format/.test(r6.err), 'unknown format');
  const r7 = await run([`http://localhost:${PORT}/books`, '--out', join(tmp, 'y')]);
  ok(r7.code === 2 && /discovery document/.test(r7.err), 'URL that is not the root');
} catch (e) {
  failed++;
  console.log(`  ERROR: ${e.stack}`);
} finally {
  for (const s of servers) s.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nrestep-export: ${passed} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
