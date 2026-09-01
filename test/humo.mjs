/**
 * Prueba de humo del flujo completo, contra una base SQLite en memoria.
 * No toca la base real ni necesita red.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { conectarDB, cerrarDB } from '../src/db.js';

const ADMIN_KEY = 'clave-admin-de-prueba';
process.env.JWT_SECRET = 'secreto-de-prueba-suficientemente-largo';
process.env.ADMIN_KEY = ADMIN_KEY;

// El conjunto hace muchos mas de 20 guardados sobre el mismo perfil, asi que
// el limite diario se levanta y solo se baja en las pruebas que lo verifican.
process.env.EDICIONES_POR_DIA = '10000';
const LIMITE_PRUEBA = 20;

let BASE;
let servidor;
const fallos = [];

const prueba = async (nombre, fn) => {
  try {
    await fn();
    console.log(`  ok   ${nombre}`);
  } catch (err) {
    fallos.push(nombre);
    console.error(`  FALLA ${nombre}\n        ${err.message}`);
  }
};

async function pedir(ruta, opciones = {}) {
  const res = await fetch(`${BASE}${ruta}`, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', ...opciones.headers },
  });
  const cuerpo = await res.json().catch(() => ({}));
  return { estado: res.status, cuerpo };
}

/* --------------------------------------------------------- arranque */

// Base en memoria: cada corrida arranca limpia y no toca ningun archivo.
conectarDB(':memory:');

/**
 * Doble de la pasarela de pagos.
 *
 * El alta llama a Recurrente para abrir el cobro, y las pruebas no deben salir
 * a internet ni cobrarle a nadie. Se levanta un servidor que responde como
 * ella y que ademas guarda lo que recibio, para poder comprobar que cada
 * cobro sale etiquetado con la tarjeta a la que pertenece.
 */
const { createServer } = await import('node:http');
export const checkoutsPedidos = [];

export const cancelaciones = [];
export let fallarCancelacion = false;

const pasarela = await new Promise((resolve) => {
  const s = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', () => {
      // Cancelar una suscripcion: DELETE /subscriptions/<id>
      if (req.method === 'DELETE') {
        if (fallarCancelacion) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'la pasarela no responde' }));
        }
        cancelaciones.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Suscripcion cancelada' }));
      }

      checkoutsPedidos.push({ ruta: req.url, cuerpo: JSON.parse(cuerpo || '{}') });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      const id = `ch_prueba_${checkoutsPedidos.length}`;
      res.end(JSON.stringify({ id, checkout_url: `https://pasarela.example/${id}`, status: 'unpaid' }));
    });
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});

/**
 * Doble de Resend. Guarda los avisos en vez de mandarlos, y sabe fallar a
 * propósito para comprobar que un correo caido no arrastra al cobro.
 */
export const correosEnviados = [];
export let fallarCorreo = false;

const correos = await new Promise((resolve) => {
  const s = createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', () => {
      if (fallarCorreo) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'fallo simulado' }));
      }
      correosEnviados.push(JSON.parse(cuerpo || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `email_${correosEnviados.length}` }));
    });
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});

/**
 * Espera a que lleguen los avisos.
 *
 * El webhook no aguarda al correo a proposito —un Resend caido no puede
 * costarle la tarjeta a quien ya pago— asi que el aviso llega despues de que
 * la peticion haya respondido. La prueba es la que tiene que esperar.
 */
async function esperarCorreos(cuantos, ms = 2000) {
  const limite = Date.now() + ms;
  while (correosEnviados.length < cuantos && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return correosEnviados.length;
}

process.env.RESEND_API_URL = `http://127.0.0.1:${correos.address().port}`;
process.env.RESEND_API_KEY = 're_de_prueba';
process.env.EMAIL_AVISOS = 'avisos@ejemplo.test';

process.env.RECURRENTE_API_URL = `http://127.0.0.1:${pasarela.address().port}`;
process.env.RECURRENTE_PUBLIC_KEY = 'pk_de_prueba';
process.env.RECURRENTE_SECRET_KEY = 'sk_de_prueba';
process.env.RECURRENTE_PRICE_ID = 'price_de_prueba';

// La app se levanta en este mismo proceso, en un puerto que asigna el sistema.
const { createApp } = await import('../src/app.js');
servidor = await new Promise((resolve) => {
  const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
});
BASE = `http://127.0.0.1:${servidor.address().port}`;

const salud = await fetch(`${BASE}/api/health`);
assert.ok(salud.ok, 'el health check deberia responder');

/* ---------------------------------------------------------- pruebas */

console.log('\nPruebas:');

let token;

await prueba('crear perfil exige la clave de administrador', async () => {
  const { estado } = await pedir('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({ slug: 'intruso', name: 'X', password: 'x' }),
  });
  assert.equal(estado, 401);
});

await prueba('el administrador crea un perfil', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      slug: 'juanperez',
      name: 'Juan Pérez',
      role: 'Arquitecto',
      password: 'Juan4804',
      theme: 'marfil-oro',
    }),
  });
  assert.equal(estado, 201);
  assert.equal(cuerpo.profile.mustChangePassword, true);
});

await prueba('el perfil publico no expone la clave', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(cuerpo.name, 'Juan Pérez');
  assert.equal(cuerpo.passwordHash, undefined);
});

await prueba('rechaza una clave incorrecta', async () => {
  const { estado } = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'juanperez', password: 'noesesta' }),
  });
  assert.equal(estado, 401);
});

await prueba('acepta la clave correcta', async () => {
  const { estado, cuerpo } = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'juanperez', password: 'Juan4804' }),
  });
  assert.equal(estado, 200);
  assert.ok(cuerpo.token);
  token = cuerpo.token;
});

await prueba('sin token no se puede editar', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    body: JSON.stringify({ name: 'Hackeado' }),
  });
  assert.equal(estado, 401);
});

