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

/* ----------------------------------------------------------- cierre */

servidor.close();
cerrarDB();

console.log(fallos.length ? `\n${fallos.length} prueba(s) fallaron.\n` : '\nTodas las pruebas pasaron.\n');
process.exit(fallos.length ? 1 : 0);
