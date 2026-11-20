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

  console.log('2. Peticiones de lectura de los .http contra el servidor');
  const h = await execHttpReads(join(out, 'http'));
  ok(h.reads >= collections.length * 3, `se ejecutan lecturas (${h.reads} de ${h.total})`);

  console.log('3. Las escrituras de ejemplo son aceptables: crear y actualizar con la ETag');
  const createBody = JSON.parse(byName('Crear en books').body.raw);
  const cr = await fetch(`http://localhost:${PORT}/books`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `"${crypto.randomUUID()}"` }, body: JSON.stringify(createBody) });
  ok(cr.status === 201, `el cuerpo de crear de books lo acepta el servidor (${cr.status})`);
  const created = await cr.json();
  const etag = cr.headers.get('etag');
  const pr = await fetch(`http://localhost:${PORT}/books/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json', 'if-match': etag }, body: byName('Actualizar books').body.raw });
  ok(pr.status === 200, `el cuerpo de actualizar de books lo acepta el servidor (${pr.status})`);
  await fetch(`http://localhost:${PORT}/books/${created.id}`, { method: 'DELETE' });

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

  console.log('6. Errores claros');
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
