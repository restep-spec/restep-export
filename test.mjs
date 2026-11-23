// Pruebas de restep-export contra el servidor de referencia (puertos 8895 y 8896).
// Uso, desde restep/:  node tools/restep-export/test.mjs
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
  else { failed++; console.log(`  FALLO: ${msg}`); }
}

async function startServer(port, env = {}) {
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${port}/health`); return p; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  p.kill();
  throw new Error(`el servidor de referencia no arranca en ${port}`);
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

// ── Mini-analizador de .http (subconjunto común a REST Client y JetBrains) ────
function parseHttp(text, env) {
  const vars = { ...env };
  const reqs = [];
  text.split(/^###/m).forEach((block, idx) => {
    const lines = block.split('\n');
    const name = idx ? lines.shift().trim() : null;
    let i = 0;
    const take = () => lines[i++];
    // Variables de archivo y comentarios hasta la línea de petición.
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
    if (!m) throw new Error(`línea de petición no válida: ${reqLine}`);
    const headers = [];
    while (i < lines.length && lines[i].trim()) {
      const h = take(), c = h.indexOf(':');
      if (c < 1) throw new Error(`cabecera no válida: ${h}`);
      headers.push([h.slice(0, c).trim(), h.slice(c + 1).trim()]);
    }
    const body = lines.slice(i).join('\n').trim();
    reqs.push({ name, method: m[1], url: m[2], headers, body: body || undefined, vars: { ...vars } });
  });
  const subst = (s, v) => s.replace(/\{\{([^}]+)\}\}/g, (_, k) => {
    if (!(k in v)) throw new Error(`variable sin definir: ${k}`);
    return v[k];
  });
  return reqs.map((r) => ({ ...r, url: subst(r.url, r.vars), headers: r.headers.map(([k, v]) => [k, subst(v, r.vars)]), body: r.body && subst(r.body, r.vars) }));
}

// Analizador mínimo de .bru: bloques «nombre {…}» o «nombre […]» de primer nivel.
function parseBru(text) {
  const blocks = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z:-]+)\s*([{[])$/.exec(lines[i]);
    if (!m) { if (lines[i].trim()) throw new Error(`línea fuera de bloque: ${lines[i]}`); continue; }
    const close = m[2] === '{' ? '}' : ']';
    const body = [];
    for (i++; i < lines.length && lines[i] !== close; i++) body.push(lines[i]);
    if (lines[i] !== close) throw new Error(`bloque ${m[1]} sin cerrar`);
    blocks[m[1]] = body;
  }
  const kv = (name) => Object.fromEntries((blocks[name] ?? []).map((l) => { const c = l.indexOf(':'); return [l.slice(0, c).trim(), l.slice(c + 1).trim()]; }));
  return { blocks, kv };
}

function checkPostman(file, { auth }) {
  const col = JSON.parse(readFileSync(file, 'utf8'));
  ok(col.info?.schema === 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', 'postman: info.schema v2.1');
  ok(typeof col.info?._postman_id === 'string' && typeof col.info?.name === 'string', 'postman: info con _postman_id y name');
  ok(col.variable.some((v) => v.key === 'base_url') && col.variable.some((v) => v.key === 'token'), 'postman: variables base_url y token');
  ok(Boolean(col.auth) === auth, `postman: auth ${auth ? 'presente' : 'ausente'}`);
  let n = 0;
  for (const folder of col.item) {
    ok(Array.isArray(folder.item) && folder.item.length > 0, `postman: carpeta ${folder.name} con peticiones`);
    for (const it of folder.item) {
      n++;
      const r = it.request;
      ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(r.method), `postman: método de ${it.name}`);
      ok(r.url.raw.startsWith('{{base_url}}/') && r.url.host[0] === '{{base_url}}', `postman: url de ${it.name}`);
      if (r.body) ok(JSON.parse(r.body.raw) !== undefined && r.body.options.raw.language === 'json', `postman: cuerpo JSON en ${it.name}`);
      if (r.url.query) ok(r.url.raw.includes('?'), `postman: query en raw de ${it.name}`);
    }
  }
  return { col, n };
}

function checkBruno(dir, { auth }) {
  const meta = JSON.parse(readFileSync(join(dir, 'bruno.json'), 'utf8'));
  ok(meta.type === 'collection' && meta.version === '1', 'bruno: bruno.json');
  const env = parseBru(readFileSync(join(dir, 'environments', 'local.bru'), 'utf8'));
  ok(env.kv('vars').base_url?.startsWith('http'), 'bruno: base_url en el entorno');
  ok(env.blocks['vars:secret']?.map((l) => l.trim()).includes('token'), 'bruno: token como secreto');
  const files = walk(dir).filter((f) => f.endsWith('.bru') && !f.includes('environments') && !f.endsWith('folder.bru'));
  for (const f of files) {
    const b = parseBru(readFileSync(f, 'utf8'));
    const m = b.kv('meta');
    ok(m.name && m.type === 'http' && /^\d+$/.test(m.seq), `bruno: meta de ${f}`);
    const verb = ['get', 'post', 'patch', 'delete'].find((v) => b.blocks[v]);
    ok(verb, `bruno: bloque de método en ${f}`);
    const v = b.kv(verb);
    ok(v.url?.startsWith('{{base_url}}/'), `bruno: url en ${f}`);
    ok(v.auth === (auth ? 'bearer' : 'none'), `bruno: auth en ${f}`);
    if (v.body === 'json') ok(JSON.parse(b.blocks['body:json'].join('\n')) !== undefined, `bruno: cuerpo JSON en ${f}`);
  }
  return files.length;
}

async function execHttpReads(dir, envOverride = {}) {
  const env = { ...JSON.parse(readFileSync(join(dir, 'http-client.env.json'), 'utf8')).local, ...envOverride };
  const vs = JSON.parse(readFileSync(join(dir, '.vscode', 'settings.json'), 'utf8'))['rest-client.environmentVariables'].local;
  ok(vs.base_url === env.base_url || envOverride.base_url, 'http: mismo base_url en JetBrains y VS Code');
  let reads = 0, total = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.http'))) {
    const reqs = parseHttp(readFileSync(join(dir, f), 'utf8'), env);
    total += reqs.length;
    for (const r of reqs) {
      if (r.method !== 'GET') { if (r.body) ok(JSON.parse(r.body) !== undefined, `http: cuerpo JSON en ${r.name}`); continue; }
      reads++;
      const res = await fetch(r.url, { headers: Object.fromEntries(r.headers) });
      ok(res.status >= 200 && res.status < 300, `http: ${r.name} (${r.url}) responde ${res.status}: ${res.status >= 300 ? await res.text() : ''}`);
    }
  }
  return { reads, total };
}

// ── Pruebas ───────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'restep-export-'));
const servers = [];
try {
  servers.push(await startServer(PORT), await startServer(PORT_OAUTH, { RESTEP_TOKEN: TOKEN }));
  const disc = await (await fetch(`http://localhost:${PORT}/`)).json();
  const collections = Object.keys(disc.collections);

  console.log('1. Los tres formatos desde la URL del servidor de referencia');
  const out = join(tmp, 'todo');
  const r1 = await run([`http://localhost:${PORT}/`, '--out', out]);
  ok(r1.code === 0, `sale con 0 (salió ${r1.code}: ${r1.err})`);
  for (const f of ['http', 'bruno', 'postman']) ok(existsSync(join(out, f)), `existe la carpeta ${f}`);
  for (const c of collections) ok(existsSync(join(out, 'http', `${c}.http`)), `http: ${c}.http`);
  const pm = checkPostman(walk(join(out, 'postman')).find((f) => f.endsWith('.postman_collection.json')), { auth: false });
  const nBru = checkBruno(join(out, 'bruno'), { auth: false });
  ok(nBru === pm.n, `bruno y postman tienen las mismas peticiones (${nBru} y ${pm.n})`);
  const books = pm.col.item.find((x) => x.name === 'books').item;
  const byName = (n) => books.find((x) => x.name === n)?.request;
  ok(byName('Crear en books')?.header.some((h) => h.key === 'Idempotency-Key' && /^"[0-9a-f-]{36}"$/.test(h.value)), 'crear lleva Idempotency-Key como cadena de Structured Fields');
  ok(byName('Actualizar books')?.header.some((h) => h.key === 'If-Match' && h.value === '{{books_etag}}'), 'actualizar lleva If-Match');
  ok(byName('Actualizar books')?.header.some((h) => h.value === 'application/merge-patch+json'), 'actualizar es merge patch');
  ok(byName('Borrar books')?.header.some((h) => h.key === 'If-Match'), 'borrar lleva If-Match');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key.startsWith('filter['))), 'hay ejemplos de filtros');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key === 'sort')), 'hay ejemplo de orden');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key === 'fields')), 'hay ejemplo de fields');
  ok(books.some((x) => x.request.url.query?.some((q) => q.key === 'count')), 'hay ejemplo de count');
  ok(books.find((x) => x.name === 'Obtener books')?.event?.[0].script.exec.join('\n').includes('books_etag'), 'obtener guarda la ETag');
  // §5.9: los recursos sueltos del descubrimiento (la tienda, /shop) salen con su GET y su PATCH.
  for (const s of Object.keys(disc.singletons ?? {})) ok(existsSync(join(out, 'http', `${s}.http`)), `http: recurso suelto ${s}.http`);
  const shop = pm.col.item.find((x) => x.name === 'shop')?.item ?? [];
  ok(shop.some((x) => x.name === 'Obtener shop' && x.request.method === 'GET' && x.request.url.raw === '{{base_url}}/shop'), 'recurso suelto: GET /shop');
  const shopPatch = shop.find((x) => x.name === 'Actualizar shop')?.request;
  ok(shopPatch?.method === 'PATCH' && shopPatch.header.some((h) => h.key === 'If-Match' && h.value === '{{shop_etag}}'), 'recurso suelto: PATCH con If-Match');
  // §3: toda escritura con cuerpo lleva su Content-Type.
  ok(pm.col.item.flatMap((f) => f.item).every((x) => !x.request.body || x.request.header.some((h) => h.key === 'Content-Type')), 'todo cuerpo con Content-Type');

  console.log('2. Peticiones de lectura de los .http contra el servidor');
  const h = await execHttpReads(join(out, 'http'));
  ok(h.reads >= collections.length * 3, `se ejecutan lecturas (${h.reads} de ${h.total})`);

  console.log('3. Las escrituras de ejemplo son aceptables: crear y actualizar con la ETag');
  // El PATCH de ejemplo de la tienda lo acepta el servidor con la ETag de su GET.
  const sg = await fetch(`http://localhost:${PORT}/shop`);
  const sp = await fetch(`http://localhost:${PORT}/shop`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': sg.headers.get('etag') }, body: shopPatch.body.raw });
  ok(sp.status === 200, `el cuerpo de actualizar shop lo acepta el servidor (${sp.status})`);
  await fetch(`http://localhost:${PORT}/shop`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(await sg.json()) });
  const createBody = JSON.parse(byName('Crear en books').body.raw);
  const cr = await fetch(`http://localhost:${PORT}/books`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` }, body: JSON.stringify(createBody) });
  ok(cr.status === 201, `el cuerpo de crear de books lo acepta el servidor (${cr.status})`);
  const created = await cr.json();
  const etag = cr.headers.get('etag');
  const pr = await fetch(`http://localhost:${PORT}/books/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag }, body: byName('Actualizar books').body.raw });
  ok(pr.status === 200, `el cuerpo de actualizar de books lo acepta el servidor (${pr.status})`);
  await fetch(`http://localhost:${PORT}/books/${created.id}`, { method: 'DELETE' });

  console.log('3b. Subcolecciones, include, relaciones y acciones de la referencia');
  const vars = Object.fromEntries(pm.col.variable.map((v) => [v.key, v.value]));
  const expand = (raw) => raw.replace(/\{\{([^}]+)\}\}/g, (_, k) => vars[k]).replace('{{base_url}}', vars.base_url);
  const pmFolder = (n) => pm.col.item.find((x) => x.name === n)?.item ?? [];
  const req = (f, n) => pmFolder(f).find((x) => x.name === n)?.request;
  const call = async (r, extra = {}) => {
    const res = await fetch(expand(r.url.raw), { method: r.method, headers: Object.fromEntries(r.header.map((x) => [x.key, x.value])), body: r.body?.raw, ...extra });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // reviews cuelga de books: la variable del padre es un libro que tiene reseñas, y su id de ejemplo, una de ellas.
  const revs = await (await fetch(`http://localhost:${PORT}/books/${vars.reviews_path_book_id}/reviews`)).json();
  ok(revs.items?.some((x) => x.id === vars.reviews_id), `subcolección: el padre de ejemplo (${vars.reviews_path_book_id}) tiene la reseña ${vars.reviews_id}`);
  ok(req('reviews', 'Obtener reviews')?.url.raw === '{{base_url}}/books/{{reviews_path_book_id}}/reviews/{{reviews_id}}', 'subcolección: ruta del elemento con la plantilla');
  ok((await call(req('reviews', 'Obtener reviews'))).status === 200, 'subcolección: obtener una reseña da 200');
  // include con profundidad 2 (products declara include_depth 2) y relaciones con href y type.
  const incP = req('products', 'Incluir relaciones de products');
  ok(incP?.url.query.find((q) => q.key === 'include')?.value === 'category,category.parent,category.showcase', `include hasta include_depth 2: ${JSON.stringify(incP?.url.query)}`);
  const ip = await call(incP);
  ok(ip.status === 200 && ip.json.items.some((x) => x.category?.parent?.name), 'include: category.parent viene incluido');
  const ib = await call(req('books', 'Incluir relaciones de books'));
  const hl = ib.json?.items.map((x) => x.highlight).find(Boolean);
  ok(!hl || (typeof hl.href === 'string' && (await fetch(`http://localhost:${PORT}${hl.href}`)).status === 200), 'include: highlight lleva href y lleva a la reseña');
  const ic = await call(req('categories', 'Incluir relaciones de categories'));
  const shown = (ic.json?.items ?? []).map((x) => x.showcase).filter(Boolean);
  ok(shown.length && shown.every((x) => ['books', 'products'].includes(x.type)), 'include: showcase lleva type');
  ok(req('categories', 'Incluir relaciones de categories')?.url.query.find((q) => q.key === 'include')?.value === 'parent,showcase', 'include: categories sin include_depth, solo el primer nivel');
  // Acciones: GET de colección, POST de elemento con input y no idempotente, idempotentes sin clave.
  const low = req('products', 'Acción low_stock (colección)');
  ok(low?.method === 'GET' && !low.body && low.url.raw === '{{base_url}}/products:low_stock', 'acción GET de colección sin cuerpo');
  ok((await call(low)).json?.items.every((x) => x.stock < 5), 'low_stock responde la lista');
  const rs = req('products', 'Acción restock (elemento)');
  ok(rs?.method === 'POST' && JSON.parse(rs.body.raw).quantity >= 1 && rs.header.some((x) => x.key === 'Idempotency-Key'), 'restock: POST con cuerpo de su input e Idempotency-Key');
  const rsr = await call(rs);
  ok(rsr.status === 200 && typeof rsr.json?.stock === 'number', `el servidor acepta el restock de ejemplo (${rsr.status})`);
  const foc = req('authors', 'Acción find_or_create (colección)');
  ok(foc && !foc.header.some((x) => x.key === 'Idempotency-Key') && JSON.parse(foc.body.raw).name, 'find_or_create: idempotente, sin clave y con name');
  const f1 = await call(foc), f2 = await call(foc);
  ok([200, 201].includes(f1.status) && f2.status === 200 && f1.json?.id === f2.json?.id, `find_or_create repetido da el mismo autor (${f1.status}, ${f2.status})`);
  const it = req('categories', 'Acción inherit_tax (elemento)');
  ok(it && JSON.parse(it.body.raw) && !it.header.some((x) => x.key === 'Idempotency-Key'), 'inherit_tax: cuerpo {} sin clave');
  ok((await call(it)).status === 200, 'el servidor acepta inherit_tax');

  console.log('4. Con oauth: Authorization: Bearer {{token}} y lecturas con token');
  const outO = join(tmp, 'oauth');
  const r2 = await run([`http://localhost:${PORT_OAUTH}/`, '--to', 'http', '--out', outO, '--token', TOKEN]);
  ok(r2.code === 0, `sale con 0 (salió ${r2.code}: ${r2.err})`);
  ok(existsSync(join(outO, 'books.http')), 'un solo formato va directo a --out');
  ok(readFileSync(join(outO, 'books.http'), 'utf8').includes('Authorization: Bearer {{token}}'), 'lleva Authorization');
  ok(!walk(outO).some((f) => readFileSync(f, 'utf8').includes(TOKEN)), 'el token no se escribe en los archivos');
  await execHttpReads(outO, { token: TOKEN });
  const r3 = await run([`http://localhost:${PORT_OAUTH}/`, '--to', 'http', '--out', join(tmp, 'x')]);
  ok(r3.code === 2 && /401/.test(r3.err), 'sin token, error claro con 401');

  console.log('5. Desde un archivo: acciones, subcolecciones y sin methods declarados');
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
  ok(r4.code === 0, `sale con 0 (salió ${r4.code}: ${r4.err})`);
  const pf = checkPostman(join(outF, 'postman', 'Tienda.postman_collection.json'), { auth: true });
  checkBruno(join(outF, 'bruno'), { auth: true });
  ok(pf.col.variable.find((v) => v.key === 'base_url').value === 'https://api.example.com', 'base_url sin barra final');
  const orders = pf.col.item.find((x) => x.name === 'orders').item;
  const names = orders.map((x) => x.name);
  ok(!names.some((n) => n.startsWith('Crear') || n.startsWith('Borrar')), 'respeta methods e item_methods');
  const cancel = orders.find((x) => x.name.startsWith('Acción cancel')).request;
  ok(cancel.method === 'POST' && cancel.url.raw === '{{base_url}}/orders/{{orders_id}}:cancel', 'acción de elemento');
  ok(JSON.parse(cancel.body.raw).reason === 'ejemplo', 'cuerpo de la acción desde input');
  ok(cancel.header.some((h) => h.key === 'Idempotency-Key'), 'acción no idempotente con Idempotency-Key');
  const preview = orders.find((x) => x.name.startsWith('Acción preview')).request;
  ok(preview.method === 'GET' && !preview.body, 'acción GET sin cuerpo');
  const imp = orders.find((x) => x.name.startsWith('Acción import')).request;
  ok(imp.url.raw === '{{base_url}}/orders:import' && !imp.header.some((h) => h.key === 'Idempotency-Key'), 'acción de colección idempotente sin clave');
  ok(orders.some((x) => x.request.url.raw.includes('filter[status][in]=paid,sent')), 'filtro in con dos valores');
  ok(orders.some((x) => x.request.url.raw.includes('filter[created][ge]=2026-01-01T10:00:00Z')), 'filtro datetime');
  const lines = pf.col.item.find((x) => x.name === 'lines').item;
  ok(lines[0].request.url.raw.startsWith('{{base_url}}/orders/{{lines_path_id}}/lines'), 'plantilla de URI como variable');
  ok(pf.col.variable.some((v) => v.key === 'lines_path_id'), 'la variable de la plantilla está en el entorno');
  ok(lines.some((x) => x.name.startsWith('Crear')), 'sin methods declarados, genera todas');

  console.log('6. Borrador 6: versiones, valores desconocidos, id_from, anonymous y enlaces');
  const d6 = {
    restep: '1.0-draft.6', profiles: ['core', 'query', 'writes'], extensions: ['actions'], idempotency: { anonymous: false },
    collections: {
      tags: { path: '/tags', id_from: 'client', schemas: { create: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } },
        filter: { geo: { type: 'geo', ops: ['eq'] }, name: { type: 'string', ops: ['near', 'eq'] } },
        actions: { go: { on: 'everywhere', safe: true, idempotent: true }, put: { on: 'item', safe: false, idempotent: true, method: 'PUT' }, ok: { on: 'item', safe: false, idempotent: false } } },
      notes: { path: '/notes', id_from: 'someday', schemas: { create: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } } },
      plain: { path: '/plain', schemas: { create: { type: 'object', required: ['id', 'x'], properties: { id: { type: 'string' }, x: { type: 'string' } } } } },
      shelf: { path: '/shelf', schemas: { create: { type: 'object', required: ['x'], properties: { x: { type: 'string' },
        kind: { anyOf: [{ type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, { type: 'null' }], default: 'b' } } } } },
    },
    singletons: { me: { path: '/me', methods: ['GET'] }, tpl: { path: '/users/{u}/prefs' }, sub: { path: '/x', parent: 'tags' } },
  };
  const f6 = join(tmp, 'd6.json');
  writeFileSync(f6, JSON.stringify(d6));
  const r8 = await run([f6, '--to', 'postman', '--out', join(tmp, 'd6'), '--name', 'D6']);
  ok(r8.code === 0, `acepta "1.0-draft.6" (salió ${r8.code}: ${r8.err})`);
  const c6 = JSON.parse(readFileSync(join(tmp, 'd6', 'D6.postman_collection.json'), 'utf8'));
  const folder = (n) => c6.item.find((x) => x.name === n)?.item ?? [];
  const tags = folder('tags');
  ok(!tags.some((x) => x.name.includes(' geo ')) && tags.some((x) => x.request.url.raw.includes('filter[name]=ejemplo')) && !tags.some((x) => x.request.url.raw.includes('near')),
    'un filtro de tipo desconocido no se usa; de un filtro solo los operadores conocidos (§4.2)');
  ok(!tags.some((x) => /Acción (go|put)/.test(x.name)) && tags.some((x) => x.name.startsWith('Acción ok')), 'una acción con on o method desconocidos no se usa (§4.2)');
  const tagBody = JSON.parse(tags.find((x) => x.name === 'Crear en tags').request.body.raw);
  ok(/^[0-9a-f-]{36}$/.test(tagBody.id), 'id_from "client": el POST lleva un id aleatorio (§5.1)');
  ok(!('id' in JSON.parse(folder('notes').find((x) => x.name === 'Crear en notes').request.body.raw)), 'id_from desconocido: el POST no lleva id (§5.1)');
  ok(!('id' in JSON.parse(folder('plain').find((x) => x.name === 'Crear en plain').request.body.raw)), 'sin id_from: el POST no lleva id (§5.1)');
  ok(JSON.parse(folder('shelf').find((x) => x.name === 'Crear en shelf').request.body.raw).kind === 'b',
    'un escalar opcional con default y opciones oneOf de const va en el cuerpo, con su default (§4.3)');
  ok(!c6.item.flatMap((f) => f.item).some((x) => x.request.header.some((h) => h.key === 'Idempotency-Key')), '"anonymous": false sin credenciales: sin Idempotency-Key (§7.1)');
  const me = folder('me');
  ok(me.length === 1 && me[0].request.method === 'GET', 'recurso suelto con methods [GET]: solo GET');
  ok(!folder('tpl').length && !folder('sub').length && /tpl/.test(r8.err) && /sub/.test(r8.err), 'recurso suelto con plantilla o parent: se ignora y se avisa (§5.9)');
  for (const v of ['2.0', '1.0-beta', '01.0', '1']) {
    writeFileSync(f6, JSON.stringify({ ...d6, restep: v }));
    const r = await run([f6, '--out', join(tmp, 'v')]);
    ok(r.code === 2 && /Restep 1/.test(r.err), `"restep": "${v}" no es Restep 1: error claro (§1.1)`);
  }
  for (const v of ['1.0-rc.1', '1.3']) {
    writeFileSync(f6, JSON.stringify({ ...d6, restep: v }));
    ok((await run([f6, '--to', 'http', '--out', join(tmp, 'v')])).code === 0, `"restep": "${v}" se acepta`);
  }
  // service-desc a otro origen: se pide sin credenciales; a un esquema que no es https ni el de la raíz, no se pide.
  {
    const { createServer } = await import('node:http');
    const seen = [];
    const other = createServer((req, res) => { seen.push(req.headers.authorization ?? null); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ restep: '1.0-draft.6', collections: {} })); });
    await new Promise((r) => other.listen(8974, '127.0.0.1', r));
    const front = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', link: '<data:application/json,{"restep":"1.0"}>; rel="service-desc", <http://127.0.0.1:8974/d.json>; rel="service-desc"' }); res.end('<p>hola</p>'); });
    await new Promise((r) => front.listen(8975, '127.0.0.1', r));
    const r = await run(['http://localhost:8975/', '--to', 'http', '--out', join(tmp, 'sd'), '--token', 'secreto', '-H', 'X-Api-Key: otro']);
    ok(r.code === 0 && seen.length === 1 && seen[0] === null, `service-desc de otro origen: sin credenciales (§4.3), y el data: no se sigue (§3) (${r.err} ${JSON.stringify(seen)})`);
    other.close(); front.close();
  }

  console.log('7. Errores claros');
  const r5 = await run([join(tmp, 'no-existe.json'), '--out', join(tmp, 'y')]);
  ok(r5.code === 2 && /no existe/.test(r5.err), 'archivo inexistente');
  const r6 = await run([fx, '--to', 'insomnia', '--out', join(tmp, 'y')]);
  ok(r6.code === 2 && /Formato desconocido/.test(r6.err), 'formato desconocido');
  const r7 = await run([`http://localhost:${PORT}/books`, '--out', join(tmp, 'y')]);
  ok(r7.code === 2 && /descubrimiento/.test(r7.err), 'URL que no es la raíz');
} catch (e) {
  failed++;
  console.log(`  ERROR: ${e.stack}`);
} finally {
  for (const s of servers) s.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nrestep-export: ${passed} comprobaciones correctas, ${failed} fallidas.`);
process.exit(failed ? 1 : 0);
