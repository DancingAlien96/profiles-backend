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

await prueba('no se puede crear un perfil sin invitacion', async () => {
  const { estado } = await pedir('/api/profiles/registro', {
    method: 'POST',
    body: JSON.stringify({ slug: 'colado', name: 'Colado', password: 'ClaveLarga1' }),
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

/* ----------------------------------------------------------- cierre */

servidor.close();
cerrarDB();

console.log(fallos.length ? `\n${fallos.length} prueba(s) fallaron.\n` : '\nTodas las pruebas pasaron.\n');
process.exit(fallos.length ? 1 : 0);
