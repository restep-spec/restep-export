# restep-export

Genera una colección de peticiones de ejemplo a partir del documento de descubrimiento de una
API Restep 1 (§4.2), para probarla a mano desde el editor o desde un cliente HTTP:

- `http`: archivos `.http`, uno por colección, para REST Client de VS Code y para el cliente
  HTTP de JetBrains, con `http-client.env.json`, `http-client.private.env.json` (para el token,
  fuera del control de versiones) y `.vscode/settings.json`.
- `bruno`: una colección de [Bruno](https://www.usebruno.com/) (`bruno.json`, una carpeta y un
  `.bru` por petición, y el entorno `environments/local.bru` con el token como secreto).
- `postman`: una colección Postman v2.1 en JSON, con variables de colección.

Un solo archivo, Node 18+, sin dependencias.

## Uso

```bash
npx restep-export http://localhost:8080/ --to http --out peticiones
npx restep-export discovery.json --to bruno,postman --out exportado \
  --base-url https://api.example.com
```

| Opción | Qué hace |
|---|---|
| `--to <formatos>` | `http`, `bruno` o `postman`; varios separados por comas. Por defecto, los tres |
| `--out <carpeta>` | Dónde escribir (por defecto `./restep-export`). Con varios formatos, una subcarpeta por formato |
| `--base-url <url>` | Valor de `base_url`. Por defecto, la raíz de la API, sin `/` final (las rutas del descubrimiento son relativas a ella, §2); con un archivo, `http://localhost:8080` |
| `--name <nombre>` | Nombre de la colección (por defecto, `Restep <host>`, o `Restep` con un archivo) |
| `--auth auto\|bearer\|none` | Añadir `Authorization: Bearer {{token}}`. `auto` (por defecto): solo si la API anuncia `oauth` |
| `--token <token>` | Token para leer la API al exportar. Nunca se escribe en los archivos |
| `-H "Nombre: valor"` | Cabecera extra al leer la API (repetible). Tampoco se escribe |
| `--no-samples` | No pide a la API un id de ejemplo por colección |

Con una URL, lee el descubrimiento de la raíz (o el enlazado con `rel="service-desc"`), los
esquemas que sean enlaces del mismo origen (§4.3) y el primer elemento de cada colección,
para usar su `id` como ejemplo. Con un archivo no hace ninguna petición.

Las credenciales (`--token`, `-H`) solo van al origen de la API: un `service-desc` de otro origen
se pide sin ellas (§4.3), y un enlace que no es `https` ni del esquema de la raíz (`data:`,
`file:`) no se sigue (§3).

### Qué entiende del borrador 6

- **Versión** (§1.1): `restep` debe seguir la gramática (`1.0`, `1.0-draft.6`, `1.0-rc.1`…) con
  versión mayor 1. Otra versión mayor, o un valor sin la gramática, da error: no es un
  descubrimiento de Restep 1, y tampoco se exporta como si fuera solo `core`.
- **Valores desconocidos** (§4.2): un filtro con un `type` desconocido no genera petición; de un
  filtro solo se usan los operadores conocidos; una acción con un `on` o un `method`
  desconocidos se omite.
- **`id_from`** (§5.1): con `"client"` el cuerpo de crear lleva un `id` aleatorio (UUID, §13.6);
  sin `id_from`, con `"server"`, `"either"` o un valor desconocido, no lleva `id`.
- **Recursos sueltos** (§5.9): cada uno de `singletons` sale como una carpeta (o un `.http`) con
  «Obtener» y, si `methods` incluye `PATCH` o no se declara, «Actualizar» con merge patch e
  `If-Match: {{<nombre>_etag}}`. Uno cuya ruta es una plantilla o que lleva `parent` se ignora,
  con un aviso. Si comparte nombre con una colección, su carpeta se llama `<nombre>-recurso`.
- **`idempotency.anonymous: false`** (§7.1): si se exporta sin credenciales (sin `--auth bearer`
  ni `oauth`, sin `--token` ni `-H Authorization`), las peticiones no llevan `Idempotency-Key`.
- **Partes experimentales** (§1.2): no usa ninguna (`sync`, `batch`, `filter-expr`,
  `query-method`, `inherit`), así que no depende de la versión declarada.
- Todo cuerpo de `POST` (crear y acciones) lleva `Content-Type: application/json`, y un `+`
  literal en un valor de la query sale como `%2B` (§3, §5.2).

## Qué genera por colección

