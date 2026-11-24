# restep-export

Generates a collection of sample requests from the discovery document of a Restep 1 API (§4.2),
so you can try it by hand from your editor or an HTTP client:

- `http`: `.http` files, one per collection, for VS Code's REST Client and the JetBrains HTTP
  client, with `http-client.env.json`, `http-client.private.env.json` (for the token, kept out of
  version control) and `.vscode/settings.json`.
- `bruno`: a [Bruno](https://www.usebruno.com/) collection (`bruno.json`, one folder and one
  `.bru` per request, and the `environments/local.bru` environment with the token as a secret).
- `postman`: a Postman v2.1 collection in JSON, with collection variables.

A single file, Node 18+, no dependencies.

## Usage

```bash
npx restep-export http://localhost:8080/ --to http --out peticiones
npx restep-export discovery.json --to bruno,postman --out exportado \
  --base-url https://api.example.com
```

| Option | What it does |
|---|---|
| `--to <formatos>` | `http`, `bruno` or `postman`; several separated by commas. Defaults to all three |
| `--out <carpeta>` | Where to write (default `./restep-export`). With several formats, one subfolder per format |
| `--base-url <url>` | Value of `base_url`. Defaults to the API root without a trailing `/` (discovery paths are relative to it, §2); from a file, `http://localhost:8080` |
| `--name <nombre>` | Collection name (default `Restep <host>`, or `Restep` from a file) |
| `--auth auto\|bearer\|none` | Add `Authorization: Bearer {{token}}`. `auto` (default): only if the API announces `oauth` |
| `--token <token>` | Token used to read the API while exporting. Never written to the files |
| `-H "Nombre: valor"` | Extra header when reading the API (repeatable). Not written either |
| `--no-samples` | Does not ask the API for a sample id per collection |

From a URL, it reads the discovery at the root (or the one linked with `rel="service-desc"`), the
schemas that are same-origin links (§4.3) and the first item of each collection, to use its `id`
as an example. From a file it makes no requests.

Credentials (`--token`, `-H`) only go to the API's origin: a `service-desc` on another origin is
fetched without them (§4.3), and a link that is neither `https` nor the root's scheme (`data:`,
`file:`) is not followed (§3).

### What it understands from draft 6

- **Version** (§1.1): `restep` must follow the grammar (`1.0`, `1.0-draft.6`, `1.0-rc.1`…) with
  major version 1. Another major version, or a value that does not follow the grammar, is an
  error: it is not a Restep 1 discovery, and it is not exported as if it were just `core` either.
- **Unknown values** (§4.2): a filter with an unknown `type` generates no request; only the
  known operators of a filter are used; an action with an unknown `on` or `method` is
  skipped.
- **`id_from`** (§5.1): with `"client"` the create body carries a random `id` (UUID, §13.6);
  without `id_from`, or with `"server"`, `"either"` or an unknown value, it carries no `id`.
- **Singleton resources** (§5.9): each entry in `singletons` becomes a folder (or a `.http`) with
  «Obtener» (get) and, if `methods` includes `PATCH` or is not declared, «Actualizar» (update) with
  merge patch and `If-Match: {{<nombre>_etag}}`. One whose path is a template or that has `parent`
  is ignored, with a warning. If it shares a name with a collection, its folder is called
  `<nombre>-recurso`.
- **`idempotency.anonymous: false`** (§7.1): when exporting without credentials (no `--auth bearer`
  or `oauth`, no `--token` or `-H Authorization`), requests carry no `Idempotency-Key`.
- **Experimental parts** (§1.2): it uses none (`sync`, `batch`, `filter-expr`, `query-method`,
  `inherit`), so it does not depend on the declared version.
- Every `POST` body (create and actions) carries `Content-Type: application/json`, and a literal
  `+` in a query value comes out as `%2B` (§3, §5.2).

## What it generates per collection

