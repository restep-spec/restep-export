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

const VERSION = '0.2.0';
const FORMATS = ['http', 'bruno', 'postman'];

const HELP = `restep-export ${VERSION} · peticiones de ejemplo a partir del descubrimiento de una API Restep 1

Uso: restep-export <url|discovery.json> --to <bruno|http|postman>[,…] --out <carpeta> [opciones]

  --to <formatos>        http, bruno o postman; varios separados por comas (por defecto, los tres)
  --out <carpeta>        Dónde escribir (por defecto ./restep-export). Con varios formatos,
                         una subcarpeta por formato
  --base-url <url>       Valor de base_url (por defecto, la raíz de la API; con un archivo,
                         http://localhost:8080)
  --name <nombre>        Nombre de la colección (por defecto, Restep <host>; con un archivo,
                         Restep)
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
// §1.1: la gramática de restep y la versión mayor. Un documento de otra versión mayor, o con un
// restep que no sigue la gramática, no es de Restep 1: no se exporta (ni se supone core).
const RESTEP_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(draft|rc)\.(0|[1-9][0-9]*))?$/;
export const isRestep1 = (d) => { const m = RESTEP_VERSION.exec(d.restep); return !!m && m[1] === '1'; };
// §3: solo se siguen enlaces https o del esquema de la raíz; las credenciales, solo al origen de la API (§4.3).
const allowedScheme = (u, root) => u.protocol === 'https:' || u.protocol === root.protocol;
// Valores que este cliente conoce (§4.2): lo que lleva otro se trata como no declarado.
const FILTER_TYPES = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'duration', 'enum'];
const FILTER_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'null'];
const ACTION_ON = ['item', 'collection'];

function linkTargets(header, rel) {
  if (!header) return [];
  return header.split(/,(?=\s*<)/).flatMap((part) => {
    const m = part.match(/<([^>]*)>(.*)/);
    if (!m) return [];
    const rels = (m[2].match(/rel="?([^";]+)"?/)?.[1] ?? '').split(/\s+/);
    return rels.includes(rel) ? [m[1]] : [];
  });
}

async function getJson(url, opts, { credentials = true } = {}) {
  const headers = { accept: 'application/json', ...(credentials ? opts.headers : {}) };
  if (opts.token && credentials) headers.authorization = `Bearer ${opts.token}`;
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
        let u;
        try { u = new URL(href, root); } catch { continue; }
        if (!allowedScheme(u, root)) continue;
        const d = await getJson(u.href, opts, { credentials: u.origin === root.origin });
        if (isDiscovery(d.data)) { res = d; break; }
      }
    }
    if (res.status === 401) throw new Error(`${root.href} responde 401: pasa --token o -H "Authorization: …".`);
    if (!isDiscovery(res.data)) throw new Error(`${root.href} no sirve un documento de descubrimiento (un objeto JSON con restep, §4.2); respondió ${res.status}.`);
    if (!isRestep1(res.data)) throw new Error(notRestep1(res.data));
    return { doc: res.data, origin: root.origin, root };
  }
  if (!existsSync(src)) throw new Error(`no existe el archivo ${src}.`);
  let doc;
  try { doc = JSON.parse(readFileSync(src, 'utf8')); } catch (e) { throw new Error(`${src} no es JSON válido: ${e.message}`); }
  if (!isDiscovery(doc)) throw new Error(`${src} no es un documento de descubrimiento: le falta el miembro restep (§4.2).`);
  if (!isRestep1(doc)) throw new Error(notRestep1(doc));
  return { doc, origin: null, root: null };
}

const notRestep1 = (d) => `el descubrimiento declara "restep": ${JSON.stringify(d.restep)}, que no es una versión de Restep 1 (§1.1); no se exporta.`;

// Un esquema puede ser un enlace (§4.3). Solo se piden los del mismo origen que la API.
async function resolveSchema(s, ctx, opts) {
  if (isObject(s)) return s;
  if (typeof s !== 'string' || !ctx.root) return null;
  try {
    const u = new URL(s, ctx.root);
    if (u.origin !== ctx.origin || !allowedScheme(u, ctx.root)) return null;
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
// Escalar: enum, const que no es objeto, un tipo escalar (aunque detalle sus valores con un
// oneOf de const, como las opciones de un formulario, apéndice A) o alternativas escalares.
function isScalar(s) {
  if (!isObject(s)) return false;
  if (Array.isArray(s.enum)) return true;
  if ('const' in s) return s.const === null || typeof s.const !== 'object';
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== 'null') : s.type === undefined ? [] : [s.type];
  if (t.length) return t.every((x) => ['string', 'integer', 'number', 'boolean'].includes(x));
  const alt = s.anyOf ?? s.oneOf;
  if (Array.isArray(alt)) return alt.filter((a) => !isNull(a)).every(isScalar);
  return false;
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
function filterValue(field, decl, coll, op) {
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

function includePaths(c, doc, prefix = '', depth = Number.isInteger(c.include_depth) && c.include_depth > 0 ? c.include_depth : 1, seen = new Set()) {
  const out = [];
  for (const [rel, r] of Object.entries(isObject(c.relations) ? c.relations : {})) {
    if (!isObject(r) || r.include !== true) continue;
    const p = prefix ? `${prefix}.${rel}` : rel;
    out.push(p);
    const target = typeof r.to === 'string' && isObject(doc.collections?.[r.to]) ? doc.collections[r.to] : null;
    if (depth > 1 && target && !seen.has(p)) out.push(...includePaths(target, doc, p, depth - 1, new Set([...seen, p])));
  }
  return out;
}

// Ids de ejemplo: el del primer elemento y, en una subcolección, los de sus padres (§4.2, §5.1).
async function findSamples(cname, coll, ctx, opts, samples, depth = 0) {
  if (samples.has(cname)) return samples.get(cname);
  const doc = ctx.doc;
  const vars = String(coll.path).match(/\{[^}]+\}/g) ?? [];
  const query = (doc.profiles ?? []).includes('query');
  const list = async (path, limit) => {
    const u = new URL(ctx.root.href.replace(/\/+$/, '') + path);
    if (query) u.searchParams.set('limit', String(limit));
    const r = await getJson(u.href, opts);
    return Array.isArray(r.data?.items) ? r.data.items.filter((x) => typeof x?.id === 'string' || typeof x?.id === 'number').map((x) => String(x.id)) : [];
  };
  const fill = (path, ids) => { let i = 0; return path.replace(/\{[^}]+\}/g, () => encodeURIComponent(ids[i++])); };
  let found = { id: null, vars: [] };
  try {
    if (!vars.length) found = { id: (await list(coll.path, 1))[0] ?? null, vars: [] };
    else {
      const parentName = typeof coll.parent === 'string' ? coll.parent : null;
      const parent = parentName && isObject(doc.collections?.[parentName]) ? doc.collections[parentName] : null;
      if (parent && depth < 4) {
        const ps = await findSamples(parentName, parent, ctx, opts, samples, depth + 1);
        if (ps.vars.length === vars.length - 1) {
          const max = Math.min(20, Number.isInteger(parent.max_limit) ? parent.max_limit : 20);
          const candidates = [...new Set([ps.id, ...(await list(fill(parent.path, ps.vars), max))].filter(Boolean))];
          for (const pid of candidates) {
            const ids = await list(fill(coll.path, [...ps.vars, pid]), 1);
            if (ids.length) { found = { id: ids[0], vars: [...ps.vars, pid] }; break; }
            if (!found.vars.length) found = { id: null, vars: [...ps.vars, pid] };
          }
        }
      }
    }
  } catch { /* sin ejemplo: las variables se quedan en 1 */ }
  samples.set(cname, found);
  return found;
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
  let vi = 0;
  const path = String(c.path).replace(/\{([^}]+)\}/g, (_, v) => {
    const key = `${name}_path_${v.replace(/[^A-Za-z0-9_]/g, '_')}`;
    ctx.vars[key] = String(c.pathSamples?.[vi++] ?? ctx.vars[key] ?? '1');
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
        // §4.2: un filtro de tipo desconocido, o un operador desconocido, no se usa.
        if (!isObject(decl) || !FILTER_TYPES.includes(decl.type)) continue;
        const ops = (Array.isArray(decl.ops) ? decl.ops : []).filter((o) => FILTER_OPS.includes(o));
        if (!ops.length) continue;
        const op = ops[0];
        const key = op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`;
        reqs.push({ name: `Filtrar ${name} por ${field} (${op})`, method: 'GET', path, query: [[key, filterValue(field, decl, c, op)], ['limit', String(limit)]], read: true,
          note: `Operadores declarados para ${field}: ${ops.join(', ')} (§6.1).` });
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
  // §9: una lectura con include de las relaciones que lo admiten y, hasta include_depth, las de sus
  // destinos. Una relación a varias colecciones (to como lista) solo va al final del camino.
  const incl = profiles.includes('relations') ? includePaths(c, ctx.doc) : [];
  if (incl.length && has(c.methods, 'GET')) {
    reqs.push({ name: `Incluir relaciones de ${name}`, method: 'GET', path, query: [['include', incl.join(',')], ...(query ? [['limit', String(limit)]] : [])], read: true,
      note: `Relaciones incluidas: ${incl.join(', ')} (§9). Una relación a varias colecciones lleva type en cada objeto, y una a un elemento de una subcolección, href (§3).` });
  }
  if (has(c.item_methods, 'GET')) {
    reqs.push({ name: `Obtener ${name}`, method: 'GET', path: item, query: [], read: true,
      note: writes ? `Guarda la ETag de la respuesta en ${etagVar} para usarla en If-Match (§7.2).` : null,
      save: writes ? { etag: etagVar } : undefined });
  }
  if (has(c.methods, 'POST')) {
    const headers = [['Content-Type', 'application/json']];
    if (ctx.idempotencyKeys) headers.push(['Idempotency-Key', `"${randomUUID()}"`]);
    // §5.1: con id_from "client" el POST lleva id (un UUID aleatorio, §13.6); con cualquier otro
    // valor, o sin él, no lo lleva: lo asigna el servidor ("either" lo admite, pero no hace falta)
    // y con un valor desconocido un cliente no DEBE mandarlo.
    const body = sample(c.schemasResolved.create ?? {});
    if (isObject(body)) { delete body.id; if (c.id_from === 'client') body.id = randomUUID(); }
    const notes = [];
    if (ctx.idempotencyKeys) notes.push('Repetir la petición con la misma Idempotency-Key no crea otro elemento (§7.1); cámbiala para crear otro.');
    else if (ctx.anonymousRefused) notes.push('Sin Idempotency-Key: la API la rechaza sin credenciales ("anonymous": false, §7.1).');
    if (c.id_from === 'client') notes.push('El id lo elige el cliente (id_from "client", §5.1): uno nuevo y aleatorio en cada alta.');
    reqs.push({ name: `Crear en ${name}`, method: 'POST', path, query: [], headers, body, note: notes.join(' ') || null });
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
      // §4.2: una acción con un on o un method desconocidos se trata como no declarada.
      if (!isObject(a) || !ACTION_ON.includes(a.on) || (a.method !== undefined && a.method !== 'GET' && a.method !== 'POST')) continue;
      const method = a.method === 'GET' ? 'GET' : 'POST';
      const target = `${a.on === 'collection' ? path : item}:${action}`;
      const headers = [];
      let body;
      if (method === 'POST') {
        const input = c.actionInputs?.[action];
        body = input ? sample(input) : {};
        headers.push(['Content-Type', 'application/json']);
        if (ctx.idempotencyKeys && a.idempotent === false) headers.push(['Idempotency-Key', `"${randomUUID()}"`]);
      }
      reqs.push({ name: `Acción ${action} (${a.on === 'collection' ? 'colección' : 'elemento'})`, method, path: target, query: [], headers, body,
        read: method === 'GET', note: [a.description, `safe: ${a.safe === true}, idempotent: ${a.idempotent === true} (§11.1).`].filter(Boolean).join(' ') });
    }
  }
  for (const r of reqs) r.headers = [['Accept', 'application/json'], ...(r.headers ?? [])];
  return reqs;
}

