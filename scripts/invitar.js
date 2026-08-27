/**
 * Genera un enlace de invitacion para que un cliente cree su propio perfil.
 *
 *   npm run invitar -- --para "Juan Pérez" --plantilla abogado
 *   npm run invitar -- --listar
 *
 * El enlace sirve una sola vez y caduca a los 14 dias.
 * Tambien puedes generarlos desde el panel en /admin, sin terminal.
 */
import 'dotenv/config';
import { conectarDB, cerrarDB } from '../src/db.js';
import * as Invitacion from '../src/models/Invitation.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SITIO = (process.env.SITE_URL || 'https://tu-sitio.netlify.app').replace(/\/$/, '');

conectarDB();

if (process.argv.includes('--listar')) {
  const todas = Invitacion.listar();
  if (!todas.length) console.log('\n  No hay invitaciones.\n');

  const ahora = new Date();
  for (const inv of todas) {
    const estado = inv.used_at
      ? `usada por /${inv.used_by_slug}`
      : new Date(inv.expires_at) < ahora
        ? 'caducada'
        : `pendiente, caduca el ${new Date(inv.expires_at).toLocaleDateString('es-GT')}`;
    console.log(`  ${(inv.nota || '(sin nota)').padEnd(28)} ${estado}`);
    if (!inv.used_at && new Date(inv.expires_at) >= ahora) {
      console.log(`    ${SITIO}/crear?i=${inv.token}`);
    }
  }
  console.log('');
  cerrarDB();
  process.exit(0);
}

const nota = arg('para', '');
const plantilla = arg('plantilla');
const dias = Number(arg('dias', 14));

const invitacion = Invitacion.crear({ nota, plantilla, dias });

console.log('\n  Invitacion creada');
if (nota) console.log(`  Para    : ${nota}`);
if (plantilla) console.log(`  Plantilla: ${plantilla}`);
console.log(`  Caduca  : ${new Date(invitacion.expiresAt).toLocaleDateString('es-GT')}`);
console.log(`\n  Enviale este enlace:\n  ${SITIO}/crear?i=${invitacion.token}\n`);
console.log('  Sirve una sola vez.\n');

cerrarDB();
