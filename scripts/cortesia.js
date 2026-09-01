/**
 * Regala la membresia de una tarjeta: no se cobra nunca y no caduca.
 *
 *   npm run cortesia -- --slug carlos-barillas
 *   npm run cortesia -- --listar
 *
 * Se usa para los clientes a los que se les regalo la membresia. Sin esto
 * funcionarian igual —una tarjeta sin suscripcion se ve entera— pero el
 * regalo quedaria implicito en una fila que no existe. Dejarlo escrito evita
 * que un dia se rellenen las suscripciones que faltan y estos empiecen a
 * cobrarse sin que nadie se de cuenta.
 */
import 'dotenv/config';
import { conectarDB, cerrarDB } from '../src/db.js';
import * as Suscripcion from '../src/models/Suscripcion.js';
import * as Perfil from '../src/models/Profile.js';

const arg = (nombre) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

conectarDB();

if (process.argv.includes('--listar')) {
  const regaladas = Suscripcion.listarTodas().filter((s) => s.estado === 'cortesia');
  console.log(
    regaladas.length
      ? `\n  Membresias regaladas:\n${regaladas.map((s) => `    /${s.slug}`).join('\n')}\n`
      : '\n  No hay membresias regaladas.\n'
  );
  cerrarDB();
  process.exit(0);
}

const slug = arg('slug');
if (!slug) {
  console.error('\n  Falta --slug. Ejemplo:\n    npm run cortesia -- --slug carlos-barillas\n');
  cerrarDB();
  process.exit(1);
}

const perfil = Perfil.porSlug(slug);
if (!perfil) {
  console.error(`\n  No existe ningun perfil en /${slug}.\n`);
  cerrarDB();
  process.exit(1);
}

Suscripcion.marcarCortesia(slug);
console.log(`\n  /${slug} (${perfil.name}) queda con membresia regalada.`);
console.log('  No se le cobrara nunca y su tarjeta no se suspende.\n');

cerrarDB();
