/**
 * Validacion de la configuracion antes de arrancar.
 *
 * La idea es que un despliegue mal configurado falle de inmediato y con un
 * mensaje claro, en vez de arrancar y romperse mas tarde de forma confusa:
 * un JWT_SECRET de ejemplo en produccion, o un CORS_ORIGINS vacio que hace
 * que el panel del cliente falle sin explicacion visible.
 */

const PLACEHOLDERS = [
  'cambia-esto-por-una-cadena-larga-y-aleatoria',
  'cambia-esto-tambien',
];

export function cargarConfig() {
  const errores = [];
  const avisos = [];

  const { MONGODB_URI, JWT_SECRET, ADMIN_KEY, CORS_ORIGINS, NETLIFY_BUILD_HOOK } = process.env;

  if (!MONGODB_URI) {
    errores.push('Falta MONGODB_URI.');
  } else if (/mongodb\+srv:\/\/[^/]+\/\?/.test(MONGODB_URI)) {
    // Es el error mas facil de cometer al copiar la cadena desde Atlas.
    errores.push(
      'MONGODB_URI no incluye el nombre de la base. Inserta /perfiles antes del "?" ' +
        'o Mongoose escribira en una base llamada "test".'
    );
  }

  if (!JWT_SECRET) {
    errores.push('Falta JWT_SECRET.');
  } else if (PLACEHOLDERS.includes(JWT_SECRET)) {
    errores.push('JWT_SECRET sigue siendo el valor de ejemplo. Genera uno real.');
  } else if (JWT_SECRET.length < 32) {
    errores.push(`JWT_SECRET es demasiado corto (${JWT_SECRET.length} caracteres, minimo 32).`);
  }

  if (!ADMIN_KEY) {
    errores.push('Falta ADMIN_KEY.');
  } else if (PLACEHOLDERS.includes(ADMIN_KEY)) {
    errores.push('ADMIN_KEY sigue siendo el valor de ejemplo. Genera una real.');
  }

  const origenes = (CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (!origenes.length) {
    avisos.push(
      'CORS_ORIGINS esta vacio: se aceptara cualquier origen. Agrega el dominio ' +
        'de Netlify antes de dar el enlace a un cliente.'
    );
  } else if (origenes.some((o) => o.startsWith('http://') && !o.includes('localhost') && !o.includes('127.0.0.1'))) {
    avisos.push(
      'Hay un origen en http:// que no es local. Netlify sirve por HTTPS, asi que ' +
        'el navegador bloqueara esas peticiones.'
    );
  }

  if (!NETLIFY_BUILD_HOOK) {
    avisos.push('NETLIFY_BUILD_HOOK sin configurar: al guardar no se regenerara el sitio.');
  }

  if (errores.length) {
    console.error('\n[api] la configuracion tiene errores:\n');
    for (const e of errores) console.error(`  - ${e}`);
    console.error('\nRevisa el archivo .env (parte de .env.example).\n');
    throw new Error('Configuracion invalida');
  }

  for (const a of avisos) console.warn(`[api] aviso: ${a}`);

  return {
    port: Number(process.env.PORT) || 3000,
    // Solo localhost: Nginx es quien expone la API al exterior. Escuchar en
    // 0.0.0.0 dejaria el puerto alcanzable desde internet si el firewall se
    // abre por error, saltandose HTTPS y los limites del proxy.
    host: process.env.HOST || '127.0.0.1',
    origenes,
  };
}
