#!/usr/bin/env node
// restep-export · Genera una colección de peticiones de ejemplo a partir del documento de
// descubrimiento de una API Restep 1 (§4.2): archivos .http (REST Client de VS Code y cliente HTTP
// de JetBrains), colección de Bruno (.bru) o colección de Postman v2.1.
// Node 18 o posterior, sin dependencias.  Especificación: https://restep.wubytes.com/1/
//
//   node restep-export.mjs http://localhost:8080/ --to http --out peticiones
//   node restep-export.mjs discovery.json --to bruno,postman --out exportado --base-url https://api.example.com

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = '0.1.0';
const FORMATS = ['http', 'bruno', 'postman'];

const HELP = `restep-export ${VERSION} · peticiones de ejemplo a partir del descubrimiento de una API Restep 1

Uso: restep-export <url|discovery.json> --to <bruno|http|postman>[,…] --out <carpeta> [opciones]

  --to <formatos>        http, bruno o postman; varios separados por comas (por defecto, los tres)
  --out <carpeta>        Dónde escribir (por defecto ./restep-export). Con varios formatos,
                         una subcarpeta por formato
  --base-url <url>       Valor de base_url (por defecto, el origen de la URL; con un archivo,
                         http://localhost:8080)
  --name <nombre>        Nombre de la colección (por defecto, el host)
  --auth <auto|bearer|none>  Cabecera Authorization: Bearer {{token}}. auto: solo si la API
                         anuncia la extensión oauth (por defecto)
  --token <token>        Token para leer el descubrimiento y los ejemplos de la API. No se
                         escribe en los archivos generados
  -H, --header "N: v"    Cabecera extra al leer la API (repetible). Tampoco se escribe
  --no-samples           No pide a la API un id de ejemplo por colección
  -h, --help             Esta ayuda

Variables de entorno de la colección: base_url y token, más <coleccion>_id (un id de ejemplo)
y, con writes, <coleccion>_etag (para If-Match).

Código de salida: 0 si ha escrito todo, 2 si no puede (argumentos, red o documento no válido).`;

// ── Argumentos ────────────────────────────────────────────────────────────────
function fail(msg, code = 2) { console.error(`restep-export: ${msg}`); process.exit(code); }
function usage(msg) { console.error(`${msg}\n\n${HELP}`); process.exit(2); }

