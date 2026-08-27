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

/* ----------------------------------------------------------- cierre */

servidor.close();
cerrarDB();

console.log(fallos.length ? `\n${fallos.length} prueba(s) fallaron.\n` : '\nTodas las pruebas pasaron.\n');
process.exit(fallos.length ? 1 : 0);
