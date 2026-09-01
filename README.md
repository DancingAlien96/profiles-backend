# profiles-backend

API de las tarjetas de presentación digitales editables.
Express + SQLite, desplegada en un VPS detrás de Nginx.

En producción responde bajo **https://www.professionalprofiles.online/api**,
detrás del mismo Nginx que sirve el sitio. No tiene dominio propio.

Frontend: [profiles-frontend](https://github.com/DancingAlien96/profiles-frontend)

## Cómo encaja con el frontend

```
Una visita abre la tarjeta  ──►  Nginx ──► Astro (Node) ──► esta API ──► SQLite
                                   │
Pulsa el botón de editar    ──►  Nginx ──► /api ───────────► esta API ──► SQLite
                                   │
              Al guardar    ──►  el cambio se ve al instante, sin publicar nada
```

Las tarjetas se generan **al pedirlas**, en el mismo VPS. La respuesta lleva
HTML completo, que es lo que necesitan los crawlers de WhatsApp y LinkedIn para
mostrar nombre, cargo y foto al compartir el enlace: no ejecutan JavaScript.

Antes el sitio era estático en Netlify y cada guardado disparaba un build. Esta
API llevaba el build hook, agrupaba los guardados y racionaba los deploys para
no agotar los créditos del plan gratuito. Nada de eso queda: guardar solo
escribe en SQLite.

A cambio, esta API sí recibe el tráfico de los visitantes, no solo el de las
ediciones. Nginx cachea las tarjetas 60 segundos, así que una racha de visitas
al mismo perfil no llega hasta aquí.

## Rutas

| Método | Ruta | Acceso |
|---|---|---|
| `GET` | `/api/health` | público — para el monitoreo del VPS |
| `GET` | `/api/profiles` | público — lista de perfiles publicados |
| `GET` | `/api/profiles/:slug` | público |
| `GET` | `/api/profiles/:slug/photo` | público |
| `POST` | `/api/auth/login` | público — `{ slug, password }` |
| `POST` | `/api/auth/password` | dueño (token) |
| `PUT` | `/api/profiles/:slug` | dueño (token) |
| `PUT` | `/api/profiles/:slug/photo` | dueño (token) |
| `GET` | `/api/profiles/disponible/:slug` | público — comprueba si la dirección está libre |
| `POST` | `/api/profiles/registro` | público — con invitación o sin ella |
| `GET` | `/api/invitations/:token` | público — estado de una invitación |
| `GET` | `/api/profiles/todos` | admin (`x-admin-key`) |
| `POST` | `/api/invitations` | admin (`x-admin-key`) |
| `GET` | `/api/invitations` | admin (`x-admin-key`) |
| `DELETE` | `/api/invitations/:token` | admin (`x-admin-key`) |
| `POST` | `/api/profiles` | admin (`x-admin-key`) |
| `GET` | `/api/profiles/:slug/cupo` | dueño (token) — cambios que le quedan hoy |
| `POST` | `/api/profiles/:slug/reset-password` | admin (`x-admin-key`) |
| `POST` | `/api/profiles/:slug/reiniciar-cambios` | admin (`x-admin-key`) |
| `DELETE` | `/api/profiles/:slug` | admin — borra y libera la dirección |
| `POST` | `/api/webhooks/recurrente` | la pasarela — firmado con Svix |
| `PATCH` | `/api/profiles/:slug/published` | admin (`x-admin-key`) |

## Puesta en marcha

### Base de datos

SQLite, en un solo archivo. No hay servidor de base de datos que instalar,
configurar ni mantener: el proyecto tiene decenas de perfiles, con escrituras
esporádicas de un cliente a la vez, que es justo donde SQLite rinde mejor.

La ruta se define en `DB_PATH`. En el VPS conviene ponerla **fuera** del
directorio del código, para que un `git pull` nunca la roce:

```bash
sudo mkdir -p /var/lib/perfiles-api
sudo chown deploy:deploy /var/lib/perfiles-api
sudo chmod 700 /var/lib/perfiles-api
# en el .env:  DB_PATH=/var/lib/perfiles-api/perfiles.db
```

El archivo contiene los hashes de las claves de tus clientes, así que no debe
quedar legible por otros usuarios del sistema. `npm run verificar` lo comprueba.

La base abre en modo WAL, de forma que una visita puede leer la tarjeta
mientras su dueño la guarda, sin que ninguna espere a la otra.

### Respaldos

```bash
npm run respaldar
```

Usa la API de backup de SQLite, que produce una copia consistente aunque
alguien esté guardando en ese momento — copiar el archivo con `cp` mientras hay
escrituras puede dejarte una copia corrupta. Conserva los últimos 14 y borra
los más viejos.

Para automatizarlo hay una línea de cron lista en
`deploy/respaldo-diario.cron`.

Restaurar es reemplazar el archivo:

```bash
sudo systemctl stop perfiles-api
cp /var/lib/perfiles-api/respaldos/perfiles-2026-08-27_03-00-00.db /var/lib/perfiles-api/perfiles.db
sudo systemctl start perfiles-api
```

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

### VPS

En `deploy/` está la unidad de systemd. **Nginx no se configura aquí:** la API
no tiene dominio propio ni sitio de Nginx propio. Se llega a ella por `/api`
del dominio del sitio, y ese bloque vive en el repo del frontend
(`deploy/nginx.conf.example` de profiles-frontend).

```bash
# en el VPS
git clone https://github.com/DancingAlien96/profiles-backend.git /var/www/perfiles-api
cd /var/www/perfiles-api
npm ci --omit=dev
cp .env.example .env && nano .env      # llena los valores
chmod 600 .env

sudo cp deploy/perfiles-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now perfiles-api
sudo systemctl status perfiles-api
```

La API escucha solo en `127.0.0.1`, así que hasta que el Nginx del frontend
esté levantado no responde desde fuera. Es lo esperado.

### Comprobar el despliegue

```bash
npm run verificar
```

Corre esto **en el VPS** después de desplegar. Comprueba las cosas que fallan
en silencio y dice cómo arreglar cada una:

- que la API escuche solo en localhost y que el puerto 3000 no sea alcanzable
  desde internet, saltándose Nginx y HTTPS;
- que Nginx pase `X-Forwarded-For`; sin esa cabecera el límite de intentos ve
  una sola IP y bloquea a todos los clientes juntos;
- que el dominio responda por HTTPS, que es obligatorio porque el sitio se
  sirve por HTTPS y el navegador bloquea el contenido mixto;
- que `CORS_ORIGINS` tenga el dominio público del sitio y no solo orígenes
  locales;
- que la base abra, esté en modo WAL y no sea legible por otros usuarios.

El arranque también valida la configuración: si falta una variable, el
`JWT_SECRET` sigue siendo el de ejemplo o no se puede escribir en el directorio
de la base, el servicio no arranca y dice exactamente qué corregir.

Para actualizar tras un cambio:

```bash
cd /var/www/perfiles-api && git pull && npm ci --omit=dev && sudo systemctl restart perfiles-api
```

Los logs salen en `journalctl -u perfiles-api -f`.

## Dar de alta a un cliente

Lo normal es que el cliente cree su propia tarjeta desde un enlace de
invitación. Se genera desde el panel en `/admin` del sitio, o desde aquí:

```bash
npm run invitar -- --para "Clara Molina" --plantilla abogado
npm run invitar -- --listar
```

El enlace **sirve una sola vez** y caduca a los 14 días. Sin eso, quien
reenviara el enlace podría dar de alta perfiles en tu dominio sin control.

### Tarjetas NFC y códigos QR

Si vas a imprimir el QR o grabar la tarjeta NFC **antes** de que el cliente
llene el formulario, fija la dirección al generar la invitación:

```bash
npm run invitar -- --para "Dr. López" --plantilla salud --slug dr-lopez
```

Esa dirección queda apartada (nadie más puede tomarla) y el formulario se la
muestra al cliente bloqueada. Aunque manipule el campo, el servidor usa la
dirección de la invitación e ignora lo que llegue en la petición.

**Una dirección no cambia nunca una vez creado el perfil.** No hay ninguna ruta
que lo permita: el cliente solo edita contenido. Eso es lo que hace seguro
quemar la URL en material impreso.

Si anulas una invitación sin usar, la dirección vuelve a quedar libre.

### Clientes que se llaman igual

Dos "Juan Pérez" generan el mismo slug, y el segundo no se crea: la dirección
es clave primaria y se valida antes. Para que nadie se quede atascado,
`GET /api/profiles/disponible/:slug` devuelve además una `sugerencia` con la
primera variante libre (`juan-perez-2`), que esquiva también las direcciones
reservadas y las apartadas por invitaciones pendientes.

En el formulario el cliente elige su propia clave, así que no hay claves
adivinables circulando por WhatsApp.

### Crear un perfil tú mismo

Si prefieres montarlo tú y entregarlo hecho:

```bash
npm run crear-perfil -- --slug juanperez --nombre "Juan Pérez" --tel 47694804 --cargo "Arquitecto" --tema marfil-oro
```

Imprime la clave inicial (por ejemplo `Juan4804`): el primer nombre más los
últimos cuatro dígitos del teléfono. Como esa clave es adivinable, el panel le
exige cambiarla en cuanto entre.

```bash
npm run borrar-perfil -- --slug juanperez
```

Para ocultar un perfil sin perder los datos, usa el botón del panel o
`PATCH /api/profiles/<slug>/published` con la cabecera `x-admin-key`.

### Direcciones reservadas

Un cliente no puede tomar slugs como `crear`, `admin`, `api`, `fotos` u `og`:
chocarían con páginas del sitio o rutas de la API. La lista está en
`src/models/Profile.js`; si algún día agregas una página nueva al frontend,
añade su nombre ahí.

## Límite de cambios al día

Cada cliente tiene **100 cambios al día** (`EDICIONES_POR_DIA`); al agotarlos,
el guardado se rechaza con un mensaje claro y su perfil queda como estaba.

Sirviendo el sitio desde el VPS, guardar no cuesta nada: el tope ya no protege
ningún presupuesto y queda solo como freno ante un abuso o un fallo que dispare
guardados en bucle. Por eso es alto — un cliente acomodando su perfil no lo
roza.

El día se cuenta en la zona del negocio (`ZONA_HORARIA`), no en la del
servidor: con el VPS en UTC, el contador se reiniciaría a media tarde para un
cliente en Guatemala.

Subir y cambiar la foto también cuenta.

Si alguien se queda sin cambios y lo necesita, se los devuelves desde el panel
con el botón **Dar cambios**, o con
`POST /api/profiles/<slug>/reiniciar-cambios` y la cabecera `x-admin-key`.

## Enlaces

El cliente escribe lo mínimo y la API arma la dirección. Nadie tiene que
saberse el `https://wa.me/502…` de memoria:

| Escribe | Se guarda |
|---|---|
| `4769 4804` (WhatsApp) | `https://wa.me/50247694804` |
| `2233 4455` (teléfono) | `tel:+50222334455` |
| `clara@bufete.gt` | `mailto:clara@bufete.gt` |
| `@salonbella` | `https://instagram.com/salonbella` |
| `midominio.com` | `https://midominio.com` |

Si pega la dirección completa, se respeta tal cual. La normalización vive en
`src/lib/enlaces.js` y se aplica al guardar, así que vale igual desde el
formulario, el panel o una llamada directa a la API.

El código de país sale de `CODIGO_PAIS` (por defecto `502`); un número que ya
lo traiga se deja como está.

## Servicios

Lista opcional de hasta 8, cada uno `{ label, icon }`. El icono sale de un
catálogo cerrado (`src/lib/servicios.js`); cualquier otro valor cae en el de
por defecto, para que nadie meta marcado suelto en su propia página.

Se muestran en una cuadrícula bajo la descripción.

## Horario de atención

Opcional. Se guarda como JSON en la columna `hours`:

```json
{
  "tz": "America/Guatemala",
  "days": [
    { "ranges": [["08:00","12:00"], ["14:00","18:00"]] },
    { "closed": true }
  ]
}
```

Siete entradas, **la primera es lunes**. Se admiten dos turnos por día porque
cerrar a mediodía es lo normal aquí.

La API valida el formato de las horas, que el cierre sea posterior a la
apertura, que los dos turnos no se solapen y que la zona horaria exista. Un
horario con los siete días cerrados se guarda como `null` y la tarjeta
simplemente no muestra la sección.

El "abierto ahora" lo calcula el navegador de quien mira la tarjeta, no el
build: si no, la página quedaría congelada con el estado que hubiera al
generarse. Se calcula en la zona del negocio, así que alguien que abra la
tarjeta desde otro país ve si está abierto **allá**.

## Fotos

Se guardan en la propia base, como BLOB. El navegador recorta la foto cuadrada,
la escala a 400×400 y la convierte a WebP **antes** de subirla; medido con
fotos reales, cada una queda en unos 15 KB. La API rechaza cualquier imagen
mayor a 200 KB como red de seguridad.

El frontend las pide una vez por `/api/profiles/:slug/photo` y las cachea en
disco bajo `/fotos/<slug>.webp`, con la fecha de la foto en la clave: al
cambiarla se genera una entrada nueva y la anterior deja de usarse sola.

Con ese tamaño, mil perfiles ocupan unos 15 MB: el límite práctico es el disco
del VPS.

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
- Las invitaciones son de un solo uso y caducan; un alta que falla a mitad no
  quema la invitación, porque se hace en una transacción.
- Las rutas de administración están limitadas a 60 intentos por IP cada 15
  minutos, y el alta pública a 15 por hora.

## Pruebas

```bash
npm test
```

Levanta la API con una base SQLite en memoria y recorre el flujo completo:
creación, login, permisos entre clientes, subida de foto, límites y cambio de
clave. Tarda unos segundos y no toca la base real.