await prueba('el dueño guarda sus cambios', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Juan Pérez López',
      tagline: 'Diseño de espacios.',
      links: [{ type: 'whatsapp', label: 'WhatsApp', sublabel: '+502 4769 4804', url: 'https://wa.me/50247694804' }],
    }),
  });
  assert.equal(estado, 200);
  assert.equal(cuerpo.profile.name, 'Juan Pérez López');
  assert.equal(cuerpo.profile.links.length, 1);
});

await prueba('el slug y la clave no son editables por el cliente', async () => {
  await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug: 'otro', passwordHash: 'inyectado', published: false }),
  });
  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(cuerpo.slug, 'juanperez');
  assert.equal(cuerpo.published, true);
});

await prueba('un cliente no puede editar el perfil de otro', async () => {
  await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ slug: 'otrocliente', name: 'Otro', password: 'Otro1234' }),
  });
  const { estado } = await pedir('/api/profiles/otrocliente', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Secuestrado' }),
  });
  assert.equal(estado, 403);
});

await prueba('guarda y devuelve la foto', async () => {
  // PNG de 1x1 pixel
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const { estado } = await pedir('/api/profiles/juanperez/photo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataUrl }),
  });
  assert.equal(estado, 200);

  const res = await fetch(`${BASE}/api/profiles/juanperez/photo`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');

  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(cuerpo.hasPhoto, true);
});

await prueba('rechaza una imagen demasiado grande', async () => {
  const enorme = `data:image/png;base64,${'A'.repeat(300 * 1024)}`;
  const { estado } = await pedir('/api/profiles/juanperez/photo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataUrl: enorme }),
  });
  assert.equal(estado, 413);
});

await prueba('rechaza un tipo de enlace inventado', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'onlyfans', label: 'X', url: 'https://x.com' }] }),
  });
  assert.equal(estado, 400);
});

await prueba('el cambio de clave funciona y la anterior deja de servir', async () => {
  const { estado } = await pedir('/api/auth/password', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ newPassword: 'MiClaveNueva2026' }),
  });
  assert.equal(estado, 200);

  const vieja = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'juanperez', password: 'Juan4804' }),
  });
  assert.equal(vieja.estado, 401);

  const nueva = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'juanperez', password: 'MiClaveNueva2026' }),
  });
  assert.equal(nueva.estado, 200);
  assert.equal(nueva.cuerpo.profile.mustChangePassword, false);
});

await prueba('rechaza una clave nueva demasiado corta', async () => {
  const { estado } = await pedir('/api/auth/password', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ newPassword: 'corta' }),
  });
  assert.equal(estado, 400);
});

await prueba('la lista publica alimenta el build', async () => {
  const { cuerpo } = await pedir('/api/profiles');
  assert.ok(Array.isArray(cuerpo));
  assert.equal(cuerpo.length, 2);
  assert.ok(cuerpo.every((p) => p.passwordHash === undefined));
});

/* ------------------------------------------- invitaciones y auto-alta */

let invitacion;

await prueba('crear invitaciones exige la clave de administrador', async () => {
  const { estado } = await pedir('/api/invitations', {
    method: 'POST',
    body: JSON.stringify({ nota: 'intruso' }),
  });
  assert.equal(estado, 401);
});

await prueba('el administrador genera una invitacion', async () => {
  const { estado, cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'Clara Molina', plantilla: 'abogado' }),
  });
  assert.equal(estado, 201);
  assert.ok(cuerpo.invitacion.token);
  invitacion = cuerpo.invitacion.token;
});

await prueba('la invitacion se consulta sin gastarla y no filtra la nota', async () => {
  const { estado, cuerpo } = await pedir(`/api/invitations/${invitacion}`);
  assert.equal(estado, 200);
  assert.equal(cuerpo.plantilla, 'abogado');
  assert.equal(cuerpo.nota, undefined);
});

await prueba('una invitacion inventada se rechaza', async () => {
  const { estado } = await pedir('/api/invitations/noexiste');
  assert.equal(estado, 410);
});

await prueba('avisa si la direccion ya esta ocupada', async () => {
  const { cuerpo } = await pedir('/api/profiles/disponible/juanperez');
  assert.equal(cuerpo.disponible, false);
});

await prueba('no deja tomar una direccion reservada', async () => {
  const { cuerpo } = await pedir('/api/profiles/disponible/admin');
  assert.equal(cuerpo.disponible, false);
});

await prueba('acepta una direccion libre', async () => {
  const { cuerpo } = await pedir('/api/profiles/disponible/clara-molina');
  assert.equal(cuerpo.disponible, true);
});

await prueba('una invitacion invalida se rechaza aunque exista el alta publica', async () => {
  // Abrir el alta al publico no debe convertir un token quemado o inventado en
  // algo que se acepte en silencio: si el enlace dice algo, tiene que ser
  // cierto.
  const { estado } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: 'token-que-no-existe',
      slug: 'colado',
      name: 'Colado',
      password: 'ClaveLarga1',
    }),
  });
  assert.equal(estado, 410);
});

await prueba('el cliente crea su perfil con la invitacion', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: invitacion,
      slug: 'clara-molina',
      name: 'Clara Molina',
      role: 'Abogada y Notaria',
      theme: 'marfil-oro',
      password: 'MiClavePropia2026',
      links: [{ type: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/50212345678' }],
    }),
  });
  assert.equal(estado, 201);
  assert.equal(cuerpo.profile.slug, 'clara-molina');
  assert.equal(cuerpo.profile.mustChangePassword, false);
});

await prueba('el cliente entra con la clave que eligio', async () => {
  const { estado } = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'clara-molina', password: 'MiClavePropia2026' }),
  });
  assert.equal(estado, 200);
});

await prueba('la invitacion ya no sirve una segunda vez', async () => {
  const { estado } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: invitacion,
      slug: 'otro-mas',
      name: 'Otro Mas',
      password: 'ClaveLarga2026',
    }),
  });
  assert.equal(estado, 410);
});

