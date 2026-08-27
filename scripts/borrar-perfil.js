/**
 * Borra un perfil de la base de datos.
 *
 *   npm run borrar-perfil -- --slug demo
 *
 * Pide confirmacion escribiendo el slug, salvo que se pase --si.
 * El borrado es definitivo: si solo quieres ocultar el perfil del sitio sin
 * perder los datos, usa la ruta PATCH /api/profiles/:slug/published.
 */
import 'dotenv/config';
import readline from 'node:readline/promises';
import mongoose from 'mongoose';
import { connectDB } from '../src/db.js';
import Profile from '../src/models/Profile.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const slug = arg('slug');
const sinPreguntar = process.argv.includes('--si');

if (!slug) {
  console.error('Uso: npm run borrar-perfil -- --slug mi-cliente [--si]');
  process.exit(1);
}

await connectDB();

const perfil = await Profile.findOne({ slug: slug.toLowerCase() });
if (!perfil) {
  console.error(`No existe ningun perfil con el slug "${slug}".`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log(`\n  Slug   : ${perfil.slug}`);
console.log(`  Nombre : ${perfil.name}`);
console.log(`  Creado : ${perfil.createdAt.toLocaleDateString('es-GT')}\n`);

if (!sinPreguntar) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const respuesta = await rl.question(`Escribe "${perfil.slug}" para confirmar el borrado: `);
  rl.close();

  if (respuesta.trim() !== perfil.slug) {
    console.log('Cancelado. No se borro nada.');
    await mongoose.disconnect();
    process.exit(0);
  }
}

await Profile.deleteOne({ _id: perfil._id });
console.log(`\nPerfil "${perfil.slug}" borrado. Vuelve a desplegar el sitio para que desaparezca la pagina.\n`);

await mongoose.disconnect();
