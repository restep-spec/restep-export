#!/usr/bin/env node
// restep-export · Generates a collection of sample requests from the discovery document of a
// Restep 1 API (§4.2): .http files (VS Code REST Client and the JetBrains HTTP client),
// a Bruno collection (.bru) or a Postman v2.1 collection.
// Node 18 or later, no dependencies.  Specification: https://restep.wubytes.com/1/
//
//   node restep-export.mjs http://localhost:8080/ --to http --out requests
//   node restep-export.mjs discovery.json --to bruno,postman --out exported --base-url https://api.example.com

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = '0.3.0';
const FORMATS = ['http', 'bruno', 'postman'];

const HELP = `restep-export ${VERSION} · sample requests from the discovery document of a Restep 1 API

Usage: restep-export <url|discovery.json> --to <bruno|http|postman>[,…] --out <folder> [options]

  --to <formats>         http, bruno or postman; several separated by commas (default: all three)
  --out <folder>         Where to write (default ./restep-export). With several formats,
                         one subfolder per format
  --base-url <url>       Value of base_url (default: the API root; with a file,
                         http://localhost:8080)
  --name <name>          Collection name (default: Restep <host>; with a file,
                         Restep)
  --auth <auto|bearer|none>  Authorization: Bearer {{token}} header. auto: only if the API
                         announces the oauth extension (default)
  --token <token>        Token to read the discovery document and the API's samples. It is
                         not written to the generated files
  -H, --header "N: v"    Extra header when reading the API (repeatable). Not written either
  --no-samples           Do not ask the API for a sample id per collection
  -h, --help             This help

Collection environment variables: base_url and token, plus <collection>_id (a sample id)
and, with writes, <collection>_etag (for If-Match).

Exit code: 0 if everything was written, 2 if it cannot (arguments, network or invalid document).`;

// ── Arguments ─────────────────────────────────────────────────────────────────
function fail(msg, code = 2) { console.error(`restep-export: ${msg}`); process.exit(code); }
function usage(msg) { console.error(`${msg}\n\n${HELP}`); process.exit(2); }

function parseArgs(argv) {
  const o = { to: [], out: 'restep-export', baseUrl: null, name: null, auth: 'auto', token: null, headers: {}, samples: true, source: null };
  const value = (i) => { if (argv[i + 1] === undefined) usage(`${argv[i]} needs a value.`); return argv[i + 1]; };
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
      if (c < 1) usage(`Header without a colon: ${v}`);
      o.headers[v.slice(0, c).trim().toLowerCase()] = v.slice(c + 1).trim();
    } else if (a.startsWith('-')) usage(`Unknown option: ${a}`);
    else if (o.source) usage(`Only one source is accepted: ${a}`);
    else o.source = a;
  }
  if (!o.source) usage('Missing the API URL or the discovery file.');
  if (!o.to.length) o.to = [...FORMATS];
  for (const f of o.to) if (!FORMATS.includes(f)) usage(`Unknown format: ${f}. Use ${FORMATS.join(', ')}.`);
  if (!['auto', 'bearer', 'none'].includes(o.auth)) usage(`--auth accepts auto, bearer or none, not ${o.auth}.`);
  if (o.baseUrl) {
    try { new URL(o.baseUrl); } catch { usage(`--base-url is not a URL: ${o.baseUrl}`); }
    o.baseUrl = o.baseUrl.replace(/\/+$/, '');
  }
  return o;
}

// ── Reading the discovery document (§4.2) ─────────────────────────────────────
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDiscovery = (d) => isObject(d) && typeof d.restep === 'string';
// §1.1: the restep grammar and the major version. A document of another major version, or with a
// restep that does not follow the grammar, is not Restep 1: it is not exported (core is not assumed).
const RESTEP_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(draft|rc)\.(0|[1-9][0-9]*))?$/;
export const isRestep1 = (d) => { const m = RESTEP_VERSION.exec(d.restep); return !!m && m[1] === '1'; };
// §3: only https links or links of the root's scheme are followed; credentials go only to the API's origin (§4.3).
const allowedScheme = (u, root) => u.protocol === 'https:' || u.protocol === root.protocol;
// Values this client knows (§4.2): anything else is treated as not declared.
const FILTER_TYPES = ['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'datetime', 'localdatetime', 'timezone', 'duration', 'enum'];
const FILTER_OPS = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'in', 'nin', 'null', 'prefix', 'contains'];
// §6.1 and §4.2: a filter whose quantifier this client does not know is not used.
const usableFilter = (d) => isObject(d) && FILTER_TYPES.includes(d.type) && (d.quantifier === undefined || d.quantifier === 'some');
// §11.1: the three effects; without effects, or with an unknown value, a client counts all three.
const EFFECTS = ['destroys', 'external', 'charges'];
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
  try { res = await fetch(url, { headers }); } catch (e) { throw new Error(`cannot connect to ${url}: ${e.cause?.message ?? e.message}`); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, data };
}