await prueba('una invitacion caducada se rechaza', async () => {
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'vieja', dias: 1 }),
  });
  const { obtenerDB } = await import('../src/db.js');
  obtenerDB()
    .prepare('UPDATE invitations SET expires_at = ? WHERE token = ?')
    .run('2020-01-01T00:00:00.000Z', cuerpo.invitacion.token);

  const { estado } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: cuerpo.invitacion.token,
      slug: 'tarde-piaste',
      name: 'Tarde Piaste',
      password: 'ClaveLarga2026',
    }),
  });
  assert.equal(estado, 410);
});

await prueba('el registro rechaza una clave corta', async () => {
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'prueba clave' }),
  });
  const { estado } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: cuerpo.invitacion.token,
      slug: 'clave-corta',
      name: 'Clave Corta',
      password: 'abc',
    }),
  });
  assert.equal(estado, 400);
});

await prueba('una invitacion no se gasta si el alta falla', async () => {
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'reintento' }),
  });
  const token = cuerpo.invitacion.token;

  const fallo = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({ token, slug: 'clara-molina', name: 'X', password: 'ClaveLarga2026' }),
  });
  assert.equal(fallo.estado, 409);

  const exito = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token, slug: 'segundo-intento', name: 'Segundo Intento', password: 'ClaveLarga2026',
    }),
  });
  assert.equal(exito.estado, 201);
});

/* ------------------------------ direccion fijada (tarjetas NFC y QR) */

await prueba('la direccion fijada aparta el slug para nadie mas', async () => {
  const { estado, cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'Tarjeta NFC impresa', slug: 'dr-lopez' }),
  });
  assert.equal(estado, 201);
  assert.equal(cuerpo.invitacion.slug, 'dr-lopez');

  // Ya no debe ofrecerse a nadie mas
  const libre = await pedir('/api/profiles/disponible/dr-lopez');
  assert.equal(libre.cuerpo.disponible, false);
});

await prueba('no deja apartar dos veces la misma direccion', async () => {
  const { estado } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'duplicada', slug: 'dr-lopez' }),
  });
  assert.equal(estado, 409);
});

await prueba('no deja apartar una direccion reservada', async () => {
  const { estado } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'reservada', slug: 'admin' }),
  });
  assert.equal(estado, 409);
});

await prueba('no deja apartar la direccion de un perfil existente', async () => {
  const { estado } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'ocupada', slug: 'juanperez' }),
  });
  assert.equal(estado, 409);
});

await prueba('el formulario recibe la direccion fijada', async () => {
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'con QR', slug: 'lic-ramirez' }),
  });
  const estado = await pedir(`/api/invitations/${cuerpo.invitacion.token}`);
  assert.equal(estado.cuerpo.slug, 'lic-ramirez');
});

await prueba('el cliente NO puede cambiar la direccion impresa en su tarjeta', async () => {
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'NFC ya entregada', slug: 'ing-castillo' }),
  });

  // El cliente manda otra direccion a proposito: debe ignorarse.
  const alta = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: cuerpo.invitacion.token,
      slug: 'la-que-yo-quiero',
      name: 'Ing. Castillo',
      password: 'ClaveLarga2026',
    }),
  });
  assert.equal(alta.estado, 201);
  assert.equal(alta.cuerpo.profile.slug, 'ing-castillo');

  // Y la que intento usar debe seguir libre
  const otra = await pedir('/api/profiles/disponible/la-que-yo-quiero');
  assert.equal(otra.cuerpo.disponible, true);
});

await prueba('la direccion no cambia al editar el perfil despues', async () => {
  const sesion = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'ing-castillo', password: 'ClaveLarga2026' }),
  });
  await pedir('/api/profiles/ing-castillo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${sesion.cuerpo.token}` },
    body: JSON.stringify({ slug: 'otro-nombre', name: 'Ing. Castillo Actualizado' }),
  });

  // La direccion original sigue viva: el QR impreso no se rompe.
  const original = await pedir('/api/profiles/ing-castillo');
  assert.equal(original.estado, 200);
  assert.equal(original.cuerpo.name, 'Ing. Castillo Actualizado');

  const inventada = await pedir('/api/profiles/otro-nombre');
  assert.equal(inventada.estado, 404);
});