function parseArgs(argv) {
  const o = { to: [], out: 'restep-export', baseUrl: null, name: null, auth: 'auto', token: null, headers: {}, samples: true, source: null };
  const value = (i) => { if (argv[i + 1] === undefined) usage(`${argv[i]} necesita un valor.`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (a === '--to') o.to.push(...value(i++).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--out') o.out = value(i++);
    else if (a === '--base-url') o.baseUrl = value(i++);
    else if (a === '--name') o.name = value(i++);
    else if (a === '--auth') o.auth = value(i++);
    else if (a === '--token') o.token = value(i++);
    else if (a === '--no-samples') o.samples = false;
    else if (a === '-H' || a === '--header') {
      const v = value(i++), c = v.indexOf(':');
      if (c < 1) usage(`Cabecera sin dos puntos: ${v}`);
      o.headers[v.slice(0, c).trim().toLowerCase()] = v.slice(c + 1).trim();
    } else if (a.startsWith('-')) usage(`Opción desconocida: ${a}`);
    else if (o.source) usage(`Solo se admite un origen: ${a}`);
    else o.source = a;
  }
  if (!o.source) usage('Falta la URL de la API o el archivo de descubrimiento.');
  if (!o.to.length) o.to = [...FORMATS];
  for (const f of o.to) if (!FORMATS.includes(f)) usage(`Formato desconocido: ${f}. Usa ${FORMATS.join(', ')}.`);
  if (!['auto', 'bearer', 'none'].includes(o.auth)) usage(`--auth admite auto, bearer o none, no ${o.auth}.`);
  if (o.baseUrl) {
    try { new URL(o.baseUrl); } catch { usage(`--base-url no es una URL: ${o.baseUrl}`); }
    o.baseUrl = o.baseUrl.replace(/\/+$/, '');
  }
  return o;
}

// ── Lectura del descubrimiento (§4.2) ─────────────────────────────────────────
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDiscovery = (d) => isObject(d) && typeof d.restep === 'string';

function linkTargets(header, rel) {
  if (!header) return [];
  return header.split(/,(?=\s*<)/).flatMap((part) => {
    const m = part.match(/<([^>]*)>(.*)/);
    if (!m) return [];
    const rels = (m[2].match(/rel="?([^";]+)"?/)?.[1] ?? '').split(/\s+/);
    return rels.includes(rel) ? [m[1]] : [];
  });
}

async function getJson(url, opts) {
  const headers = { accept: 'application/json', ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res;
  try { res = await fetch(url, { headers }); } catch (e) { throw new Error(`no se puede conectar con ${url}: ${e.cause?.message ?? e.message}`); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* no es JSON */ }
  return { status: res.status, headers: res.headers, data };
}

async function loadDiscovery(opts) {
  const src = opts.source;
  if (/^https?:\/\//i.test(src)) {
    const root = new URL(src);
    if (!root.pathname.endsWith('/')) root.pathname += '/';
    let res = await getJson(root.href, opts);
    if (!isDiscovery(res.data)) {
      // §4.2: si la raíz está ocupada, el documento se enlaza con rel="service-desc".
      for (const href of linkTargets(res.headers.get('link'), 'service-desc')) {
        const d = await getJson(new URL(href, root).href, opts);
        if (isDiscovery(d.data)) { res = d; break; }
      }
    }
    if (res.status === 401) throw new Error(`${root.href} responde 401: pasa --token o -H "Authorization: …".`);
    if (!isDiscovery(res.data)) throw new Error(`${root.href} no sirve un documento de descubrimiento (un objeto JSON con restep, §4.2); respondió ${res.status}.`);
    return { doc: res.data, origin: root.origin, root };
  }
  if (!existsSync(src)) throw new Error(`no existe el archivo ${src}.`);
  let doc;
  try { doc = JSON.parse(readFileSync(src, 'utf8')); } catch (e) { throw new Error(`${src} no es JSON válido: ${e.message}`); }
  if (!isDiscovery(doc)) throw new Error(`${src} no es un documento de descubrimiento: le falta el miembro restep (§4.2).`);
  return { doc, origin: null, root: null };
}

// Un esquema puede ser un enlace (§4.3). Solo se piden los del mismo origen que la API.
async function resolveSchema(s, ctx, opts) {
  if (isObject(s)) return s;
  if (typeof s !== 'string' || !ctx.root) return null;
  try {
    const u = new URL(s, ctx.root);
    if (u.origin !== ctx.origin) return null;
    const r = await getJson(u.href, opts);
    return r.status === 200 && isObject(r.data) ? r.data : null;
  } catch { return null; }
}

// ── Valores de ejemplo ────────────────────────────────────────────────────────
const STRING_CANDIDATES = ['ejemplo', '10.00', '1', '2026-01-01', '2026-01-01T10:00:00Z', 'PT1H', 'es'];

function sampleString(s) {
  if (s.format === 'date') return '2026-01-01';
  if (s.format === 'date-time') return '2026-01-01T10:00:00Z';
  if (s.format === 'email') return 'ana@example.com';
  if (s.format === 'uri') return 'https://example.com/';
  if (s.format === 'uuid') return randomUUID();
  if (typeof s.pattern === 'string') {
    let re;
    try { re = new RegExp(s.pattern, 'u'); } catch { return 'ejemplo'; }
    return STRING_CANDIDATES.find((c) => re.test(c)) ?? 'ejemplo';
  }
  return 'ejemplo';
}

// Un ejemplo que cumpla el esquema en lo sencillo (tipo, enum, patrón, requeridos). Con
// writable, un objeto lleva sus requeridos y sus campos escalares opcionales que no son de
// solo lectura ni empiezan por _; los objetos opcionales (relaciones, mapas de idioma) se omiten.
function sample(schema, depth = 0) {
  if (!isObject(schema) || depth > 5) return 'ejemplo';
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => v !== null) ?? schema.enum[0];
  const alt = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alt) && alt.length) return sample(alt.find((a) => !isNull(a)) ?? alt[0], depth + 1);
  if (Array.isArray(schema.allOf) && schema.allOf.length) return sample(Object.assign({}, ...schema.allOf.filter(isObject)), depth + 1);
  let type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  if (!type) type = schema.properties ? 'object' : 'string';
  switch (type) {
    case 'string': return sampleString(schema);
    case 'integer': return Math.max(1, schema.minimum ?? 1);
    case 'number': return Math.max(1.5, schema.minimum ?? 1.5);
    case 'boolean': return true;
    case 'null': return null;
    case 'array': return [sample(schema.items, depth + 1)];
    case 'object': {
      const out = {};
      const props = isObject(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const [k, p] of Object.entries(props)) {
        if (k.startsWith('_') || p?.readOnly) continue;
        if (required.includes(k) || (depth === 0 && isScalar(p) && k !== 'id')) out[k] = sample(p, depth + 1);
      }
      if (!Object.keys(props).length && isObject(schema.additionalProperties)) out.es = sample(schema.additionalProperties, depth + 1);
      return out;
    }
    default: return 'ejemplo';
  }
}
const isNull = (s) => isObject(s) && (s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null'));
function isScalar(s) {
  if (!isObject(s)) return false;
  if (Array.isArray(s.enum)) return true;
  const alt = s.anyOf ?? s.oneOf;
  if (Array.isArray(alt)) return alt.filter((a) => !isNull(a)).every(isScalar);
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null') : [s.type];
  return t.length > 0 && t.every((x) => ['string', 'integer', 'number', 'boolean'].includes(x));
}

// El cuerpo de un PATCH de ejemplo: un solo campo escalar que se pueda escribir (merge patch).
function samplePatch(update, create) {
  for (const s of [update, create]) {
    if (!isObject(s?.properties)) continue;
    for (const [k, p] of Object.entries(s.properties)) {
      if (k === 'id' || k.startsWith('_') || p?.readOnly || !isScalar(p)) continue;
      return { [k]: sample(p, 1) };
    }
  }
  return {};
}

// Valor de ejemplo para un filtro (§6.1), según su tipo declarado.
function filterValue(field, decl, coll) {
  const op = decl.ops?.[0] ?? 'eq';
  if (op === 'null') return 'true';
  const one = (i = 0) => {
    switch (decl.type) {
      case 'enum': return String(decl.values?.[i % (decl.values?.length || 1)] ?? 'ejemplo');
      case 'integer': return String(2000 + i);
      case 'number': return String(3 + i);
      case 'decimal': return (10 + i * 5).toFixed(2);
      case 'boolean': return 'true';
      case 'date': return '2026-01-01';
      case 'datetime': return '2026-01-01T10:00:00Z';
      case 'duration': return 'PT1H';
      default:
        if (field === 'id' || field.endsWith('.id')) return field === 'id' && coll.sampleId ? String(coll.sampleId) : String(i + 1);
        return 'ejemplo';
    }
  };
  if (op === 'in') return decl.type === 'boolean' ? 'true,false' : `${one(0)},${one(1)}`;
  return one(0);
}

// ── Modelo intermedio: una lista de peticiones por colección ──────────────────
// Cada petición: { name, method, path (con {{variables}}), query: [[k, v]], headers: [[k, v]],
//   body (objeto o undefined), contentType, read (true si es de lectura), note, save: {etag|next} }
function buildRequests(name, c, ctx) {
  const reqs = [];
  const profiles = ctx.doc.profiles ?? [];
  const query = profiles.includes('query');
  const writes = profiles.includes('writes');
  const actionsExt = (ctx.doc.extensions ?? []).includes('actions');
  // Plantilla de URI (§4.2): {id} → {{variable}}; las variables entran en el entorno.
  const path = String(c.path).replace(/\{([^}]+)\}/g, (_, v) => {
    const key = `${name}_path_${v.replace(/[^A-Za-z0-9_]/g, '_')}`;
    ctx.vars[key] ??= '1';
    return `{{${key}}}`;
  });
  const idVar = `${name}_id`, etagVar = `${name}_etag`;
  ctx.vars[idVar] = String(c.sampleId ?? ctx.vars[idVar] ?? '1');
  if (writes) ctx.vars[etagVar] ??= '';
  const item = `${path}/{{${idVar}}}`;
  const has = (list, m) => !Array.isArray(list) || list.includes(m);
  const limit = Math.min(10, Number.isInteger(c.max_limit) ? c.max_limit : 10);

  if (has(c.methods, 'GET')) {
    reqs.push({ name: `Listar ${name}`, method: 'GET', path, query: query ? [['limit', String(limit)]] : [], read: true,
      note: 'Pagina siguiendo next de la respuesta hasta que sea null; el cursor es opaco (§5.2, §6.4).', save: { next: `${name}_next` } });
    if (query) {
      for (const [field, decl] of Object.entries(isObject(c.filter) ? c.filter : {})) {
        if (!isObject(decl)) continue;
        const op = Array.isArray(decl.ops) && decl.ops.length ? decl.ops[0] : 'eq';
        const key = op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`;
        reqs.push({ name: `Filtrar ${name} por ${field} (${op})`, method: 'GET', path, query: [[key, filterValue(field, decl, c)], ['limit', String(limit)]], read: true,
          note: `Operadores declarados para ${field}: ${(decl.ops ?? ['eq']).join(', ')} (§6.1).` });
      }
      const sort = Array.isArray(c.sort) ? c.sort.filter((s) => typeof s === 'string') : [];
      if (sort.length) {
        const keys = sort.filter((s) => s !== 'id').slice(0, 2);
        const value = keys.length ? [`-${keys[0]}`, ...keys.slice(1)].join(',') : '-id';
        reqs.push({ name: `Ordenar ${name}`, method: 'GET', path, query: [['sort', value], ['limit', String(limit)]], read: true,
          note: `Claves de orden declaradas: ${sort.join(', ')}; - delante para descendente (§6.2).` });
      }
      const fields = pickFields(c, ctx);
      if (fields.length) {
        reqs.push({ name: `Campos de ${name}`, method: 'GET', path, query: [['fields', fields.join(',')], ['limit', String(limit)]], read: true,
          note: 'Solo esos campos, más id y los miembros que empiezan por _ (§6.3).' });
      }
      if (c.count === 'exact' || c.count === 'estimated') {
        reqs.push({ name: `Contar ${name}`, method: 'GET', path, query: [['count', 'true'], ['limit', '1']], read: true,
          note: `Añade total${c.count === 'estimated' ? ' y total_estimated' : ''} (§6.5).` });
      }
    }
  }
  if (has(c.item_methods, 'GET')) {
    reqs.push({ name: `Obtener ${name}`, method: 'GET', path: item, query: [], read: true,
      note: writes ? `Guarda la ETag de la respuesta en ${etagVar} para usarla en If-Match (§7.2).` : null,
      save: writes ? { etag: etagVar } : undefined });
  }
  if (has(c.methods, 'POST')) {
    const headers = [['Content-Type', 'application/json']];
    if (writes) headers.push(['Idempotency-Key', `"${randomUUID()}"`]);
    reqs.push({ name: `Crear en ${name}`, method: 'POST', path, query: [], headers, body: sample(c.schemasResolved.create ?? {}),
      note: writes ? 'Repetir la petición con la misma Idempotency-Key no crea otro elemento (§7.1); cámbiala para crear otro.' : null });
  }
  if (has(c.item_methods, 'PATCH')) {
    const headers = [['Content-Type', 'application/merge-patch+json']];
    if (writes) headers.push(['If-Match', `{{${etagVar}}}`]);
    reqs.push({ name: `Actualizar ${name}`, method: 'PATCH', path: item, query: [], headers,
      body: samplePatch(c.schemasResolved.update, c.schemasResolved.create),
      note: writes ? `Merge patch (§4.3). If-Match lleva la ETag de «Obtener ${name}», con sus comillas (§7.2).` : 'Merge patch (§4.3).' });
  }
  if (has(c.item_methods, 'DELETE')) {
    const headers = writes ? [['If-Match', `{{${etagVar}}}`]] : [];
    reqs.push({ name: `Borrar ${name}`, method: 'DELETE', path: item, query: [], headers,
      note: writes ? `If-Match lleva la ETag de «Obtener ${name}» (§7.2).` : null });
  }
  if (actionsExt && isObject(c.actions)) {
    for (const [action, a] of Object.entries(c.actions)) {
      if (!isObject(a)) continue;
      const method = a.method === 'GET' ? 'GET' : 'POST';
      const target = `${a.on === 'collection' ? path : item}:${action}`;
      const headers = [];
      let body;
      if (method === 'POST') {
        const input = c.actionInputs?.[action];
        body = input ? sample(input) : {};
        headers.push(['Content-Type', 'application/json']);
        if (writes && a.idempotent === false) headers.push(['Idempotency-Key', `"${randomUUID()}"`]);
      }
      reqs.push({ name: `Acción ${action} (${a.on === 'collection' ? 'colección' : 'elemento'})`, method, path: target, query: [], headers, body,
        read: method === 'GET', note: [a.description, `safe: ${a.safe === true}, idempotent: ${a.idempotent === true} (§10.1).`].filter(Boolean).join(' ') });
    }
  }
  for (const r of reqs) r.headers = [['Accept', 'application/json'], ...(r.headers ?? [])];
  return reqs;
}

function pickFields(c, ctx) {
  const props = isObject(c.schemasResolved.item?.properties) ? Object.keys(c.schemasResolved.item.properties) : [];
  const pool = props.length ? props : [...Object.keys(isObject(c.filter) ? c.filter : {}), ...(Array.isArray(c.sort) ? c.sort : [])];
  // §6.3: una ruta que entra en un mapa de idioma da invalid_parameter; solo campos de primer nivel.
  return [...new Set(pool.filter((f) => typeof f === 'string' && f !== 'id' && !f.includes('.') && !f.startsWith('_')))].slice(0, 2);
}

// ── Formato .http (REST Client y JetBrains) ───────────────────────────────────
const enc = (v) => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':');
const encKey = (k) => k.replace(/[^A-Za-z0-9_.\-[\]]/g, (ch) => encodeURIComponent(ch));
const queryString = (q) => (q.length ? `?${q.map(([k, v]) => `${encKey(k)}=${enc(v)}`).join('&')}` : '');

function toHttp(model, out) {
  mkdirSync(out, { recursive: true });
  for (const coll of model.collections) {
    const lines = [`# ${model.name} · ${coll.name}`, `# Generado por restep-export ${VERSION} a partir del descubrimiento (Restep ${model.doc.restep}).`];
    if (coll.description) lines.push(`# ${coll.description}`);
    lines.push('# base_url y token salen del entorno (http-client.env.json o .vscode/settings.json).', '');
    for (const k of coll.varNames) lines.push(`@${k} = ${model.vars[k]}`);
    lines.push('');
    for (const r of coll.requests) {
      lines.push(`### ${r.name}`);
      if (r.note) lines.push(`# ${r.note}`);
      lines.push(`${r.method} {{base_url}}${r.path}${queryString(r.query)}`);
      for (const [k, v] of r.headers) lines.push(`${k}: ${v}`);
      if (model.auth) lines.push('Authorization: Bearer {{token}}');
      if (r.body !== undefined) lines.push('', JSON.stringify(r.body, null, 2));
      lines.push('', '');
    }
    writeFileSync(join(out, `${fileName(coll.name)}.http`), lines.join('\n'));
  }
  const env = { base_url: model.baseUrl, token: '' };
  // JetBrains: http-client.env.json (el token, mejor en http-client.private.env.json, que no se versiona).
  writeFileSync(join(out, 'http-client.env.json'), JSON.stringify({ local: env }, null, 2) + '\n');
  writeFileSync(join(out, 'http-client.private.env.json'), JSON.stringify({ local: { token: '' } }, null, 2) + '\n');
  // VS Code REST Client: entornos en la configuración del espacio de trabajo.
  mkdirSync(join(out, '.vscode'), { recursive: true });
  writeFileSync(join(out, '.vscode', 'settings.json'), JSON.stringify({ 'rest-client.environmentVariables': { local: env } }, null, 2) + '\n');
}

// ── Formato Bruno (.bru) ──────────────────────────────────────────────────────
const bruIndent = (text, n = 2) => text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

function toBruno(model, out) {
  mkdirSync(join(out, 'environments'), { recursive: true });
  writeFileSync(join(out, 'bruno.json'), JSON.stringify({ version: '1', name: model.name, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2) + '\n');
  const envVars = { base_url: model.baseUrl, token: '', ...model.vars };
  writeFileSync(join(out, 'environments', 'local.bru'),
    `vars {\n${Object.entries(envVars).filter(([k]) => k !== 'token').map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}\n\nvars:secret [\n  token\n]\n`);
  model.collections.forEach((coll, ci) => {
    const dir = join(out, fileName(coll.name));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'folder.bru'), `meta {\n  name: ${coll.name}\n  seq: ${ci + 1}\n}\n`);
    coll.requests.forEach((r, i) => {
      const hasBody = r.body !== undefined;
      const parts = [`meta {\n  name: ${r.name}\n  type: http\n  seq: ${i + 1}\n}`];
      parts.push(`${r.method.toLowerCase()} {\n  url: {{base_url}}${r.path}${queryString(r.query)}\n  body: ${hasBody ? 'json' : 'none'}\n  auth: ${model.auth ? 'bearer' : 'none'}\n}`);
      if (r.query.length) parts.push(`params:query {\n${r.query.map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}`);
      if (r.headers.length) parts.push(`headers {\n${r.headers.map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n}`);
      if (model.auth) parts.push('auth:bearer {\n  token: {{token}}\n}');
      if (hasBody) parts.push(`body:json {\n${bruIndent(JSON.stringify(r.body, null, 2))}\n}`);
      const script = [];
      if (r.save?.etag) script.push(`const etag = res.getHeader('etag');`, `if (etag) bru.setVar('${r.save.etag}', etag);`);
      if (r.save?.next) script.push(`if (res.getBody()?.next) bru.setVar('${r.save.next}', res.getBody().next);`);
      if (script.length) parts.push(`script:post-response {\n${bruIndent(script.join('\n'))}\n}`);
      if (r.note) parts.push(`docs {\n${bruIndent(r.note)}\n}`);
      writeFileSync(join(dir, `${fileName(r.name)}.bru`), parts.join('\n\n') + '\n');
    });
  });
}

// ── Formato Postman v2.1 ──────────────────────────────────────────────────────
function postmanUrl(r) {
  const raw = `{{base_url}}${r.path}${queryString(r.query)}`;
  return { raw, host: ['{{base_url}}'], path: r.path.split('/').filter(Boolean), ...(r.query.length && { query: r.query.map(([key, value]) => ({ key, value })) }) };
}

function toPostman(model, out) {
  mkdirSync(out, { recursive: true });
  const col = {
    info: {
      _postman_id: randomUUID(), name: model.name,
      description: `Generado por restep-export ${VERSION} a partir del descubrimiento (Restep ${model.doc.restep}).`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    ...(model.auth && { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] } }),
    variable: [['base_url', model.baseUrl], ['token', ''], ...Object.entries(model.vars)].map(([key, value]) => ({ key, value: String(value) })),
    item: model.collections.map((coll) => ({
      name: coll.name,
      ...(coll.description && { description: coll.description }),
      item: coll.requests.map((r) => {
        const exec = [];
        if (r.save?.etag) exec.push(`const etag = pm.response.headers.get('ETag');`, `if (etag) pm.collectionVariables.set('${r.save.etag}', etag);`);
        if (r.save?.next) exec.push(`const next = pm.response.json().next;`, `if (next) pm.collectionVariables.set('${r.save.next}', next);`);
        return {
          name: r.name,
          ...(exec.length && { event: [{ listen: 'test', script: { type: 'text/javascript', exec } }] }),
          request: {
            method: r.method,
            header: r.headers.map(([key, value]) => ({ key, value })),
            ...(r.body !== undefined && { body: { mode: 'raw', raw: JSON.stringify(r.body, null, 2), options: { raw: { language: 'json' } } } }),
            url: postmanUrl(r),
            ...(r.note && { description: r.note }),
          },
        };
      }),
    })),
  };
  writeFileSync(join(out, `${fileName(model.name)}.postman_collection.json`), JSON.stringify(col, null, 2) + '\n');
}