async function loadDiscovery(opts) {
  const src = opts.source;
  if (/^https?:\/\//i.test(src)) {
    const root = new URL(src);
    if (!root.pathname.endsWith('/')) root.pathname += '/';
    let res = await getJson(root.href, opts);
    if (!isDiscovery(res.data)) {
      // §4.2: if the root is taken, the document is linked with rel="service-desc".
      for (const href of linkTargets(res.headers.get('link'), 'service-desc')) {
        let u;
        try { u = new URL(href, root); } catch { continue; }
        if (!allowedScheme(u, root)) continue;
        const d = await getJson(u.href, opts, { credentials: u.origin === root.origin });
        // §4.2: the first target that is a discovery document of Restep 1.
        if (d.status >= 200 && d.status < 300 && isDiscovery(d.data) && isRestep1(d.data)) { res = d; break; }
      }
    }
    if (res.status === 401) throw new Error(`${root.href} answers 401: pass --token or -H "Authorization: …".`);
    if (!isDiscovery(res.data)) throw new Error(`${root.href} does not serve a discovery document (a JSON object with restep, §4.2); it answered ${res.status}.`);
    if (!isRestep1(res.data)) throw new Error(notRestep1(res.data));
    return { doc: res.data, origin: root.origin, root };
  }
  if (!existsSync(src)) throw new Error(`the file ${src} does not exist.`);
  let doc;
  try { doc = JSON.parse(readFileSync(src, 'utf8')); } catch (e) { throw new Error(`${src} is not valid JSON: ${e.message}`); }
  if (!isDiscovery(doc)) throw new Error(`${src} is not a discovery document: it lacks the restep member (§4.2).`);
  if (!isRestep1(doc)) throw new Error(notRestep1(doc));
  return { doc, origin: null, root: null };
}

const notRestep1 = (d) => `the discovery document declares "restep": ${JSON.stringify(d.restep)}, which is not a Restep 1 version (§1.1); nothing is exported.`;

// A schema can be a link (§4.3). Only those of the same origin as the API are requested.
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

// ── Sample values ─────────────────────────────────────────────────────────────
const STRING_CANDIDATES = ['example', '10.00', '1', '2026-01-01', '2026-01-01T10:00:00Z', 'PT1H', 'es'];

function sampleString(s) {
  if (s.format === 'date') return '2026-01-01';
  if (s.format === 'date-time') return '2026-01-01T10:00:00Z';
  if (s.format === 'email') return 'ana@example.com';
  if (s.format === 'uri') return 'https://example.com/';
  if (s.format === 'uuid') return randomUUID();
  if (typeof s.pattern === 'string') {
    let re;
    try { re = new RegExp(s.pattern, 'u'); } catch { return 'example'; }
    return STRING_CANDIDATES.find((c) => re.test(c)) ?? 'example';
  }
  return 'example';
}

// An example that satisfies the schema in simple terms (type, enum, pattern, required). With
// writable, an object carries its required fields and its optional scalar fields that are not
// read-only or prefixed with _; optional objects (relations, language maps) are omitted.
function sample(schema, depth = 0, skip = []) {
  if (!isObject(schema) || depth > 5) return 'example';
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
        if (k.startsWith('_') || p?.readOnly || (depth === 0 && skip.includes(k))) continue;
        if (required.includes(k) || (depth === 0 && isScalar(p) && k !== 'id')) out[k] = sample(p, depth + 1);
      }
      if (!Object.keys(props).length && isObject(schema.additionalProperties)) out.es = sample(schema.additionalProperties, depth + 1);
      return out;
    }
    default: return 'example';
  }
}
const isNull = (s) => isObject(s) && (s.type === 'null' || (Array.isArray(s.type) && s.type.length === 1 && s.type[0] === 'null'));
// Scalar: enum, a const that is not an object, a scalar type (even if it lists its values with a
// oneOf of const, like form options, appendix A) or scalar alternatives.
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