await prueba('una direccion apartada se libera si se anula la invitacion', async () => {
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'se cancela', slug: 'cliente-arrepentido' }),
  });
  await pedir(`/api/invitations/${cuerpo.invitacion.token}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  const libre = await pedir('/api/profiles/disponible/cliente-arrepentido');
  assert.equal(libre.cuerpo.disponible, true);
});

/* -------------------------------------------- clientes que se llaman igual */

await prueba('dos clientes con el mismo nombre no colisionan', async () => {
  // clara-molina ya existe de una prueba anterior
  const { cuerpo } = await pedir('/api/profiles/disponible/clara-molina');
  assert.equal(cuerpo.disponible, false);
  assert.equal(cuerpo.sugerencia, 'clara-molina-2');
});

await prueba('la sugerencia sigue subiendo si la variante tambien esta tomada', async () => {
  const inv = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'tocayo' }),
  });
  const alta = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: inv.cuerpo.invitacion.token,
      slug: 'clara-molina-2',
      name: 'Clara Molina (otra)',
      password: 'ClaveLarga2026',
    }),
  });
  assert.equal(alta.estado, 201);

  const { cuerpo } = await pedir('/api/profiles/disponible/clara-molina');
  assert.equal(cuerpo.sugerencia, 'clara-molina-3');
});

await prueba('la sugerencia esquiva las direcciones apartadas', async () => {
  await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'aparta la 3', slug: 'clara-molina-3' }),
  });
  const { cuerpo } = await pedir('/api/profiles/disponible/clara-molina');
  assert.equal(cuerpo.sugerencia, 'clara-molina-4');
});

await prueba('no sugiere una direccion reservada', async () => {
  const { cuerpo } = await pedir('/api/profiles/disponible/admin');
  assert.equal(cuerpo.disponible, false);
  assert.equal(cuerpo.sugerencia, 'admin-2');
});

/* ------------------------------------------------------------ horarios */

const HORARIO_OK = {
  tz: 'America/Guatemala',
  days: [
    { ranges: [['08:00', '12:00'], ['14:00', '18:00']] },
    { ranges: [['08:00', '18:00']] },
    { ranges: [['08:00', '18:00']] },
    { ranges: [['08:00', '18:00']] },
    { ranges: [['08:00', '18:00']] },
    { ranges: [['08:00', '12:00']] },
    { closed: true },
  ],
};

await prueba('guarda un horario con dos turnos y dia cerrado', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: HORARIO_OK }),
  });
  assert.equal(estado, 200);
  assert.equal(cuerpo.profile.hours.days.length, 7);
  assert.deepEqual(cuerpo.profile.hours.days[0].ranges, [['08:00', '12:00'], ['14:00', '18:00']]);
  assert.equal(cuerpo.profile.hours.days[6].closed, true);
  assert.equal(cuerpo.profile.hours.tz, 'America/Guatemala');
});

await prueba('el horario sobrevive a otras ediciones', async () => {
  await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagline: 'Cambio sin tocar el horario' }),
  });
  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(cuerpo.hours.days.length, 7);
});

await prueba('rechaza una hora mal escrita', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: { days: [{ ranges: [['8am', '18:00']] }, {}, {}, {}, {}, {}, {}] } }),
  });
  assert.equal(estado, 400);
});

await prueba('rechaza un cierre anterior a la apertura', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: { days: [{ ranges: [['18:00', '08:00']] }, {}, {}, {}, {}, {}, {}] } }),
  });
  assert.equal(estado, 400);
});

await prueba('rechaza dos turnos que se solapan', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      hours: { days: [{ ranges: [['08:00', '14:00'], ['12:00', '18:00']] }, {}, {}, {}, {}, {}, {}] },
    }),
  });
  assert.equal(estado, 400);
});

await prueba('rechaza una zona horaria inventada', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: { tz: 'Marte/Olympus', days: HORARIO_OK.days } }),
  });
  assert.equal(estado, 400);
});

await prueba('un horario con todos los dias cerrados se guarda como vacio', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: { days: Array(7).fill({ closed: true }) } }),
  });
  assert.equal(cuerpo.profile.hours, null);
});

await prueba('se puede quitar el horario', async () => {
  await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: HORARIO_OK }),
  });
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hours: null }),
  });
  assert.equal(cuerpo.profile.hours, null);
});

await prueba('ordena los turnos aunque lleguen al reves', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      hours: { days: [{ ranges: [['14:00', '18:00'], ['08:00', '12:00']] }, {}, {}, {}, {}, {}, {}] },
    }),
  });
  assert.deepEqual(cuerpo.profile.hours.days[0].ranges, [['08:00', '12:00'], ['14:00', '18:00']]);
});

/* ------------------------------------------------- sustitucion de foto */

await prueba('cambiar la foto sustituye la anterior, no la acumula', async () => {
  const roja =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // PNG 2x2 distinto, para que cambie el tamaño
  const azul =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mNk+M/AwMDAxAADRDIAAEZaAgdmZmDCAAAAAElFTkSuQmCC';

  await pedir('/api/profiles/juanperez/photo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataUrl: roja }),
  });
  const primera = await fetch(`${BASE}/api/profiles/juanperez/photo`);
  const bytes1 = (await primera.arrayBuffer()).byteLength;

  await pedir('/api/profiles/juanperez/photo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataUrl: azul }),
  });
  const segunda = await fetch(`${BASE}/api/profiles/juanperez/photo`);
  const bytes2 = (await segunda.arrayBuffer()).byteLength;

  assert.notEqual(bytes1, bytes2, 'la foto deberia haber cambiado');

  // Y en la base debe haber exactamente una fila para ese perfil
  const { obtenerDB } = await import('../src/db.js');
  const filas = obtenerDB()
    .prepare('SELECT COUNT(*) n FROM profiles WHERE slug = ?')
    .get('juanperez').n;
  assert.equal(filas, 1);
});

/* ------------------------------- enlaces armados desde lo que escribe */

await prueba('arma el enlace de WhatsApp desde el numero suelto', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'whatsapp', label: 'WhatsApp', url: '4769 4804' }] }),
  });
  assert.equal(cuerpo.profile.links[0].url, 'https://wa.me/50247694804');
});

await prueba('respeta el numero que ya trae codigo de pais', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'whatsapp', label: 'WhatsApp', url: '+502 4769-4804' }] }),
  });
  assert.equal(cuerpo.profile.links[0].url, 'https://wa.me/50247694804');
});

await prueba('no toca una direccion de WhatsApp ya completa', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'whatsapp', label: 'WhatsApp', url: 'https://wa.me/50211112222' }] }),
  });
  assert.equal(cuerpo.profile.links[0].url, 'https://wa.me/50211112222');
});

await prueba('arma tel: y mailto: solos', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      links: [
        { type: 'phone', label: 'Llamar', url: '2233 4455' },
        { type: 'email', label: 'Correo', url: 'clara@bufete.gt' },
      ],
    }),
  });
  assert.equal(cuerpo.profile.links[0].url, 'tel:+50222334455');
  assert.equal(cuerpo.profile.links[1].url, 'mailto:clara@bufete.gt');
});

await prueba('acepta el usuario de redes con o sin arroba', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      links: [
        { type: 'instagram', label: 'Instagram', url: '@salonbella' },
        { type: 'tiktok', label: 'TikTok', url: 'mitienda' },
      ],
    }),
  });
  assert.equal(cuerpo.profile.links[0].url, 'https://instagram.com/salonbella');
  assert.equal(cuerpo.profile.links[1].url, 'https://tiktok.com/@mitienda');
});

await prueba('completa el https:// que falta en un sitio web', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'web', label: 'Mi sitio', url: 'midominio.com' }] }),
  });
  assert.equal(cuerpo.profile.links[0].url, 'https://midominio.com');
});

await prueba('rechaza un correo sin arroba', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'email', label: 'Correo', url: 'esto-no-es-correo' }] }),
  });
  assert.equal(estado, 400);
});

await prueba('rechaza un WhatsApp sin ningun digito', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ links: [{ type: 'whatsapp', label: 'WhatsApp', url: 'mi numero' }] }),
  });
  assert.equal(estado, 400);
});

/* ------------------------------------------- limite de cambios al dia */

// A partir de aqui se comprueba el limite, con el valor real.
process.env.EDICIONES_POR_DIA = String(LIMITE_PRUEBA);
{
  const { obtenerDB } = await import('../src/db.js');
  obtenerDB().prepare('UPDATE profiles SET edits_day = NULL, edits_count = 0').run();
}

await prueba('avisa cuantos cambios quedan al guardar', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagline: 'contando cambios' }),
  });
  assert.equal(typeof cuerpo.restantes, 'number');
  assert.ok(cuerpo.restantes < LIMITE_PRUEBA);
});

await prueba('el dueño puede consultar su cupo', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/juanperez/cupo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(estado, 200);
  assert.equal(cuerpo.limite, LIMITE_PRUEBA);
  assert.ok(cuerpo.restantes >= 0 && cuerpo.restantes < LIMITE_PRUEBA);
});

await prueba('bloquea al agotar los cambios del dia', async () => {
  // Gastar lo que quede
  let restantes = (await pedir('/api/profiles/juanperez/cupo', {
    headers: { Authorization: `Bearer ${token}` },
  })).cuerpo.restantes;

  for (let i = 0; i < restantes; i++) {
    await pedir('/api/profiles/juanperez', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ tagline: `cambio ${i}` }),
    });
  }

  const { estado, cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagline: 'uno de mas' }),
  });
  assert.equal(estado, 429);
  assert.match(cuerpo.error, /cambios de hoy/);
});

await prueba('el perfil no se toca cuando se bloquea', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.notEqual(cuerpo.tagline, 'uno de mas');
});

await prueba('la foto tambien cuenta y se bloquea', async () => {
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const { estado } = await pedir('/api/profiles/juanperez/photo', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataUrl }),
  });
  assert.equal(estado, 429);
});

await prueba('el administrador puede devolverle los cambios', async () => {
  const { estado } = await pedir('/api/profiles/juanperez/reiniciar-cambios', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert.equal(estado, 200);

  const guardado = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagline: 'ya puedo otra vez' }),
  });
  assert.equal(guardado.estado, 200);
});

await prueba('reiniciar cambios exige clave de administrador', async () => {
  const { estado } = await pedir('/api/profiles/juanperez/reiniciar-cambios', { method: 'POST' });
  assert.equal(estado, 401);
});

await prueba('el contador se reinicia al cambiar el dia', async () => {
  const { obtenerDB } = await import('../src/db.js');
  // Dejarlo agotado pero con fecha de ayer
  obtenerDB()
    .prepare("UPDATE profiles SET edits_day = '2020-01-01', edits_count = 99 WHERE slug = ?")
    .run('juanperez');

  const { estado, cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tagline: 'dia nuevo' }),
  });
  assert.equal(estado, 200);
  assert.equal(cuerpo.restantes, LIMITE_PRUEBA - 1);
});

await prueba('el cupo de un cliente no afecta al de otro', async () => {
  const { obtenerDB } = await import('../src/db.js');
  obtenerDB()
    .prepare("UPDATE profiles SET edits_day = (SELECT edits_day FROM profiles WHERE slug='juanperez'), edits_count = 99 WHERE slug = ?")
    .run('juanperez');

  const sesionOtro = await pedir('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ slug: 'otrocliente', password: 'Otro1234' }),
  });
  const otroToken = sesionOtro.cuerpo.token;

  const { estado } = await pedir('/api/profiles/otrocliente', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${otroToken}` },
    body: JSON.stringify({ tagline: 'yo si puedo' }),
  });
  assert.equal(estado, 200);
});

