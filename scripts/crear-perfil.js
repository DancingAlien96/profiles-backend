/**
 * Crea un perfil nuevo desde la terminal y muestra la clave inicial.
 *
 *   npm run crear-perfil -- --slug renealvarado --nombre "Rene Alvarado" --tel 47694804
 *
 * La clave por defecto mezcla el primer nombre con los ultimos 4 digitos del
 * telefono (ej. Rene4804). El cliente esta obligado a cambiarla al entrar.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { conectarDB, cerrarDB } from '../src/db.js';
import * as Perfil from '../src/models/Profile.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function clavePorDefecto(nombre, telefono) {
  const primerNombre = nombre.trim().split(/\s+/)[0].normalize('NFD').replace(/[̀-ͯ]/g, '');
  const base = primerNombre.charAt(0).toUpperCase() + primerNombre.slice(1).toLowerCase();
  const digitos = String(telefono || '').replace(/\D/g, '').slice(-4) || '2024';
  return `${base}${digitos}`;
}

const slug = arg('slug');
const nombre = arg('nombre');
const telefono = arg('tel', '');
const theme = arg('tema', 'oro-tech');
const role = arg('cargo', '');

if (!slug || !nombre) {
  console.error('Uso: npm run crear-perfil -- --slug mi-cliente --nombre "Nombre Apellido" --tel 12345678 [--cargo "..."] [--tema oro-tech]');
  process.exit(1);
}

const clave = arg('clave') || clavePorDefecto(nombre, telefono);

conectarDB();

if (Perfil.porSlug(slug)) {
  console.error(`Ya existe un perfil con el slug "${slug}".`);
  cerrarDB();
  process.exit(1);
}

const links = telefono
  ? [
      {
        type: 'whatsapp',
        label: 'WhatsApp',
        sublabel: `+502 ${String(telefono).replace(/\D/g, '').replace(/(\d{4})(\d{4})/, '$1 $2')}`,
        url: `https://wa.me/502${String(telefono).replace(/\D/g, '')}`,
      },
    ]
  : [];

try {
  Perfil.crear({
    slug,
    name: nombre,
    role,
    theme,
    links,
    passwordHash: await bcrypt.hash(clave, 12),
  });
} catch (err) {
  console.error(`No se pudo crear el perfil: ${err.message}`);
  cerrarDB();
  process.exit(1);
}

console.log('\n  Perfil creado');
console.log(`  URL      : /${slug.toLowerCase()}`);
console.log(`  Nombre   : ${nombre}`);
console.log(`  Tema     : ${theme}`);
console.log(`  Clave    : ${clave}   <-- entregasela al cliente`);
console.log('  El panel le pedira cambiarla en el primer ingreso.\n');

cerrarDB();