// The body of a sample PATCH: a single writable scalar field (merge patch).
function samplePatch(update, create, skip = []) {
  for (const s of [update, create]) {
    if (!isObject(s?.properties)) continue;
    for (const [k, p] of Object.entries(s.properties)) {
      if (k === 'id' || k.startsWith('_') || p?.readOnly || skip.includes(k) || !isScalar(p)) continue;
      return { [k]: sample(p, 1) };
    }
  }
  return {};
}

// Sample value for a filter (§6.1), according to its declared type.
function filterValue(field, decl, coll, op) {
  if (op === 'null') return 'true';
  const one = (i = 0) => {
    switch (decl.type) {
      case 'enum': return String(decl.values?.[i % (decl.values?.length || 1)] ?? 'example');
      case 'integer': return String(2000 + i);
      case 'number': return String(3 + i);
      case 'decimal': return (10 + i * 5).toFixed(2);
      case 'boolean': return 'true';
      case 'date': return '2026-01-01';
      case 'datetime': return '2026-01-01T10:00:00Z';
      case 'localdatetime': return '2026-01-01T10:00:00';
      case 'timezone': return 'Europe/Madrid';
      case 'duration': return 'PT1H';
      default:
        if (field === 'id' || field.endsWith('.id')) return field === 'id' && coll.sampleId ? String(coll.sampleId) : String(i + 1);
        return 'example';
    }
  };
  if (op === 'in' || op === 'nin') return decl.type === 'boolean' ? 'true,false' : `${one(0)},${one(1)}`;
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

// Sample ids: the first item's and, in a subcollection, those of its parents (§4.2, §5.1).
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
  } catch { /* no sample: the variables stay at 1 */ }
  samples.set(cname, found);
  return found;
}