// Un recurso suelto (singleton, §5.9): GET y, si lo declara o no declara methods, PATCH con If-Match.
function buildSingletonRequests(name, prefix, sg, ctx) {
  const writes = (ctx.doc.profiles ?? []).includes('writes');
  const etagVar = `${prefix}_etag`;
  if (writes) ctx.vars[etagVar] ??= '';
  const has = (m) => !Array.isArray(sg.methods) || sg.methods.includes(m);
  const reqs = [{ name: `Obtener ${name}`, method: 'GET', path: sg.path, query: [], read: true,
    note: `Recurso suelto (§5.9).${writes ? ` Guarda la ETag en ${etagVar} para usarla en If-Match (§7.2).` : ''}`,
    save: writes ? { etag: etagVar } : undefined }];
  if (has('PATCH')) {
    const headers = [['Content-Type', 'application/merge-patch+json']];
    if (writes) headers.push(['If-Match', `{{${etagVar}}}`]);
    reqs.push({ name: `Actualizar ${name}`, method: 'PATCH', path: sg.path, query: [], headers,
      body: samplePatch(sg.schemasResolved.update, sg.schemasResolved.item),
      note: writes ? `Merge patch (§5.9). If-Match lleva la ETag de «Obtener ${name}» (§7.2).` : 'Merge patch (§5.9).' });
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
  // §2: las rutas del descubrimiento son relativas a la raíz de la API, que puede tener ruta (/api/).
  const baseUrl = opts.baseUrl ?? (ctx.root ? ctx.root.href.replace(/\/+$/, '') : 'http://localhost:8080');
  const auth = opts.auth === 'bearer' || (opts.auth === 'auto' && (doc.extensions ?? []).includes('oauth'));
  const name = opts.name ?? (ctx.root ? `Restep ${ctx.root.host}` : 'Restep');
  // §7.1: con "anonymous": false, una petición sin credenciales no lleva Idempotency-Key.
  ctx.anonymousRefused = isObject(doc.idempotency) && doc.idempotency.anonymous === false && !auth && !opts.token && !opts.headers.authorization;
  ctx.idempotencyKeys = (doc.profiles ?? []).includes('writes') && !ctx.anonymousRefused;
  const collections = [];
  const samples = new Map(); // nombre de colección → { id, vars: [id de cada padre] }
  for (const [cname, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string') { console.error(`restep-export: aviso: ${cname} no tiene path; se omite.`); continue; }
    const schemas = isObject(c.schemas) ? c.schemas : {};
    const coll = { ...c, schemasResolved: {} };
    for (const k of ['item', 'create', 'update']) coll.schemasResolved[k] = await resolveSchema(schemas[k], ctx, opts);
    coll.actionInputs = {};
    for (const [a, decl] of Object.entries(isObject(c.actions) ? c.actions : {})) coll.actionInputs[a] = await resolveSchema(decl?.input, ctx, opts);
    // Un id de ejemplo por colección, del primer elemento. En una subcolección (§4.2: plantilla y
    // parent) las variables toman los id de sus padres: se buscan, entre los primeros elementos del
    // padre, uno cuya subcolección tenga algún elemento, para que «Obtener» no dé 404.
    if (ctx.root && opts.samples) {
      const found = await findSamples(cname, c, ctx, opts, samples);
      if (found.id) coll.sampleId = found.id;
      if (found.vars.length) coll.pathSamples = found.vars;
    }
    const before = new Set(Object.keys(ctx.vars));
    const requests = buildRequests(cname, coll, ctx);
    const varNames = Object.keys(ctx.vars).filter((k) => !before.has(k) || k.startsWith(`${cname}_`));
    collections.push({ name: cname, description: typeof c.description === 'string' ? c.description : null, requests, varNames });
  }
  // Recursos sueltos (§5.9). Uno cuya ruta es una plantilla o que lleva parent se ignora: son formas
  // reservadas para versiones menores.
  for (const [sname, sg] of Object.entries(isObject(doc.singletons) ? doc.singletons : {})) {
    if (!isObject(sg) || typeof sg.path !== 'string' || !sg.path.startsWith('/') || /[{}]/.test(sg.path) || 'parent' in sg) {
      console.error(`restep-export: aviso: el recurso suelto ${sname} no tiene una ruta fija o lleva parent; se ignora (§5.9).`);
      continue;
    }
    const schemas = isObject(sg.schemas) ? sg.schemas : {};
    const s = { ...sg, schemasResolved: {} };
    for (const k of ['item', 'update']) s.schemasResolved[k] = await resolveSchema(schemas[k], ctx, opts);
    const folder = collections.some((c) => c.name === sname) ? `${sname}-recurso` : sname;
    const prefix = folder.replace(/[^A-Za-z0-9_]/g, '_');
    const before = new Set(Object.keys(ctx.vars));
    const requests = buildSingletonRequests(sname, prefix, s, ctx);
    const varNames = Object.keys(ctx.vars).filter((k) => !before.has(k) || k.startsWith(`${prefix}_`));
    collections.push({ name: folder, description: typeof sg.description === 'string' ? sg.description : null, requests, varNames, singleton: true });
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
