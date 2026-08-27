# profiles-backend

API de las tarjetas de presentación digitales editables.
Express + Mongoose, pensada para el plan gratuito de Render.

Frontend: [profiles-frontend](https://github.com/DancingAlien96/profiles-frontend)

## Cómo encaja con el frontend

```
El cliente abre su página  ──►  HTML estático en Netlify   (instantáneo)
                                        │
Pulsa el botón de editar   ──►  esta API + MongoDB          (solo el dueño)
                                        │
              Al guardar   ──►  build hook de Netlify
                                        │
                                Netlify regenera las páginas leyendo esta API
```

La página pública **no** consulta esta API. El plan gratuito de Render duerme
el servicio tras 15 minutos sin tráfico y despertarlo tarda cerca de un minuto:
si la tarjeta hiciera un fetch al cargar, quien reciba el enlace por WhatsApp
vería una pantalla en blanco todo ese rato. Aquí la API solo participa cuando
el dueño edita, y al guardar dispara el build hook para que Netlify regenere
el HTML.

Los rebuilds se agrupan con un temporizador (`REBUILD_DELAY_SECONDS`): si el
cliente guarda cinco veces seguidas mientras acomoda su perfil, se dispara un
solo build.

## Rutas

| Método | Ruta | Acceso |
|---|---|---|
| `GET` | `/api/health` | público — también despierta el servicio |
| `GET` | `/api/profiles` | público — la consume el build de Netlify |
| `GET` | `/api/profiles/:slug` | público |
| `GET` | `/api/profiles/:slug/photo` | público |
| `POST` | `/api/auth/login` | público — `{ slug, password }` |
| `POST` | `/api/auth/password` | dueño (token) |
| `PUT` | `/api/profiles/:slug` | dueño (token) |
| `PUT` | `/api/profiles/:slug/photo` | dueño (token) |
| `POST` | `/api/profiles` | admin (`x-admin-key`) |
| `POST` | `/api/profiles/:slug/reset-password` | admin (`x-admin-key`) |
| `PATCH` | `/api/profiles/:slug/published` | admin (`x-admin-key`) |

## Puesta en marcha

### MongoDB Atlas

Cluster gratuito (M0) con una base llamada `perfiles`.

Dos detalles que cuestan tiempo si se pasan por alto:

- **La cadena que copia Atlas no incluye el nombre de la base.** Termina en
  `.mongodb.net/?appName=...`; hay que insertar `/perfiles` antes del `?` o
  Mongoose escribirá en una base llamada `test`.
- **En Network Access hay que agregar `0.0.0.0/0`.** El plan gratuito de
  Render no tiene IPs fijas. Sin esto la API despliega bien pero no logra
  conectarse, y el error no es evidente.

### Local

```bash
npm install
cp .env.example .env   # y llena los valores
npm run dev
```

Genera el `JWT_SECRET` con:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Render

`render.yaml` ya trae la configuración. Carga las variables de `.env.example`
en el panel. Cuando el sitio de Netlify exista, agrega su dominio a
`CORS_ORIGINS` y pega su build hook en `NETLIFY_BUILD_HOOK`.

## Administrar clientes

```bash
npm run crear-perfil -- --slug juanperez --nombre "Juan Pérez" --tel 47694804 --cargo "Arquitecto" --tema marfil-oro
```

Imprime la clave inicial (por ejemplo `Juan4804`): el primer nombre más los
últimos cuatro dígitos del teléfono. Se la entregas al cliente y el panel le
exigirá cambiarla en cuanto entre.

```bash
npm run borrar-perfil -- --slug juanperez
```

Para ocultar un perfil sin perder los datos, usa
`PATCH /api/profiles/<slug>/published` con la cabecera `x-admin-key`.

## Fotos

Se guardan en MongoDB. Para que eso sea sostenible, el navegador recorta la
foto cuadrada, la escala a 400×400 y la convierte a WebP **antes** de subirla
(unos 40 KB cada una), y la API rechaza cualquier imagen mayor a 200 KB.
Durante el build, Netlify las baja y las publica como archivos estáticos, de
modo que la página nunca le pide la imagen a Render.

Con esos tamaños, los 512 MB del cluster gratuito dan para miles de perfiles.

## Seguridad

- Las claves se guardan con bcrypt (12 rondas), nunca en texto plano.
- Cambio de clave obligatorio en el primer ingreso: la inicial se deriva del
  nombre y el teléfono, así que cualquiera con la tarjeta podría adivinarla.
- Máximo 20 intentos por IP cada 15 minutos, y bloqueo del perfil por 15
  minutos tras 8 fallos.
- El login responde igual exista o no el perfil, para no revelar qué slugs
  están registrados.
- La sesión dura 2 horas.
- Un cliente solo puede editar su propio perfil, y solo los campos de
  contenido: el slug, la clave y el estado de publicación no son editables
  desde el panel.

## Pruebas

```bash
npm test
```

Levanta una MongoDB en memoria y recorre el flujo completo: creación, login,
permisos entre clientes, subida de foto, límites y cambio de clave.
