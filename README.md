# profiles-backend

API de las tarjetas de presentación digitales editables.
Express + SQLite, desplegada en un VPS detrás de Nginx.

En produccion vive en **https://backtarjetas.ecodama.online**

Frontend: [profiles-frontend](https://github.com/DancingAlien96/profiles-frontend)

## Cómo encaja con el frontend

```
El cliente abre su página  ──►  HTML estático en Netlify   (instantáneo)
                                        │
Pulsa el botón de editar   ──►  esta API (VPS) + SQLite     (solo el dueño)
                                        │
              Al guardar   ──►  build hook de Netlify
                                        │
                                Netlify regenera las páginas leyendo esta API
```

La página pública **no** consulta esta API. Aunque el VPS responde siempre, el
contenido tiene que estar en el HTML para que WhatsApp y LinkedIn muestren
nombre, cargo y foto al compartir el enlace: sus crawlers no ejecutan
JavaScript. Como efecto secundario, el sitio carga al instante y el VPS no
recibe tráfico de visitantes, solo de ediciones.

Los rebuilds se agrupan con un temporizador (`REBUILD_DELAY_SECONDS`): si el
cliente guarda cinco veces seguidas mientras acomoda su perfil, se dispara un
solo build.

## Rutas

| Método | Ruta | Acceso |
|---|---|---|
| `GET` | `/api/health` | público — para el build y el monitoreo |
| `GET` | `/api/profiles` | público — la consume el build de Netlify |
| `GET` | `/api/profiles/:slug` | público |
| `GET` | `/api/profiles/:slug/photo` | público |
| `POST` | `/api/auth/login` | público — `{ slug, password }` |
| `POST` | `/api/auth/password` | dueño (token) |
| `PUT` | `/api/profiles/:slug` | dueño (token) |
| `PUT` | `/api/profiles/:slug/photo` | dueño (token) |
| `GET` | `/api/profiles/disponible/:slug` | público — comprueba si la dirección está libre |
| `POST` | `/api/profiles/registro` | público, con token de invitación |
| `GET` | `/api/invitations/:token` | público — estado de una invitación |
| `GET` | `/api/profiles/todos` | admin (`x-admin-key`) |
| `POST` | `/api/invitations` | admin (`x-admin-key`) |
| `GET` | `/api/invitations` | admin (`x-admin-key`) |
| `DELETE` | `/api/invitations/:token` | admin (`x-admin-key`) |
| `POST` | `/api/profiles` | admin (`x-admin-key`) |
| `POST` | `/api/profiles/:slug/reset-password` | admin (`x-admin-key`) |
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

La base abre en modo WAL, de forma que el build del frontend puede leer los
perfiles mientras un cliente guarda, sin que ninguno espere al otro.

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

En `deploy/` están la unidad de systemd y la configuración de Nginx.

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

sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/backtarjetas
sudo ln -s /etc/nginx/sites-available/backtarjetas /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d backtarjetas.ecodama.online
```

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
- que el dominio responda por HTTPS, que es obligatorio porque el sitio en
  Netlify se sirve por HTTPS y el navegador bloquea el contenido mixto;
- que `CORS_ORIGINS` incluya el dominio de Netlify, que si falta produce un
  error de CORS poco descriptivo en el navegador del cliente;
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
`src/routes/profiles.js`; si algún día agregas una página nueva al frontend,
añade su nombre ahí.

## Fotos

Se guardan en la propia base, como BLOB. El navegador recorta la foto cuadrada,
la escala a 400×400 y la convierte a WebP **antes** de subirla; medido con
fotos reales, cada una queda en unos 15 KB. La API rechaza cualquier imagen
mayor a 200 KB como red de seguridad.

Durante el build, Netlify las baja y las publica como archivos estáticos, de
modo que las visitas nunca le piden imágenes al VPS.

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
