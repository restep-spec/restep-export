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
node tools/restep-export/restep-export.mjs http://localhost:8080/ --to http --out peticiones
node tools/restep-export/restep-export.mjs discovery.json --to bruno,postman --out exportado \
  --base-url https://api.example.com
```

| Opción | Qué hace |
|---|---|
| `--to <formatos>` | `http`, `bruno` o `postman`; varios separados por comas. Por defecto, los tres |
| `--out <carpeta>` | Dónde escribir (por defecto `./restep-export`). Con varios formatos, una subcarpeta por formato |
| `--base-url <url>` | Valor de `base_url`. Por defecto, el origen de la URL; con un archivo, `http://localhost:8080` |
| `--name <nombre>` | Nombre de la colección (por defecto, `Restep <host>`) |
| `--auth auto\|bearer\|none` | Añadir `Authorization: Bearer {{token}}`. `auto` (por defecto): solo si la API anuncia `oauth` |
| `--token <token>` | Token para leer la API al exportar. Nunca se escribe en los archivos |
| `-H "Nombre: valor"` | Cabecera extra al leer la API (repetible). Tampoco se escribe |
| `--no-samples` | No pide a la API un id de ejemplo por colección |

Con una URL, lee el descubrimiento de la raíz (o el enlazado con `rel="service-desc"`), los
esquemas que sean enlaces del mismo origen (§4.3) y el primer elemento de cada colección,
para usar su `id` como ejemplo. Con un archivo no hace ninguna petición.

## Qué genera por colección

| Petición | Cuándo |
|---|---|
| Listar, con `limit` (el menor de 10 y `max_limit`) | si `methods` incluye `GET` o no se declara |
| Un filtro por campo de `filter`, con su primer operador y un valor del tipo declarado (§6.1) | con `query` |
| Ordenar por las dos primeras claves de `sort`, la primera descendente (§6.2) | con `query` y `sort` |
| `fields` con dos campos de primer nivel (§6.3) | con `query` |
| `count=true` (§6.5) | si se declara `count` |
| Obtener un elemento | si `item_methods` incluye `GET` o no se declara |
| Crear, con un cuerpo de ejemplo del esquema `create` y `Idempotency-Key` (§7.1) | `POST`; la clave, con `writes` |
| Actualizar con merge patch e `If-Match: {{<coleccion>_etag}}` (§7.2) | `PATCH`; `If-Match`, con `writes` |
| Borrar con `If-Match` | `DELETE` |
| Cada acción, en `/coleccion:nombre` o `/coleccion/{{id}}:nombre`, con su `method` y un cuerpo de su `input`; `Idempotency-Key` si no es idempotente (§10.1) | con `actions` |

Variables: `base_url` y `token` en el entorno; `<coleccion>_id` (id de ejemplo),
`<coleccion>_etag` (con `writes`) y `<coleccion>_path_<var>` para cada variable de una
plantilla de URI (subcolecciones, §4.2). En Bruno y Postman, «Obtener» guarda la `ETag` en
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
archivo con acciones, una subcolección y `oauth`.

## Límites

- No cubre `relations` (`include`), `sync`, `batch`, `filter-expr` ni `query-method`.
- Las subcolecciones (rutas con plantilla) no tienen id de ejemplo: la variable vale `1`.
- Los valores de los filtros son de ejemplo y pueden no devolver elementos (pero sí `200`).
- El generador de cuerpos solo entiende lo sencillo de JSON Schema (`type`, `enum`, `const`,
  `default`, `examples`, `anyOf`/`oneOf`, `allOf` plano, `pattern` con unos pocos candidatos,
  `format`); no sigue `$ref`.

## Dudas sobre la spec

- Con el descubrimiento en un archivo no hay forma de saber la URL de la API: el documento no
  declara su propia raíz ni su origen, y sus `path` son rutas absolutas. Por eso existe
  `--base-url`. ¿Debería el descubrimiento poder declarar su raíz (como `servers` en OpenAPI)?
- §10.1 no dice si el cuerpo de una acción `POST` sin `input` declarado debe ser `{}` o vacío;
  se genera `{}`.
- §4.3 no dice qué `Content-Type` lleva el cuerpo de una acción; se usa `application/json`.

## Código y avisos

Código y avisos: <https://github.com/restep-spec/restep-export>. Ese repositorio se genera desde la web de
Restep, donde la herramienta se desarrolla junto a la [especificación](https://restep.wubytes.com/1/) y el servidor de
referencia: `vendor/` y `schema/` son copias de la web para que las pruebas funcionen solas.

Licencia MIT.