// ── Intermediate model: a list of requests per collection ─────────────────────
// Each request: { name, method, path (with {{variables}}), query: [[k, v]], headers: [[k, v]],
//   body (object or undefined), contentType, read (true if it is a read), note, save: {etag|next} }
function buildRequests(name, c, ctx) {
  const reqs = [];
  const profiles = ctx.doc.profiles ?? [];
  const query = profiles.includes('query');
  const writes = profiles.includes('writes');
  const actionsExt = (ctx.doc.extensions ?? []).includes('actions');
  // URI template (§4.2): {id} → {{variable}}; the variables go into the environment.
  let vi = 0;
  const path = String(c.path).replace(/\{([^}]+)\}/g, (_, v) => {
    const key = `${name}_path_${v.replace(/[^A-Za-z0-9_]/g, '_')}`;
    ctx.vars[key] = String(c.pathSamples?.[vi++] ?? ctx.vars[key] ?? '1');
    return `{{${key}}}`;
  });
  const idVar = `${name}_id`, etagVar = `${name}_etag`;
  const localized = isObject(c.localized) ? Object.keys(c.localized) : [];
  ctx.vars[idVar] = String(c.sampleId ?? ctx.vars[idVar] ?? '1');
  if (writes) ctx.vars[etagVar] ??= '';
  const item = `${path}/{{${idVar}}}`;
  const has = (list, m) => !Array.isArray(list) || list.includes(m);
  const limit = Math.min(10, Number.isInteger(c.max_limit) ? c.max_limit : 10);
  const filters = Object.entries(isObject(c.filter) ? c.filter : {}).filter(([, d]) => usableFilter(d));
  const named = Object.entries(isObject(c.named_filters) ? c.named_filters : {})
    .filter(([, d]) => isObject(d) && (d.type === undefined || FILTER_TYPES.includes(d.type)));
  // §6.1: a required filter goes in every list request, or it gives invalid_parameter.
  const required = [
    ...filters.filter(([, d]) => d.required === true).map(([field, d]) => {
      const ops = (Array.isArray(d.ops) ? d.ops : []).filter((o) => FILTER_OPS.includes(o) && o !== 'null');
      const op = ops.includes('eq') ? 'eq' : ops[0] ?? 'eq';
      return [field, [op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`, filterValue(field, d, c, op)]];
    }),
    ...named.filter(([, d]) => d.required === true).map(([n, d]) => [n, [`filter[${n}]`, d.type === undefined ? '' : filterValue(n, d, c, 'eq')]]),
  ];
  const req = (except) => (query ? required.filter(([f]) => f !== except).map(([, q]) => q) : []);
  // §6.1: default filters, switches declared "default": true, apply unless turned off with false.
  const defaults = named.filter(([, d]) => d.default === true && d.type === undefined).map(([n]) => n);
  const defaultsNote = defaults.length ? ` Default filters apply: ${defaults.join(', ')}; filter[name]=false turns one off (§6.1).` : '';
  // §4.3: a collection whose methods leave out GET cannot be listed.
  const listable = has(c.methods, 'GET');

  if (listable) {
    reqs.push({ name: `List ${name}`, method: 'GET', path, query: [...req(), ...(query ? [['limit', String(limit)]] : [])], read: true,
      note: `Page by following next in the response until it is null; the cursor is opaque (§5.2, §6.4).${defaultsNote}${required.length ? ` Required filters: ${required.map(([f]) => f).join(', ')} (§6.1).` : ''}`,
      save: { next: `${name}_next` } });
    // §5.2: the request for a full copy turns off every default filter; with a required filter there is none.
    if (query && defaults.length && !required.length) {
      reqs.push({ name: `List all ${name}`, method: 'GET', path, query: [...defaults.map((n) => [`filter[${n}]`, 'false']), ['limit', String(limit)]], read: true,
        note: 'The request for a full copy: every default filter turned off and no other filter (§5.2, §6.1).' });
    }
    if (query) {
      for (const [field, decl] of filters) {
        // §4.2: a filter of unknown type, or an unknown operator, is not used.
        const ops = (Array.isArray(decl.ops) ? decl.ops : []).filter((o) => FILTER_OPS.includes(o));
        if (!ops.length) continue;
        const op = ops[0];
        const key = op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`;
        // §6.1 (council, round 3, decisions 8 and 9): null on a to-many relationship or a list field, with or without
        // quantifier some, tests the whole group, never each element.
        const group = decl.quantifier === 'some' || c.relations?.[field]?.many === true || c.schemasResolved?.item?.properties?.[field]?.type === 'array';
        reqs.push({ name: `Filter ${name} by ${field} (${op})`, method: 'GET', path, query: [...req(field), [key, filterValue(field, decl, c, op)], ['limit', String(limit)]], read: true,
          note: `Operators declared for ${field}: ${ops.join(', ')} (§6.1).${decl.quantifier === 'some' ? ' Some related item, or element, matches (quantifier some).' : ''}`
            + (group && ops.includes('null') ? ` ${field}[null] tests the whole list, never each element: true gives the items with no related item or element (an empty list, an absent field and null are the same), false those with some; next to other filters on ${field}, true gives the items where no element meets them all at once and false those where some does; only one null filter per group, ${field} or a path through it, or the server answers invalid_parameter.` : '') });
      }
      const sort = Array.isArray(c.sort) ? c.sort.filter((s) => typeof s === 'string') : [];
      if (sort.length) {
        const keys = sort.filter((s) => s !== 'id').slice(0, 2);
        const value = keys.length ? [`-${keys[0]}`, ...keys.slice(1)].join(',') : '-id';
        reqs.push({ name: `Sort ${name}`, method: 'GET', path, query: [...req(), ['sort', value], ['limit', String(limit)]], read: true,
          note: `Declared sort keys: ${sort.join(', ')}; prefix - for descending (§6.2).` });
      }
      const fields = pickFields(c, ctx);
      if (fields.length) {
        reqs.push({ name: `Fields of ${name}`, method: 'GET', path, query: [...req(), ['fields', fields.join(',')], ['limit', String(limit)]], read: true,
          note: 'Only those fields, plus id and the members starting with _ (§6.3).' });
      }
      if (c.count === 'exact' || c.count === 'estimated') {
        reqs.push({ name: `Count ${name}`, method: 'GET', path, query: [...req(), ['count', 'true'], ['limit', '1']], read: true,
          note: `Adds total${c.count === 'estimated' ? ' and total_estimated' : ''} (§6.5).` });
      }
    }
  }
  // §9: a read with include of the relations that allow it and, up to include_depth, those of their
  // destinations. A relation to several collections (to as a list) goes only at the end of the path.
  const incl = profiles.includes('relations') ? includePaths(c, ctx.doc) : [];
  if (incl.length && listable) {
    reqs.push({ name: `Include relations of ${name}`, method: 'GET', path, query: [...req(), ['include', incl.join(',')], ...(query ? [['limit', String(limit)]] : [])], read: true,
      note: `Included relations: ${incl.join(', ')} (§9). A relation to several collections carries type in each object, and one to an item of a subcollection, href (§3).` });
  }
  if (has(c.item_methods, 'GET')) {
    reqs.push({ name: `Get ${name}`, method: 'GET', path: item, query: [], read: true,
      note: writes ? `Saves the response ETag in ${etagVar} for use in If-Match (§7.2).` : null,
      save: writes ? { etag: etagVar } : undefined });
  }
  // §5.1 (council, round 3, decision 1): schemas.create announces creation from JSON; a collection with upload and
  // without it only takes files, so it gets no JSON create.
  const createsFromJson = !isObject(c.upload) || (isObject(c.schemas) && c.schemas.create !== undefined);
  if (has(c.methods, 'POST') && createsFromJson) {
    const headers = [['Content-Type', 'application/json']];
    if (ctx.idempotencyKeys) headers.push(['Idempotency-Key', `"${randomUUID()}"`]);
    // §5.1: with id_from "client" the POST carries an id (a random UUID, §13.6); with any other
    // value, or without it, it does not carry one: the server assigns it ("either" allows it, but it is not needed)
    // and with an unknown value a client MUST NOT send it.
    // §3: a localized field is read-only; the client writes its language map.
    const body = sample(c.schemasResolved.create ?? {}, 0, localized);
    if (isObject(body)) { delete body.id; if (c.id_from === 'client') body.id = randomUUID(); }
    const notes = [];
    if (ctx.idempotencyKeys) notes.push('Repeating the request with the same Idempotency-Key does not create another item (§7.1); change it to create another.');
    else if (ctx.anonymousRefused) notes.push('No Idempotency-Key: the API refuses it without credentials ("anonymous": false, §7.1).');
    if (c.id_from === 'client') notes.push('The client chooses the id (id_from "client", §5.1): a new random one on each create.');
    // §5.1 (decision 2): beside upload, a JSON POST always creates an item; a JSON file only goes as multipart, and
    // (round 4, decisions 1b and 4b) a +json body is a file, and the file part carries a filename.
    if (isObject(c.upload)) notes.push('The collection also takes files: this JSON body always creates an item from its fields, never a file; a JSON file goes as the file part of multipart/form-data, with a filename (a generic one such as file if it has none), and a +json body such as application/ld+json is a file (§5.1).');
    reqs.push({ name: `Create in ${name}`, method: 'POST', path, query: [], headers, body, note: notes.join(' ') || null });
  }
  if (has(c.item_methods, 'PATCH')) {
    const headers = [['Content-Type', 'application/merge-patch+json']];
    if (writes) headers.push(['If-Match', `{{${etagVar}}}`]);
    reqs.push({ name: `Update ${name}`, method: 'PATCH', path: item, query: [], headers,
      body: samplePatch(c.schemasResolved.update, c.schemasResolved.create, localized),
      note: (writes ? `Merge patch (§4.3). If-Match carries the ETag from "Get ${name}", with its quotes (§7.2).` : 'Merge patch (§4.3).')
        + (c.upsert === true ? ' With upsert, a PATCH to a free id creates the item (201); If-None-Match: * makes it only create (§5.1).' : '') });
  }
  if (has(c.item_methods, 'DELETE')) {
    const headers = writes ? [['If-Match', `{{${etagVar}}}`]] : [];
    reqs.push({ name: `Delete ${name}`, method: 'DELETE', path: item, query: [], headers,
      note: writes ? `If-Match carries the ETag from "Get ${name}" (§7.2).` : null });
  }
  if (actionsExt && isObject(c.actions)) {
    for (const [action, a] of Object.entries(c.actions)) {
      // §4.2: an action with an unknown on or method is treated as not declared.
      if (!isObject(a) || !ACTION_ON.includes(a.on)) continue;
      const r = actionRequest(action, a, `${a.on === 'collection' ? path : item}:${action}`, c.actionInputs?.[action], c, ctx);
      if (r) reqs.push({ ...r, name: `Action ${action} (${a.on === 'collection' ? 'collection' : 'item'})` });
    }
  }
  for (const r of reqs) r.headers = [['Accept', 'application/json'], ...(r.headers ?? [])];
  return reqs;
}

// The request of an action (§11.1), on a collection, an item or a singleton; null if its method is unknown (§4.2).
function actionRequest(action, a, target, input, owner, ctx) {
  if (a.method !== undefined && a.method !== 'GET' && a.method !== 'POST') return null;
  const method = a.method === 'GET' ? 'GET' : 'POST';
  const headers = [];
  const query = [];
  let body;
  if (method === 'POST') {
    body = input ? sample(input) : {};
    headers.push(['Content-Type', 'application/json']);
    if (ctx.idempotencyKeys && a.idempotent === false) headers.push(['Idempotency-Key', `"${randomUUID()}"`]);
  } else {
    // §11.1: the required params of a GET action, a list one with two values.
    for (const [p, d] of Object.entries(isObject(a.params) ? a.params : {})) {
      if (!isObject(d) || d.required !== true) continue;
      query.push([p, filterValue(p, { type: FILTER_TYPES.includes(d.type) ? d.type : 'string', values: d.values }, owner, d.list === true ? 'in' : 'eq')]);
    }
  }
  // §11.1: without effects an unsafe action has all three and a safe one none; an unknown value counts as all three.
  const declared = Array.isArray(a.effects) ? (a.effects.some((x) => !EFFECTS.includes(x)) ? EFFECTS : a.effects) : null;
  const effects = declared ?? (a.safe === true ? null : EFFECTS);
  // §5.3 and §11.1: a GET action without params is "params": {}: any query parameter gives unsupported_parameter.
  const noParams = method === 'GET' && !(isObject(a.params) && Object.keys(a.params).length)
    && 'It takes no query parameters: any one gives unsupported_parameter (§5.3, §11.1).';
  const note = [a.description, `safe: ${a.safe === true}, idempotent: ${a.idempotent === true} (§11.1).`, noParams,
    effects && `Effects: ${effects.length ? effects.join(', ') : 'none'}${Array.isArray(a.effects) && effects === a.effects ? '' : ' (undeclared or unknown: all three)'} (§11.1).`].filter(Boolean).join(' ');
  return { method, path: target, query, headers, body, read: method === 'GET', note };
}

// A standalone resource (singleton, §5.9): GET and, if it declares it or declares no methods, PATCH with If-Match.
function buildSingletonRequests(name, prefix, sg, ctx) {
  const writes = (ctx.doc.profiles ?? []).includes('writes');
  const etagVar = `${prefix}_etag`;
  if (writes) ctx.vars[etagVar] ??= '';
  const has = (m) => !Array.isArray(sg.methods) || sg.methods.includes(m);
  // §5.9: a singleton with parent has a template whose variables take the ids of the parent items.
  let vi = 0;
  const path = sg.path.replace(/\{([^}]+)\}/g, (_, v) => {
    const key = `${prefix}_path_${v.replace(/[^A-Za-z0-9_]/g, '_')}`;
    ctx.vars[key] = String(sg.pathSamples?.[vi++] ?? ctx.vars[key] ?? '1');
    return `{{${key}}}`;
  });
  const reqs = [{ name: `Get ${name}`, method: 'GET', path, query: [], read: true,
    note: `Singleton resource (§5.9).${writes ? ` Saves the ETag in ${etagVar} for use in If-Match (§7.2).` : ''}`,
    save: writes ? { etag: etagVar } : undefined }];
  if (has('PATCH')) {
    const headers = [['Content-Type', 'application/merge-patch+json']];
    if (writes) headers.push(['If-Match', `{{${etagVar}}}`]);
    // §4.3 and §5.9: the effects of its PATCH come from method_effects; undeclared, or with an unknown value, all three.
    const fx = isObject(sg.method_effects) && Object.hasOwn(sg.method_effects, 'PATCH') ? sg.method_effects.PATCH : undefined;
    const effects = Array.isArray(fx) && fx.every((x) => EFFECTS.includes(x)) ? fx : null;
    const effectsNote = ` Effects: ${effects ? (effects.length ? effects.join(', ') : 'none') : `${EFFECTS.join(', ')} (undeclared or unknown: all three)`} (§4.3, §11.1).`;
    reqs.push({ name: `Update ${name}`, method: 'PATCH', path, query: [], headers,
      body: samplePatch(sg.schemasResolved.update, sg.schemasResolved.item),
      note: (writes ? `Merge patch (§5.9). If-Match carries the ETag from "Get ${name}" (§7.2).` : 'Merge patch (§5.9).') + effectsNote });
  }
  // §5.9 and §11.1: a singleton's actions carry no on and are used at {path}:{name}.
  if ((ctx.doc.extensions ?? []).includes('actions') && isObject(sg.actions)) {
    for (const [action, a] of Object.entries(sg.actions)) {
      if (!isObject(a)) continue;
      const r = actionRequest(action, a, `${path}:${action}`, sg.actionInputs?.[action], sg, ctx);
      if (r) reqs.push({ ...r, name: `Action ${action}` });
    }
  }
  for (const r of reqs) r.headers = [['Accept', 'application/json'], ...(r.headers ?? [])];
  return reqs;
}

