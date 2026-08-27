/**
 * Copia de seguridad de la base.
 *
 *   npm run respaldar
 *   npm run respaldar -- --destino /ruta/respaldos
 *
 * Usa la API de backup de SQLite, que produce una copia consistente aunque
 * alguien este guardando en ese momento. Copiar el archivo con `cp` mientras
 * hay escrituras puede dejar una copia corrupta, por eso no se hace asi.
 *
 * Conserva los ultimos 14 respaldos y borra los mas viejos.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { conectarDB, cerrarDB } from '../src/db.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const destino = path.resolve(arg('destino', './respaldos'));
const conservar = Number(arg('conservar', 14));

fs.mkdirSync(destino, { recursive: true });

const db = conectarDB();

// Marca de tiempo apta para nombre de archivo: 2026-08-27_15-42-10
const sello = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const archivo = path.join(destino, `perfiles-${sello}.db`);

await db.backup(archivo);

const perfiles = db.prepare('SELECT COUNT(*) n FROM profiles').get().n;
const conFoto = db.prepare('SELECT COUNT(*) n FROM profiles WHERE photo IS NOT NULL').get().n;
const tamano = fs.statSync(archivo).size;

console.log(`\n  Respaldo creado`);
console.log(`  Archivo  : ${archivo}`);
console.log(`  Contenido: ${perfiles} perfil(es), ${conFoto} con foto`);
console.log(`  Tamaño   : ${(tamano / 1024).toFixed(1)} KB`);

// Rotacion: dejar solo los mas recientes.
const viejos = fs
  .readdirSync(destino)
  .filter((f) => /^perfiles-.*\.db$/.test(f))
  .sort()
  .reverse()
  .slice(conservar);

for (const f of viejos) fs.unlinkSync(path.join(destino, f));
if (viejos.length) console.log(`  Borrados : ${viejos.length} respaldo(s) antiguo(s)`);

console.log(
  `\n  Para restaurar: detén el servicio, reemplaza la base con este archivo y vuelve a arrancar.\n`
);

cerrarDB();
