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
npx restep-export http://localhost:8080/ --to http --out requests
npx restep-export discovery.json --to bruno,postman --out exported \
  --base-url https://api.example.com
```

| Option | What it does |
|---|---|
| `--to <formats>` | `http`, `bruno` or `postman`; several separated by commas. Defaults to all three |
| `--out <folder>` | Where to write (default `./restep-export`). With several formats, one subfolder per format |
| `--base-url <url>` | Value of `base_url`. Defaults to the API root without a trailing `/` (discovery paths are relative to it, §2); from a file, `http://localhost:8080` |
| `--name <name>` | Collection name (default `Restep <host>`, or `Restep` from a file) |
| `--auth auto\|bearer\|none` | Add `Authorization: Bearer {{token}}`. `auto` (default): only if the API announces `oauth` |
| `--token <token>` | Token used to read the API while exporting. Never written to the files |
| `-H "Name: value"` | Extra header when reading the API (repeatable). Not written either |
| `--no-samples` | Does not ask the API for a sample id per collection |

From a URL, it reads the discovery at the root (or the one linked with `rel="service-desc"`), the
schemas that are same-origin links (§4.3) and the first item of each collection, to use its `id`
as an example. From a file it makes no requests.

Credentials (`--token`, `-H`) only go to the API's origin: a `service-desc` on another origin is
fetched without them (§4.3), and a link that is neither `https` nor the root's scheme (`data:`,
`file:`) is not followed (§3).

### What it understands from draft 7

- **Version** (§1.1): `restep` must follow the grammar (`1.0`, `1.0-draft.7`, `1.0-rc.1`…) with
  major version 1. Another major version, or a value that does not follow the grammar, is an
  error: it is not a Restep 1 discovery, and it is not exported as if it were just `core` either.
- **Unknown values** (§4.2): a filter with an unknown `type` or `quantifier` generates no request;
  only the known operators of a filter are used (draft 7 adds `nin`, `prefix` and `contains`, and
  the types `localdatetime` and `timezone`); an action with an unknown `on` or `method` is
  skipped. Of several `service-desc` links, it uses the first target that is a discovery document
  of Restep 1.
- **Default and required filters** (§5.2, §6.1): a required filter goes in every list request
  with a sample value, and then there is no request for a full copy; otherwise, a collection with
  default filters gets "List all", the request for a full copy, with `filter[name]=false` for each.
  `null` on a to-many relationship or a list field, declared without `quantifier`, gets its
  request like any filter; on a relationship declared `many`, a field whose item schema is an
  array or a filter with `"quantifier": "some"`, its note says that `null` tests the whole list,
  never each element, and what `true` and `false` return alone and next to other filters on it
  (§6.1, council round 3, decisions 8 and 9).
- **Collections without `GET`** (§4.3): no list requests.
- **Localized fields** (§3): they are read-only, so sample bodies leave them out.
- **Actions** (§11.1): the note says the action's `effects` (on an unsafe action, all three where
  none are declared; on a safe one, none; all three for an unknown value, also on a safe one); a
  `GET` action carries its required `params`, a list one with two values, and one without `params`
  says it takes no query parameters (§5.3);
  `new` is one more `GET` action. With `upsert`, the note of "Update" says that a `PATCH` to a free
  `id` creates the item (§5.1).
- **`id_from`** (§5.1): with `"client"` the create body carries a random `id` (UUID, §13.6);
  without `id_from`, or with `"server"`, `"either"` or an unknown value, it carries no `id`.
- **Singleton resources** (§5.9): each entry in `singletons` becomes a folder (or a `.http`) with
  "Get" and, if `methods` includes `PATCH` or is not declared, "Update" with
  merge patch and `If-Match: {{<name>_etag}}`, whose note gives the effects its `method_effects`
  declares for `PATCH` (all three where undeclared, §4.3), plus its actions at `{path}:{name}`. One under an
  item or another singleton (`parent`) gets `<name>_path_<var>` variables, which take the sample
  ids of its parent. One whose path is a template without `parent`, or whose `parent` names
  nothing in the document, is ignored, with a warning. If it shares a name with a collection, its
  folder is called `<name>-resource`.
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
| Update with merge patch and `If-Match: {{<collection>_etag}}` (§7.2) | `PATCH`; `If-Match`, with `writes` |
| Delete with `If-Match` | `DELETE` |
| Each action, at `/collection:name` or `/collection/{{id}}:name`, with its `method` and a body from its `input`; `Idempotency-Key` if it is not idempotent (§11.1) | with `actions` |

Variables: `base_url` and `token` in the environment; `<collection>_id` (sample id),
`<collection>_etag` (with `writes`) and `<collection>_path_<var>` for each variable of a URI
template (subcollections, §4.2). With a running API, those variables take the id of a parent
item (`parent`) that has some item in the subcollection, and `<collection>_id` one of those, so
that "Get" does not return `404`; with no samples, they are `1`. In Bruno and Postman,
"Get" stores the `ETag` in `<collection>_etag` and "List" stores `next` in
`<collection>_next`; in the `.http` files you have to copy it by hand into the file variable
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
sample parent has reviews and "Get" returns `200`), `include` with depth 2, the `highlight`
relation with `href`, the polymorphic `showcase` with `type`, and that the server accepts the
sample actions: `low_stock` (collection `GET`), `restock` (item `POST` with its `input` and
`Idempotency-Key`), `find_or_create` and `inherit_tax` (idempotent, no key). It also tests the
reference's `/shop` singleton resource (and that the server accepts its
`PATCH`), versions with a suffix and with another major version, unknown values, `id_from`,
`anonymous: false`, singleton resources with a template or `parent`, and a `service-desc` on
another origin (no credentials) and with `data:` (not followed), with two servers of its own on
ports 8974 and 8975. And the draft 7 items above, from a file, with a `service-desc` pair whose
first target is Restep 2.

## Limits

- From `relations` it only generates the read with `include`: bodies do not link relations. It
  does not cover `sync`, `batch`, `filter-expr` or `query-method`.
- It generates no requests for named filters (`named_filters`, §6.1), except to turn off the
  default ones or to carry a required one, or for `fields` on a singleton resource (§5.9).
- It generates no upload request (`upload`, §5.1): the formats would each need a file of their
  own. Since `schemas.create` announces creation from JSON, a collection with `upload` and without
  it gets no JSON create either; one with both gets the JSON create, whose note says that it always
  creates an item and that a JSON file goes as the `file` part of `multipart/form-data`, with a
  `filename` (a generic one such as `file` if it has none), and that a `+json` body is a file
  (council round 3, decisions 1 and 2; round 4, 1b and 4b). In a collection that only takes files,
  a JSON body its `media_types` admit, also by `*/*` or `application/*`, is a file (round 4, 1a).
- Each filter request carries one filter (and the required ones, never `null`), so it never sends
  two `null` filters on one group, which give `invalid_parameter` (§6.1, round 4, 5a).
- It does not annotate deprecation notices (`deprecations`, §5.5) on the requests that use them.
- "Get" stores the `ETag` header; it does not read `_etag` from the body, which §7.2
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
site, where the tool is developed alongside the [specification](https://w3id.org/restep/1/) and the reference
server: `vendor/` and `schema/` are copies from the site so the tests run on their own.

MIT licensed.