/* --------------------------------------------------------- servicios */

// Las pruebas del limite dejaron el cupo agotado a proposito; aqui vuelve a
// levantarse porque lo que se comprueba es otra cosa.
process.env.EDICIONES_POR_DIA = '10000';
{
  const { obtenerDB } = await import('../src/db.js');
  obtenerDB().prepare('UPDATE profiles SET edits_day = NULL, edits_count = 0').run();
}

await prueba('guarda los servicios con su icono', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      services: [
        { label: 'Consulta general', icon: 'consulta' },
        { label: 'Chequeos', icon: 'corazon' },
      ],
    }),
  });
  assert.equal(estado, 200);
  assert.equal(cuerpo.profile.services.length, 2);
  assert.equal(cuerpo.profile.services[0].icon, 'consulta');
});

await prueba('descarta los servicios sin texto', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      services: [{ label: 'Uno', icon: 'check' }, { label: '   ', icon: 'check' }],
    }),
  });
  assert.equal(cuerpo.profile.services.length, 1);
});

await prueba('un icono inventado cae en el de por defecto', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ services: [{ label: 'Algo', icon: '<script>alert(1)</script>' }] }),
  });
  assert.equal(cuerpo.profile.services[0].icon, 'check');
});

await prueba('rechaza mas de ocho servicios', async () => {
  const muchos = Array.from({ length: 9 }, (_, i) => ({ label: `S${i}`, icon: 'check' }));
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ services: muchos }),
  });
  assert.equal(estado, 400);
});

await prueba('rechaza un servicio con texto larguisimo', async () => {
  const { estado } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ services: [{ label: 'x'.repeat(60), icon: 'check' }] }),
  });
  assert.equal(estado, 400);
});

await prueba('se pueden quitar todos los servicios', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ services: [] }),
  });
  assert.deepEqual(cuerpo.profile.services, []);
});

/* -------------------------------------------------------- suscripcion */

// Es dinero y nadie del negocio lo supervisa: el webhook cambia estados solo.
// Lo que se prueba aqui es que no se cuele lo que no debe y que un reintento
// no cobre de mas.
process.env.RECURRENTE_WEBHOOK_SECRET = 'whsec_' + Buffer.from('clave-de-prueba').toString('base64');
process.env.DIAS_DE_GRACIA = '7';