function pickFields(c, ctx) {
  const props = isObject(c.schemasResolved.item?.properties) ? Object.keys(c.schemasResolved.item.properties) : [];
  const pool = props.length ? props : [...Object.keys(isObject(c.filter) ? c.filter : {}), ...(Array.isArray(c.sort) ? c.sort : [])];
  // §6.3: a path that enters a language map gives invalid_parameter; top-level fields only.
  return [...new Set(pool.filter((f) => typeof f === 'string' && f !== 'id' && !f.includes('.') && !f.startsWith('_')))].slice(0, 2);
}

// ── .http format (REST Client and JetBrains) ──────────────────────────────────
const enc = (v) => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%3A/gi, ':');
const encKey = (k) => k.replace(/[^A-Za-z0-9_.\-[\]]/g, (ch) => encodeURIComponent(ch));
const queryString = (q) => (q.length ? `?${q.map(([k, v]) => `${encKey(k)}=${enc(v)}`).join('&')}` : '');

function toHttp(model, out) {
  mkdirSync(out, { recursive: true });
  for (const coll of model.collections) {
    const lines = [`# ${model.name} · ${coll.name}`, `# Generated by restep-export ${VERSION} from the discovery document (Restep ${model.doc.restep}).`];
    if (coll.description) lines.push(`# ${coll.description}`);
    lines.push('# base_url and token come from the environment (http-client.env.json or .vscode/settings.json).', '');
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
  // JetBrains: http-client.env.json (the token is better in http-client.private.env.json, which is not versioned).
  writeFileSync(join(out, 'http-client.env.json'), JSON.stringify({ local: env }, null, 2) + '\n');
  writeFileSync(join(out, 'http-client.private.env.json'), JSON.stringify({ local: { token: '' } }, null, 2) + '\n');
  // VS Code REST Client: environments in the workspace settings.
  mkdirSync(join(out, '.vscode'), { recursive: true });
  writeFileSync(join(out, '.vscode', 'settings.json'), JSON.stringify({ 'rest-client.environmentVariables': { local: env } }, null, 2) + '\n');
}

// ── Bruno format (.bru) ───────────────────────────────────────────────────────
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

// ── Postman v2.1 format ───────────────────────────────────────────────────────
function postmanUrl(r) {
  const raw = `{{base_url}}${r.path}${queryString(r.query)}`;
  return { raw, host: ['{{base_url}}'], path: r.path.split('/').filter(Boolean), ...(r.query.length && { query: r.query.map(([key, value]) => ({ key, value })) }) };
}

function toPostman(model, out) {
  mkdirSync(out, { recursive: true });
  const col = {
    info: {
      _postman_id: randomUUID(), name: model.name,
      description: `Generated by restep-export ${VERSION} from the discovery document (Restep ${model.doc.restep}).`,
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

const fileName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'collection';

// ── Main ──────────────────────────────────────────────────────────────────────
export async function exportCollection(opts) {
  const ctx = await loadDiscovery(opts);
  ctx.vars = {};
  const { doc } = ctx;
  // §2: the discovery paths are relative to the API root, which may have a path (/api/).
  const baseUrl = opts.baseUrl ?? (ctx.root ? ctx.root.href.replace(/\/+$/, '') : 'http://localhost:8080');
  const auth = opts.auth === 'bearer' || (opts.auth === 'auto' && (doc.extensions ?? []).includes('oauth'));
  const name = opts.name ?? (ctx.root ? `Restep ${ctx.root.host}` : 'Restep');
  // §7.1: with "anonymous": false, a request without credentials carries no Idempotency-Key.
  ctx.anonymousRefused = isObject(doc.idempotency) && doc.idempotency.anonymous === false && !auth && !opts.token && !opts.headers.authorization;
  ctx.idempotencyKeys = (doc.profiles ?? []).includes('writes') && !ctx.anonymousRefused;
  const collections = [];
  const samples = new Map(); // collection name → { id, vars: [id of each parent] }
  for (const [cname, c] of Object.entries(isObject(doc.collections) ? doc.collections : {})) {
    if (!isObject(c) || typeof c.path !== 'string') { console.error(`restep-export: warning: ${cname} has no path; skipped.`); continue; }
    const schemas = isObject(c.schemas) ? c.schemas : {};
    const coll = { ...c, schemasResolved: {} };
    for (const k of ['item', 'create', 'update']) coll.schemasResolved[k] = await resolveSchema(schemas[k], ctx, opts);
    coll.actionInputs = {};
    for (const [a, decl] of Object.entries(isObject(c.actions) ? c.actions : {})) coll.actionInputs[a] = await resolveSchema(decl?.input, ctx, opts);
    // One sample id per collection, from the first item. In a subcollection (§4.2: template and
    // parent) the variables take the ids of their parents: among the first items of the
    // parent, one is looked for whose subcollection has some item, so that "Get" does not give 404.
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
  // Singletons (§5.9). A client ignores one whose path is a template without parent, or whose parent
  // names no collection or singleton of the document.
  const singletons = isObject(doc.singletons) ? doc.singletons : {};
  const declared = (p) => typeof p === 'string' && (isObject(doc.collections?.[p]) || isObject(singletons[p]));
  const parentIds = (sg, seen = new Set()) => { // the ids the template variables take, from the samples
    if (typeof sg.parent !== 'string' || seen.has(sg.parent)) return [];
    if (isObject(doc.collections?.[sg.parent])) { const f = samples.get(sg.parent); return f ? [...f.vars, f.id] : []; }
    return isObject(singletons[sg.parent]) ? parentIds(singletons[sg.parent], new Set([...seen, sg.parent])) : [];
  };
  for (const [sname, sg] of Object.entries(singletons)) {
    if (!isObject(sg) || typeof sg.path !== 'string' || !sg.path.startsWith('/')
      || (sg.parent === undefined ? /[{}]/.test(sg.path) : !declared(sg.parent))) {
      console.error(`restep-export: warning: the singleton ${sname} has a template without parent, or a parent the document does not declare; ignored (§5.9).`);
      continue;
    }
    const schemas = isObject(sg.schemas) ? sg.schemas : {};
    const s = { ...sg, schemasResolved: {}, actionInputs: {} };
    for (const k of ['item', 'update']) s.schemasResolved[k] = await resolveSchema(schemas[k], ctx, opts);
    for (const [a, decl] of Object.entries(isObject(sg.actions) ? sg.actions : {})) s.actionInputs[a] = await resolveSchema(decl?.input, ctx, opts);
    s.pathSamples = parentIds(sg).map((x) => x ?? '1');
    const folder = collections.some((c) => c.name === sname) ? `${sname}-resource` : sname;
    const prefix = folder.replace(/[^A-Za-z0-9_]/g, '_');
    const before = new Set(Object.keys(ctx.vars));
    const requests = buildSingletonRequests(sname, prefix, s, ctx);
    const varNames = Object.keys(ctx.vars).filter((k) => !before.has(k) || k.startsWith(`${prefix}_`));
    collections.push({ name: folder, description: typeof sg.description === 'string' ? sg.description : null, requests, varNames, singleton: true });
  }
  if (!collections.length) console.error('restep-export: warning: the discovery document declares no collections; only the environments are written.');
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
    console.log(`${model.collections.length} collections, ${n} requests.`);
  } catch (e) { fail(e.message); }
}