| Petición | Cuándo |
|---|---|
| Listar, con `limit` (el menor de 10 y `max_limit`) | si `methods` incluye `GET` o no se declara |
| Un filtro por campo de `filter`, con su primer operador y un valor del tipo declarado (§6.1) | con `query` |
| Ordenar por las dos primeras claves de `sort`, la primera descendente (§6.2) | con `query` y `sort` |
| `fields` con dos campos de primer nivel (§6.3) | con `query` |
| `count=true` (§6.5) | si se declara `count` |
| Incluir relaciones: `include` con las que declaran `"include": true` y, hasta `include_depth`, las de sus destinos (`category,category.parent`); una relación a varias colecciones solo al final (§9) | con `relations` |
| Obtener un elemento | si `item_methods` incluye `GET` o no se declara |
| Crear, con un cuerpo de ejemplo del esquema `create` y `Idempotency-Key` (§7.1) | `POST`; la clave, con `writes` |
| Actualizar con merge patch e `If-Match: {{<coleccion>_etag}}` (§7.2) | `PATCH`; `If-Match`, con `writes` |
| Borrar con `If-Match` | `DELETE` |
| Cada acción, en `/coleccion:nombre` o `/coleccion/{{id}}:nombre`, con su `method` y un cuerpo de su `input`; `Idempotency-Key` si no es idempotente (§11.1) | con `actions` |

Variables: `base_url` y `token` en el entorno; `<coleccion>_id` (id de ejemplo),
`<coleccion>_etag` (con `writes`) y `<coleccion>_path_<var>` para cada variable de una
plantilla de URI (subcolecciones, §4.2). Con una API en marcha, esas variables toman el id de un
elemento del padre (`parent`) que tenga algún elemento en la subcolección, y `<coleccion>_id`
uno de ellos, para que «Obtener» no dé `404`; sin ejemplos, valen `1`. En Bruno y Postman, «Obtener» guarda la `ETag` en
`<coleccion>_etag` y «Listar» guarda `next` en `<coleccion>_next`; en los `.http` hay que
copiarla a mano en la variable de archivo (REST Client y JetBrains tienen sintaxis distintas
para encadenar respuestas).

Los cuerpos de ejemplo llevan los campos requeridos y los escalares opcionales que no son de
solo lectura; los objetos opcionales (relaciones, mapas de idioma) se omiten para que el
ejemplo no apunte a un elemento que no existe. Las `Idempotency-Key` son UUID fijos generados
al exportar, entre comillas como pide Structured Fields: repetir la petición no crea otro
elemento, que es justo lo que enseña.

## Pruebas

```bash
node tools/restep-export/test.mjs
```

Arranca el servidor de referencia en los puertos 8895 y 8896 (este con `RESTEP_TOKEN`), genera
los tres formatos, comprueba su estructura (Postman v2.1, bloques de `.bru`, `.http`), ejecuta
con un mini-analizador todas las peticiones de lectura de los `.http` y exige un `2xx`, prueba
que el servidor acepta los cuerpos de crear y actualizar, y exporta un descubrimiento de
archivo con acciones, una subcolección y `oauth`. Contra la referencia prueba también la
subcolección `reviews` (su padre de ejemplo tiene reseñas y «Obtener» da `200`), `include` con
profundidad 2, la relación `highlight` con `href`, la polimórfica `showcase` con `type`, y que el
servidor acepta las acciones de ejemplo: `low_stock` (`GET` de colección), `restock` (`POST` de
elemento con su `input` e `Idempotency-Key`), `find_or_create` e `inherit_tax` (idempotentes, sin
clave). Prueba también lo del borrador 6: el recurso
suelto `/shop` de la referencia (y que el servidor acepta su `PATCH`), versiones con sufijo y de
otra versión mayor, valores desconocidos, `id_from`, `anonymous: false`, recursos sueltos con
plantilla o `parent`, y un `service-desc` de otro origen (sin credenciales) y con `data:` (no se
sigue), con dos servidores propios en los puertos 8974 y 8975.

## Límites

- De `relations` solo genera la lectura con `include`: los cuerpos no enlazan relaciones. No
  cubre `sync`, `batch`, `filter-expr` ni `query-method`.
- No genera peticiones para los filtros con nombre (`named_filters`, §6.1) ni para `fields` en un
  recurso suelto (§5.9).
- No anota los avisos de retirada (`deprecations`, §5.5) en las peticiones que los usan.
- «Obtener» guarda la cabecera `ETag`; no lee `_etag` del cuerpo, que §7.2 garantiza aunque un
  proxy debilite la cabecera.
- Las relaciones con `href` (las de una subcolección o un recurso suelto, §3) no se usan: los
  cuerpos de ejemplo no llevan relaciones.
- Sin API en marcha (desde un archivo o con `--no-samples`), las variables de una subcolección
  valen `1`.
- Los valores de los filtros son de ejemplo y pueden no devolver elementos (pero sí `200`).
- El generador de cuerpos solo entiende lo sencillo de JSON Schema (`type`, `enum`, `const`,
  `default`, `examples`, `anyOf`/`oneOf`, `allOf` plano, `pattern` con unos pocos candidatos,
  `format`); no sigue `$ref`.

## Dudas sobre la spec

- Con el descubrimiento en un archivo no hay forma de saber la URL de la API: el documento no
  declara su propia raíz ni su origen, y sus `path` son rutas absolutas. Por eso existe
  `--base-url`. ¿Debería el descubrimiento poder declarar su raíz (como `servers` en OpenAPI)?
- Resuelto en el borrador 6: el cuerpo vacío de una acción es `{}` (§11.1) y toda petición con
  cuerpo a un recurso de Restep lleva `Content-Type: application/json` (§3).

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-export>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