const fileName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'coleccion';

// ── Principal ─────────────────────────────────────────────────────────────────
export async function exportCollection(opts) {
  const ctx = await loadDiscovery(opts);
  ctx.vars = {};
  const { doc } = ctx;
  const baseUrl = opts.baseUrl ?? ctx.origin ?? 'http://localhost:8080';
  const auth = opts.auth === 'bearer' || (opts.auth === 'auto' && (doc.extensions ?? []).includes('oauth'));
  const name = opts.name ?? (ctx.root ? `Restep ${ctx.root.host}` : 'Restep');
  const collections = [];
  for (const [cname, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string') { console.error(`restep-export: aviso: ${cname} no tiene path; se omite.`); continue; }
    const schemas = isObject(c.schemas) ? c.schemas : {};
    const coll = { ...c, schemasResolved: {} };
    for (const k of ['item', 'create', 'update']) coll.schemasResolved[k] = await resolveSchema(schemas[k], ctx, opts);
    coll.actionInputs = {};
    for (const [a, decl] of Object.entries(isObject(c.actions) ? c.actions : {})) coll.actionInputs[a] = await resolveSchema(decl?.input, ctx, opts);
    // Un id de ejemplo por colección, del primer elemento (solo colecciones sin plantilla).
    if (ctx.root && opts.samples && !c.path.includes('{')) {
      try {
        const u = new URL(c.path, ctx.root);
        if ((doc.profiles ?? []).includes('query')) u.searchParams.set('limit', '1');
        const r = await getJson(u.href, opts);
        const first = Array.isArray(r.data?.items) ? r.data.items[0] : null;
        if (first && (typeof first.id === 'string' || typeof first.id === 'number')) coll.sampleId = String(first.id);
      } catch { /* sin ejemplo: se queda en 1 */ }
    }
    const before = new Set(Object.keys(ctx.vars));
    const requests = buildRequests(cname, coll, ctx);
    const varNames = Object.keys(ctx.vars).filter((k) => !before.has(k) || k.startsWith(`${cname}_`));
    collections.push({ name: cname, description: typeof c.description === 'string' ? c.description : null, requests, varNames });
  }
  if (!collections.length) console.error('restep-export: aviso: el descubrimiento no declara colecciones; solo se escriben los entornos.');
  const model = { name, doc, baseUrl, auth, vars: ctx.vars, collections };
  const out = resolve(opts.out);
  const written = [];
  for (const f of opts.to) {
    const dir = opts.to.length > 1 ? join(out, f) : out;
    ({ http: toHttp, bruno: toBruno, postman: toPostman })[f](model, dir);
    written.push([f, dir]);
  }
  return { model, written };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const { model, written } = await exportCollection(opts);
    const n = model.collections.reduce((s, c) => s + c.requests.length, 0);
    for (const [f, dir] of written) console.log(`${f}: ${dir}`);
    console.log(`${model.collections.length} colecciones, ${n} peticiones.`);
  } catch (e) { fail(e.message); }
}
