import fs from 'node:fs';
import path from 'node:path';

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

  const { DB_PATH, JWT_SECRET, ADMIN_KEY, CORS_ORIGINS } = process.env;

  const rutaDB = DB_PATH || './data/perfiles.db';
  if (rutaDB !== ':memory:') {
    // Si el directorio no existe o no se puede escribir, mejor saberlo ahora
    // que cuando un cliente intente guardar.
    const carpeta = path.dirname(path.resolve(rutaDB));
    try {
      fs.mkdirSync(carpeta, { recursive: true });
      fs.accessSync(carpeta, fs.constants.W_OK);
    } catch {
      errores.push(
        `No se puede escribir en ${carpeta}. Revisa que exista y que el usuario ` +
          'del servicio tenga permiso.'
      );
    }
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

  // En el VPS el sitio y la API comparten dominio detras de Nginx, asi que el
  // panel llama a /api con rutas relativas y no hay CORS de por medio. La
  // lista sigue importando: sin ella cualquier pagina puede llamar a la API
  // desde el navegador de un visitante.
  if (!origenes.length) {
    avisos.push(
      'CORS_ORIGINS esta vacio: se aceptara cualquier origen. En el VPS pon el ' +
        'dominio del sitio; en local, http://localhost:4321.'
    );
  } else if (origenes.some((o) => o.startsWith('http://') && !o.includes('localhost') && !o.includes('127.0.0.1'))) {
    avisos.push(
      'Hay un origen en http:// que no es local. El sitio se sirve por HTTPS, asi ' +
        'que el navegador bloqueara esas peticiones.'
    );
  }

  // Sin la pasarela, el alta de clientes deja de funcionar: el formulario
  // guarda la tarjeta pero no puede abrir el cobro. Es un aviso y no un error
  // porque el resto del servicio (las tarjetas ya activas) sigue en pie.
  const pasarela = [
    ['RECURRENTE_SECRET_KEY', 'no se podran crear cobros'],
    ['RECURRENTE_PRICE_ID', 'no se sabe cuanto cobrar'],
    ['RECURRENTE_WEBHOOK_SECRET', 'los pagos no activaran ninguna tarjeta'],
  ].filter(([nombre]) => !process.env[nombre]);

  for (const [nombre, consecuencia] of pasarela) {
    avisos.push(`${nombre} sin configurar: ${consecuencia}.`);
  }

  if (errores.length) {
    console.error('\n[api] la configuracion tiene errores:\n');
    for (const e of errores) console.error(`  - ${e}`);
    console.error('\nRevisa el archivo .env (parte de .env.example).\n');
    throw new Error('Configuracion invalida');
  }

  for (const a of avisos) console.warn(`[api] aviso: ${a}`);

  return {
    rutaDB,
    port: Number(process.env.PORT) || 3000,
    // Solo localhost: Nginx es quien expone la API al exterior. Escuchar en
    // 0.0.0.0 dejaria el puerto alcanzable desde internet si el firewall se
    // abre por error, saltandose HTTPS y los limites del proxy.
    host: process.env.HOST || '127.0.0.1',
    origenes,
  };
}