const Suscripcion = await import('../src/models/Suscripcion.js');
const { porSlug: Perfil_porSlug } = await import('../src/models/Profile.js');
const { firmaValida, slugDelEvento } = await import('../src/lib/recurrente.js');
const cripto = await import('node:crypto');

/** Firma un cuerpo igual que lo hace Svix, para poder llamar al webhook. */
function firmar(cuerpo, { id = `msg_${Math.random().toString(36).slice(2)}`, desfase = 0 } = {}) {
  const marca = Math.floor(Date.now() / 1000) + desfase;
  const clave = Buffer.from(process.env.RECURRENTE_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const firma = cripto.createHmac('sha256', clave).update(`${id}.${marca}.${cuerpo}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(marca), 'svix-signature': `v1,${firma}` };
}

const enviarWebhook = (evento, opciones) => {
  const cuerpo = JSON.stringify(evento);
  return pedir('/api/webhooks/recurrente', {
    method: 'POST',
    headers: firmar(cuerpo, opciones),
    body: cuerpo,
  });
};

const pagoDe = (slug) => ({
  event_type: 'intent.succeeded',
  status: 'succeeded',
  amount_in_cents: 699,
  currency: 'USD',
  metadata: { app: 'perfiles', slug },
  subscription: { id: `sub_${slug}` },
  customer: { id: `cus_${slug}` },
});

/* ------------------------------------------------ alta publica sin invitacion */

await prueba('se puede crear una tarjeta sin invitacion, desde la portada', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({ slug: 'publica-uno', name: 'Sin Invitacion', password: 'clave12345' }),
  });
  assert.equal(estado, 201);
  assert.ok(cuerpo.urlPago, 'deberia mandar a pagar');
  // Igual que con invitacion: existe, aparta la direccion, pero no se ve.
  assert.equal(cuerpo.profile.published, false);
});

await prueba('el alta publica tambien aparta la direccion mientras paga', async () => {
  const { estado } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({ slug: 'publica-uno', name: 'Otro Cualquiera', password: 'clave12345' }),
  });
  assert.equal(estado, 409, 'no deberia poder robar una direccion en proceso de pago');
});

await prueba('una direccion apartada y nunca pagada se libera sola', async () => {
  const { obtenerDB } = await import('../src/db.js');
  // Se envejece el alta mas alla del plazo para pagar.
  const viejo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  obtenerDB().prepare('UPDATE suscripciones SET creada_en = ? WHERE slug = ?').run(viejo, 'publica-uno');

  const { cuerpo } = await pedir('/api/profiles/disponible/publica-uno');
  assert.equal(cuerpo.disponible, true, 'la direccion deberia haberse liberado');
  assert.ok(!Perfil_porSlug('publica-uno'), 'el perfil abandonado deberia borrarse');
});

await prueba('el alta publica NO puede llevarse la direccion de un NFC impreso', async () => {
  // El caso que mas duele: el plastico ya esta impreso con esa direccion.
  const { cuerpo } = await pedir('/api/invitations', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ nota: 'NFC impreso', slug: 'dra-morales' }),
  });
  assert.equal(cuerpo.invitacion.slug, 'dra-morales');

  // Alguien de la calle intenta registrarse con esa misma direccion.
  const intento = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({ slug: 'dra-morales', name: 'Impostor', password: 'clave12345' }),
  });
  assert.equal(intento.estado, 409);

  // Y la dueña legitima, con su invitacion, si puede usarla.
  const legitima = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({
      token: cuerpo.invitacion.token,
      name: 'Dra Morales',
      password: 'clave12345',
    }),
  });
  assert.equal(legitima.estado, 201);
  assert.equal(legitima.cuerpo.profile.slug, 'dra-morales');
});

await prueba('una tarjeta ya pagada NUNCA se borra por abandono', async () => {
  await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({ slug: 'si-pago', name: 'Si Pago', password: 'clave12345' }),
  });
  const { obtenerDB } = await import('../src/db.js');
  Suscripcion.activar('si-pago');

  // Aunque el alta sea antiquisima, ya pago: no se toca.
  const viejo = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  obtenerDB().prepare('UPDATE suscripciones SET creada_en = ? WHERE slug = ?').run(viejo, 'si-pago');

  Suscripcion.liberarAbandonadas();
  assert.ok(Perfil_porSlug('si-pago'), 'una tarjeta pagada no puede desaparecer');
});

await prueba('una tarjeta anterior al cobro se sigue viendo entera', async () => {
  // Los clientes que ya existian no tienen fila de suscripcion. Si esto se
  // rompe, al desplegar se apagan de golpe los codigos QR ya impresos de
  // gente que nunca dejo de pagar.
  const { cuerpo } = await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ slug: 'anterior', name: 'Cliente Antiguo', password: 'clave12345' }),
  });
  assert.equal(cuerpo.profile.slug, 'anterior');
  assert.equal(Suscripcion.porSlug('anterior'), null, 'no deberia tener suscripcion');
  assert.equal(Suscripcion.acceso('anterior'), 'completo');
});

await prueba('una membresia regalada no caduca ni la toca la pasarela', async () => {
  Suscripcion.marcarCortesia('anterior');
  assert.equal(Suscripcion.acceso('anterior'), 'completo');

  // Un impago no debe poder tumbarla.
  Suscripcion.marcarImpago('anterior');
  assert.equal(Suscripcion.porSlug('anterior').estado, 'cortesia');
  assert.equal(Suscripcion.acceso('anterior'), 'completo');
});

await prueba('la firma correcta se acepta', () => {
  const cuerpo = JSON.stringify({ hola: 'mundo' });
  assert.equal(firmaValida(Buffer.from(cuerpo), firmar(cuerpo)), true);
});

await prueba('una firma alterada se rechaza', () => {
  const cuerpo = JSON.stringify({ hola: 'mundo' });
  const cabeceras = firmar(cuerpo);
  assert.equal(firmaValida(Buffer.from('{"hola":"otro"}'), cabeceras), false);
});

await prueba('un evento viejo se rechaza aunque venga bien firmado', () => {
  const cuerpo = JSON.stringify({ hola: 'mundo' });
  // Firmado hace una hora: alguien reenviando lo que intercepto.
  assert.equal(firmaValida(Buffer.from(cuerpo), firmar(cuerpo, { desfase: -3600 })), false);
});

await prueba('sin firma no se atiende', async () => {
  const { estado } = await pedir('/api/webhooks/recurrente', {
    method: 'POST',
    body: JSON.stringify(pagoDe('juanperez')),
  });
  assert.equal(estado, 400);
});

await prueba('un pago del otro sistema no toca ninguna tarjeta', async () => {
  const ajeno = { event_type: 'intent.succeeded', metadata: { app: 'ecodama', salon: 'x' } };
  const { estado, cuerpo } = await enviarWebhook(ajeno);
  assert.equal(estado, 200);
  assert.equal(cuerpo.ignorado, 'no es de este sistema');
});

await prueba('un evento sin metadata ni ids conocidos se ignora', async () => {
  const { cuerpo } = await enviarWebhook({ event_type: 'intent.succeeded', customer: { id: 'cus_ajeno' } });
  assert.equal(cuerpo.ignorado, 'no es de este sistema');
});

await prueba('el id de cliente por si solo no identifica una tarjeta', () => {
  // Una misma persona puede ser cliente de los dos sistemas del negocio.
  assert.equal(slugDelEvento({ customer: { id: 'cus_juanperez' } }), null);
});

await prueba('el pago activa la suscripcion y publica la tarjeta', async () => {
  Suscripcion.crearPendiente('juanperez');
  const { estado } = await enviarWebhook(pagoDe('juanperez'));
  assert.equal(estado, 200);
  assert.equal(Suscripcion.acceso('juanperez'), 'completo');

  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(cuerpo.published, true);
  assert.equal(cuerpo.acceso, 'completo');
});

await prueba('el primer pago avisa por correo; la renovacion no', async () => {
  correosEnviados.length = 0;
  await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ slug: 'avisos-uno', name: 'Cliente Nuevo', password: 'clave12345' }),
  });
  Suscripcion.crearPendiente('avisos-uno');

  await enviarWebhook(pagoDe('avisos-uno'));
  assert.equal(await esperarCorreos(1), 1, 'el primer pago deberia avisar');
  assert.match(correosEnviados[0].subject, /Nueva tarjeta pagada/);

  // La renovacion del mes siguiente no debe volver a avisar.
  await enviarWebhook(pagoDe('avisos-uno'), { id: 'msg_renovacion' });
  await esperarCorreos(2, 400);
  assert.equal(correosEnviados.length, 1, 'la renovacion no deberia avisar');
});

await prueba('el aviso lleva los contactos del cliente para escribirle', async () => {
  correosEnviados.length = 0;
  await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({
      slug: 'avisos-dos',
      name: 'Con Contacto',
      password: 'clave12345',
      links: [{ type: 'whatsapp', label: 'WhatsApp', url: '47694804' }],
    }),
  });
  Suscripcion.crearPendiente('avisos-dos');
  await enviarWebhook(pagoDe('avisos-dos'), { id: 'msg_contactos' });
  await esperarCorreos(1);

  // Es la razon de ser del aviso: poder escribirle sin buscar nada.
  assert.match(correosEnviados[0].html, /wa\.me\/50247694804/);
});

await prueba('un cobro fallido avisa con la fecha limite', async () => {
  correosEnviados.length = 0;
  await enviarWebhook({
    event_type: 'subscription.past_due',
    metadata: { app: 'perfiles', slug: 'avisos-uno' },
  }, { id: 'msg_impago' });

  assert.equal(await esperarCorreos(1), 1);
  assert.match(correosEnviados[0].subject, /Cobro fallido/);
  assert.match(correosEnviados[0].html, /sigue viéndose completa/);
});

await prueba('si el correo falla, el cobro se aplica igual', async () => {
  // Un correo que no sale no puede costarle la tarjeta a quien ya pago.
  fallarCorreo = true;
  await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ slug: 'correo-roto', name: 'Pago Igual', password: 'clave12345' }),
  });
  Suscripcion.crearPendiente('correo-roto');

  const { estado } = await enviarWebhook(pagoDe('correo-roto'), { id: 'msg_correo_roto' });
  fallarCorreo = false;

  assert.equal(estado, 200, 'el webhook no debe fallar porque falle el correo');
  assert.equal(Suscripcion.acceso('correo-roto'), 'completo');
});

await prueba('el cobro activa la tarjeta se llame como se llame el evento', async () => {
  // La pasarela nombra el cobro segun el medio de pago. Si solo se reconociera
  // "intent.succeeded", un cliente que pague por transferencia o con saldo
  // quedaria pagando sin tarjeta, y en silencio.
  const variantes = [
    'payment_intent.succeeded',
    'bank_transfer_intent.succeeded',
    'automated_bank_transfer_intent.succeeded',
    'balance_intent.paid',
  ];

  for (const tipo of variantes) {
    Suscripcion.crearPendiente('juanperez');
    Suscripcion.cambiarEstado('juanperez', 'suspendida');
    assert.equal(Suscripcion.acceso('juanperez'), 'suspendido');

    const { estado } = await enviarWebhook({ ...pagoDe('juanperez'), event_type: tipo });
    assert.equal(estado, 200);
    assert.equal(Suscripcion.acceso('juanperez'), 'completo', `${tipo} deberia activar`);
  }
});

await prueba('el mismo evento repetido no suma otro mes', async () => {
  const evento = pagoDe('juanperez');
  const cabeceras = firmar(JSON.stringify(evento));

  const primero = await pedir('/api/webhooks/recurrente', {
    method: 'POST', headers: cabeceras, body: JSON.stringify(evento),
  });
  const hasta = Suscripcion.porSlug('juanperez').periodo_fin;

  const segundo = await pedir('/api/webhooks/recurrente', {
    method: 'POST', headers: cabeceras, body: JSON.stringify(evento),
  });

  assert.equal(primero.estado, 200);
  assert.equal(segundo.cuerpo.repetido, true);
  assert.equal(Suscripcion.porSlug('juanperez').periodo_fin, hasta);
});

await prueba('un cobro fallido no tumba la tarjeta: entra en gracia', async () => {
  await enviarWebhook({
    event_type: 'subscription.past_due',
    metadata: { app: 'perfiles', slug: 'juanperez' },
  });
  assert.equal(Suscripcion.porSlug('juanperez').estado, 'en_gracia');
  // Lo importante: el QR impreso sigue llevando a la tarjeta entera.
  assert.equal(Suscripcion.acceso('juanperez'), 'completo');
});

await prueba('al vencer la gracia la tarjeta queda suspendida sola', async () => {
  const { obtenerDB } = await import('../src/db.js');
  const ayer = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  obtenerDB().prepare('UPDATE suscripciones SET gracia_hasta = ? WHERE slug = ?').run(ayer, 'juanperez');

  // Sin tarea programada de por medio: se resuelve al leer.
  assert.equal(Suscripcion.estadoEfectivo(Suscripcion.porSlug('juanperez')), 'suspendida');
  assert.equal(Suscripcion.acceso('juanperez'), 'suspendido');
});

await prueba('una tarjeta suspendida no devuelve 404, sigue existiendo', async () => {
  const { estado, cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(estado, 200);
  assert.equal(cuerpo.acceso, 'suspendido');
  // El nombre sigue estando: la pagina de suspendida lo necesita para que
  // quien escanee el QR impreso vea de quien es la tarjeta, no un error.
  assert.ok(cuerpo.name, 'el nombre deberia seguir disponible');
});

await prueba('el estado de la suscripcion no se filtra al visitante', async () => {
  const { cuerpo } = await pedir('/api/profiles/juanperez');
  assert.equal(cuerpo.estado, undefined);
  assert.equal(cuerpo.periodoFin, undefined);
  assert.equal(cuerpo.graciaHasta, undefined);
});

await prueba('pagar tras la suspension reactiva la tarjeta', async () => {
  await enviarWebhook(pagoDe('juanperez'));
  assert.equal(Suscripcion.acceso('juanperez'), 'completo');
});

await prueba('al renovar no se pierden los dias que quedaban', () => {
  const antes = Suscripcion.porSlug('juanperez').periodo_fin;
  Suscripcion.activar('juanperez');
  const despues = Suscripcion.porSlug('juanperez').periodo_fin;
  // Se cuenta desde el fin del periodo, no desde hoy.
  assert.ok(new Date(despues) > new Date(antes), 'el periodo deberia extenderse');
});

await prueba('cada cobro sale etiquetado con su tarjeta', () => {
  // Es lo que ata el pago a la tarjeta cuando vuelve el webhook, y lo que
  // distingue estos cobros de los del otro sistema del negocio.
  assert.ok(checkoutsPedidos.length > 0, 'deberia haberse pedido algun cobro');
  for (const { ruta, cuerpo } of checkoutsPedidos) {
    assert.equal(ruta, '/checkouts');
    assert.equal(cuerpo.metadata.app, 'perfiles');
    assert.ok(cuerpo.metadata.slug, 'el cobro deberia llevar el slug');
    assert.equal(cuerpo.items[0].price_id, 'price_de_prueba');
  }
});

/* -------------------------------------------------- borrado desde el panel */

await prueba('borrar un perfil exige la clave de administrador', async () => {
  const { estado } = await pedir('/api/profiles/avisos-dos', { method: 'DELETE' });
  assert.equal(estado, 401);
});

await prueba('borrar libera la direccion para otro cliente', async () => {
  const { estado } = await pedir('/api/profiles/avisos-dos', {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert.equal(estado, 200);
  assert.ok(!Perfil_porSlug('avisos-dos'), 'el perfil deberia haberse borrado');

  const { cuerpo } = await pedir('/api/profiles/disponible/avisos-dos');
  assert.equal(cuerpo.disponible, true, 'la direccion deberia quedar libre');
});

await prueba('al borrar se corta el cobro en la pasarela', async () => {
  // Sin esto el cliente seguiria pagando cada mes por una tarjeta borrada.
  cancelaciones.length = 0;
  await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ slug: 'con-cobro', name: 'Con Cobro', password: 'clave12345' }),
  });
  Suscripcion.crearPendiente('con-cobro');
  Suscripcion.activar('con-cobro', { suscripcionId: 'sub_de_con_cobro' });

  const { estado, cuerpo } = await pedir('/api/profiles/con-cobro', {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert.equal(estado, 200);
  assert.equal(cuerpo.cobroCancelado, true);
  assert.deepEqual(cancelaciones, ['/subscriptions/sub_de_con_cobro']);
});

await prueba('si no se puede cortar el cobro, NO se borra nada', async () => {
  await pedir('/api/profiles', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ slug: 'cobro-vivo', name: 'Cobro Vivo', password: 'clave12345' }),
  });
  Suscripcion.crearPendiente('cobro-vivo');
  Suscripcion.activar('cobro-vivo', { suscripcionId: 'sub_de_cobro_vivo' });

  fallarCancelacion = true;
  const { estado } = await pedir('/api/profiles/cobro-vivo', {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  fallarCancelacion = false;

  assert.equal(estado, 502);
  // Lo importante: el perfil sigue ahi, con su id de suscripcion, para poder
  // reintentar. Borrarlo dejaria al cliente pagando sin forma de pararlo.
  assert.ok(Perfil_porSlug('cobro-vivo'), 'no deberia borrarse');
  assert.equal(Suscripcion.porSlug('cobro-vivo').suscripcion_id, 'sub_de_cobro_vivo');
});

await prueba('borrar un perfil que no existe da 404', async () => {
  const { estado } = await pedir('/api/profiles/no-existe-nadie', {
    method: 'DELETE',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert.equal(estado, 404);
});

/* ----------------------------------------------------------- cierre */

servidor.close();
pasarela.close();
cerrarDB();

console.log(fallos.length ? `\n${fallos.length} prueba(s) fallaron.\n` : '\nTodas las pruebas pasaron.\n');
process.exit(fallos.length ? 1 : 0);