| Request | When |
|---|---|
| List, with `limit` (the smaller of 10 and `max_limit`) | if `methods` includes `GET` or is not declared |
| One filter per `filter` field, with its first operator and a value of the declared type (§6.1) | with `query` |
| Sort by the first two `sort` keys, the first one descending (§6.2) | with `query` and `sort` |
| `fields` with two top-level fields (§6.3) | with `query` |
| `count=true` (§6.5) | if `count` is declared |
| Include relations: `include` with those declaring `"include": true` and, up to `include_depth`, those of their targets (`category,category.parent`); a relation to several collections only at the end (§9) | with `relations` |
| Get an item | if `item_methods` includes `GET` or is not declared |
| Create, with a sample body from the `create` schema and `Idempotency-Key` (§7.1) | `POST`; the key, with `writes` |
| Update with merge patch and `If-Match: {{<coleccion>_etag}}` (§7.2) | `PATCH`; `If-Match`, with `writes` |
| Delete with `If-Match` | `DELETE` |
| Each action, at `/coleccion:nombre` or `/coleccion/{{id}}:nombre`, with its `method` and a body from its `input`; `Idempotency-Key` if it is not idempotent (§11.1) | with `actions` |

Variables: `base_url` and `token` in the environment; `<coleccion>_id` (sample id),
`<coleccion>_etag` (with `writes`) and `<coleccion>_path_<var>` for each variable of a URI
template (subcollections, §4.2). With a running API, those variables take the id of a parent
item (`parent`) that has some item in the subcollection, and `<coleccion>_id` one of those, so
that «Obtener» does not return `404`; with no samples, they are `1`. In Bruno and Postman,
«Obtener» stores the `ETag` in `<coleccion>_etag` and «Listar» (list) stores `next` in
`<coleccion>_next`; in the `.http` files you have to copy it by hand into the file variable
(REST Client and JetBrains use different syntaxes for chaining responses).

Sample bodies carry the required fields and the optional scalars that are not read-only;
optional objects (relations, language maps) are left out so the example does not point to an
item that does not exist. The `Idempotency-Key` values are fixed UUIDs generated at export time,
quoted as Structured Fields requires: repeating the request does not create another item, which
is exactly what it shows.

## Tests

```bash
node tools/restep-export/test.mjs
```

Starts the reference server on ports 8895 and 8896 (the latter with `RESTEP_TOKEN`), generates
the three formats, checks their structure (Postman v2.1, `.bru` blocks, `.http`), runs every read
request in the `.http` files through a mini-parser and requires a `2xx`, checks that the server
accepts the create and update bodies, and exports a discovery from a file with actions, a
subcollection and `oauth`. Against the reference it also tests the `reviews` subcollection (its
sample parent has reviews and «Obtener» returns `200`), `include` with depth 2, the `highlight`
relation with `href`, the polymorphic `showcase` with `type`, and that the server accepts the
sample actions: `low_stock` (collection `GET`), `restock` (item `POST` with its `input` and
`Idempotency-Key`), `find_or_create` and `inherit_tax` (idempotent, no key). It also tests the
draft 6 items: the reference's `/shop` singleton resource (and that the server accepts its
`PATCH`), versions with a suffix and with another major version, unknown values, `id_from`,
`anonymous: false`, singleton resources with a template or `parent`, and a `service-desc` on
another origin (no credentials) and with `data:` (not followed), with two servers of its own on
ports 8974 and 8975.

## Limits

- From `relations` it only generates the read with `include`: bodies do not link relations. It
  does not cover `sync`, `batch`, `filter-expr` or `query-method`.
- It generates no requests for named filters (`named_filters`, §6.1) or for `fields` on a
  singleton resource (§5.9).
- It does not annotate deprecation notices (`deprecations`, §5.5) on the requests that use them.
- «Obtener» stores the `ETag` header; it does not read `_etag` from the body, which §7.2
  guarantees even if a proxy weakens the header.
- Relations with `href` (those of a subcollection or a singleton resource, §3) are not used:
  sample bodies carry no relations.
- With no running API (from a file or with `--no-samples`), a subcollection's variables are
  `1`.
- Filter values are examples and may return no items (but they do return `200`).
- The body generator only understands the simple parts of JSON Schema (`type`, `enum`, `const`,
  `default`, `examples`, `anyOf`/`oneOf`, flat `allOf`, `pattern` with a few candidates,
  `format`); it does not follow `$ref`.

## Questions about the spec

- With the discovery in a file there is no way to know the API's URL: the document does not
  declare its own root or origin, and its `path` values are absolute paths. That is why
  `--base-url` exists. Should the discovery be able to declare its root (like `servers` in
  OpenAPI)?
- Settled in draft 6: an action's empty body is `{}` (§11.1) and every request with a body to a
  Restep resource carries `Content-Type: application/json` (§3).

## Code and issues

Code and issues: <https://github.com/restep-spec/restep-export>. That repository is generated from the Restep
site, where the tool is developed alongside the [specification](https://restep.wubytes.com/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
