# profiles-backend

API de las tarjetas de presentación digitales editables.
Express + Mongoose, desplegada en un VPS detras de Nginx.

En produccion vive en **https://backtarjetas.ecodama.online**

Frontend: [profiles-frontend](https://github.com/DancingAlien96/profiles-frontend)

## Cómo encaja con el frontend

```
El cliente abre su página  ──►  HTML estático en Netlify   (instantáneo)
                                        │
Pulsa el botón de editar   ──►  esta API (VPS) + MongoDB    (solo el dueño)
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
- **En Network Access hay que autorizar la IP del VPS.** Como el VPS tiene IP
  fija, se agrega solo esa en vez de abrir `0.0.0.0/0`. Sin esto la API arranca
  pero no logra conectarse, y el error no es evidente.

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
chmod 600 .env                          # contiene las credenciales de Atlas

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
- que Atlas conecte y que la base no sea `test`.

El arranque también valida la configuración: si falta una variable, el
`JWT_SECRET` sigue siendo el de ejemplo o la URI de Atlas no trae el nombre de
la base, el servicio no arranca y dice exactamente qué corregir.

Para actualizar tras un cambio:

```bash
cd /var/www/perfiles-api && git pull && npm ci --omit=dev && sudo systemctl restart perfiles-api
```

Los logs salen en `journalctl -u perfiles-api -f`.

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
modo que las visitas nunca le piden imágenes al VPS.

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
