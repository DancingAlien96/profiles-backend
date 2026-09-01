/**
 * Comprueba que el despliegue quedo bien. Se corre EN el VPS:
 *
 *   npm run verificar
 *
 * Revisa las cosas que fallan en silencio: el puerto expuesto a internet,
 * el proxy mal configurado, el CORS incompleto, HTTPS ausente.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { conectarDB, cerrarDB } from '../src/db.js';
import { cargarConfig } from '../src/config.js';

// La API no tiene dominio propio: se llega a ella por /api del dominio del
// sitio, que es quien tiene el Nginx delante.
const DOMINIO = process.argv.includes('--dominio')
  ? process.argv[process.argv.indexOf('--dominio') + 1]
  : 'https://www.professionalprofiles.online';

const VERDE = '\x1b[32m';
const ROJO = '\x1b[31m';
const AMARILLO = '\x1b[33m';
const GRIS = '\x1b[90m';
const FIN = '\x1b[0m';

let problemas = 0;

const ok = (t, detalle) => console.log(`  ${VERDE}ok${FIN}    ${t}${detalle ? `${GRIS}  ${detalle}${FIN}` : ''}`);
const mal = (t, arreglo) => {
  problemas++;
  console.log(`  ${ROJO}FALLA${FIN} ${t}`);
  if (arreglo) console.log(`        ${GRIS}${arreglo}${FIN}`);
};
const aviso = (t, nota) => {
  console.log(`  ${AMARILLO}aviso${FIN} ${t}`);
  if (nota) console.log(`        ${GRIS}${nota}${FIN}`);
};

async function pedir(url, opciones = {}) {
  try {
    const res = await fetch(url, { ...opciones, signal: AbortSignal.timeout(8000) });
    return { res, error: null };
  } catch (err) {
    return { res: null, error: err.message };
  }
}

console.log(`\nVerificando ${DOMINIO}\n`);

/* ------------------------------------------------------ configuracion */

console.log('Configuracion');
let config;
try {
  config = cargarConfig();
  ok('las variables de entorno son validas');
} catch {
  console.log('\nCorrige lo anterior y vuelve a ejecutar.\n');
  process.exit(1);
}

if (config.host === '127.0.0.1' || config.host === 'localhost') {
  ok('la API escucha solo en localhost', config.host);
} else {
  mal(
    `la API escucha en ${config.host}, no solo en localhost`,
    'Quita HOST del .env para que use 127.0.0.1. Nginx debe ser el unico que la alcance.'
  );
}

/* ---------------------------------------------------------- base de datos */

console.log('\nBase de datos');
try {
  const db = conectarDB(config.rutaDB);
  const total = db.prepare('SELECT COUNT(*) n FROM profiles').get().n;
  const modo = db.pragma('journal_mode', { simple: true });
  const bytes = config.rutaDB === ':memory:' ? 0 : fs.statSync(config.rutaDB).size;

  ok('la base abre correctamente', `${total} perfil(es), ${(bytes / 1024).toFixed(1)} KB`);

  if (modo !== 'wal') {
    aviso(
      `la base no esta en modo WAL (${modo})`,
      'Una visita podria bloquearse si coincide con un guardado.'
    );
  } else {
    ok('modo WAL activo', 'leer y escribir a la vez no se bloquea');
  }

  // El archivo no debe quedar legible por cualquier usuario del VPS: contiene
  // los hashes de las claves de los clientes.
  if (process.platform !== 'win32' && config.rutaDB !== ':memory:') {
    const modo8 = (fs.statSync(config.rutaDB).mode & 0o777).toString(8);
    if (modo8.endsWith('0') || modo8.endsWith('4')) {
      ok('permisos del archivo', modo8);
    } else {
      aviso(`el archivo es legible por otros usuarios (${modo8})`, `chmod 600 ${config.rutaDB}`);
    }
  }

  cerrarDB();
} catch (err) {
  mal(`no se pudo abrir la base: ${err.message}`, 'Revisa DB_PATH y los permisos del directorio.');
}

/* ------------------------------------------------------------- el proxy */

console.log('\nNginx y HTTPS');

const salud = await pedir(`${DOMINIO}/api/health`, {
  headers: { 'x-admin-key': process.env.ADMIN_KEY || '' },
});

if (!salud.res) {
  mal(
    `${DOMINIO} no responde: ${salud.error}`,
    'Revisa que Nginx este arriba, el DNS apunte al VPS y el certificado sea valido.'
  );
} else if (!salud.res.ok) {
  mal(`${DOMINIO}/api/health respondio HTTP ${salud.res.status}`);
} else {
  ok('el dominio responde por HTTPS');

  const datos = await salud.res.json();
  const d = datos.diagnostico;

  if (!d) {
    aviso(
      'no se pudo leer el diagnostico del proxy',
      'La ADMIN_KEY local no coincide con la del servicio. Reinicia la API tras cambiar el .env.'
    );
  } else if (!d.forwardedFor) {
    mal(
      'Nginx no esta pasando X-Forwarded-For',
      'Sin esa cabecera el limite de intentos ve una sola IP y bloquea a todos los ' +
        'clientes juntos. El bloque /api/ esta en deploy/nginx.conf.example del ' +
        'repo del frontend.'
    );
  } else if (d.ipVista === '127.0.0.1' || d.ipVista === '::1' || d.ipVista === '::ffff:127.0.0.1') {
    mal(
      `Express ve la IP del proxy (${d.ipVista}) en vez de la del visitante`,
      'Falta app.set("trust proxy", 1) o la cabecera no llega bien.'
    );
  } else {
    ok('Nginx pasa la IP real del visitante', d.ipVista);
  }

  /* ------------------------------------------------------- la pasarela */

  if (d?.pasarela) {
    console.log('\nCobro de suscripciones');
    const p = d.pasarela;

    if (p.llaveSecreta === 'FALTA') {
      mal(
        'falta RECURRENTE_SECRET_KEY',
        'Los clientes nuevos no pueden pagar: el alta guarda la tarjeta pero no ' +
          'abre el cobro. Las tarjetas ya activas siguen funcionando.'
      );
    } else if (p.llaveSecreta === 'sandbox') {
      aviso(
        'la llave de la pasarela es de PRUEBAS (sk_test_)',
        'Se puede pagar con 4242 4242 4242 4242 y no se cobra dinero real. ' +
          'Para cobrar de verdad, cambia a sk_live_ y vuelve a correr crear-precio.'
      );
    } else {
      ok('la pasarela cobra de verdad', 'sk_live_');
    }

    if (p.precio === 'FALTA') {
      mal('falta RECURRENTE_PRICE_ID', 'Sacalo con: npm run crear-precio');
    } else {
      ok('el precio de la suscripcion esta configurado');
    }

    if (p.firmaWebhook === 'FALTA') {
      mal(
        'falta RECURRENTE_WEBHOOK_SECRET',
        'Los pagos entran pero NINGUNA tarjeta se activa: sin la clave no se ' +
          'puede verificar la firma y el webhook rechaza todo. Copiala del ' +
          'endpoint de este sistema en el panel de Svix.'
      );
    } else {
      ok('la firma de los webhooks se puede verificar');
    }

    ok('dias de gracia tras un cobro fallido', `${p.diasDeGracia} dias`);

    if (d.avisos === 'apagados') {
      aviso(
        'los avisos por correo estan apagados',
        'No te enteraras de una venta ni de un cobro fallido salvo que mires el ' +
          'panel. Configura RESEND_API_KEY y EMAIL_AVISOS.'
      );
    } else {
      ok('avisos por correo', d.avisos);
    }
  }
}

/* --------------------------------------------- el puerto directo, expuesto */

const host = new URL(DOMINIO).hostname;
const directo = await pedir(`http://${host}:${config.port}/api/health`);

if (directo.res) {
  mal(
    `el puerto ${config.port} es alcanzable desde internet`,
    `Cualquiera puede saltarse Nginx y HTTPS. Cierralo: sudo ufw deny ${config.port}`
  );
} else {
  ok(`el puerto ${config.port} no es alcanzable desde fuera`);
}

/* ----------------------------------------------------------------- CORS */

console.log('\nCORS');

if (!config.origenes.length) {
  mal(
    'CORS_ORIGINS esta vacio: se acepta cualquier origen',
    'Agrega el dominio del sitio: https://www.professionalprofiles.online'
  );
} else {
  const publicos = config.origenes.filter(
    (o) => !o.includes('localhost') && !o.includes('127.0.0.1')
  );

  if (!publicos.length) {
    mal(
      'CORS_ORIGINS solo tiene origenes locales',
      'Agrega el dominio publico del sitio; si algun dia el panel se sirve desde ' +
        'otro dominio, sin el las peticiones fallaran por CORS.'
    );
  }

  for (const origen of publicos) {
    const prueba = await pedir(`${DOMINIO}/api/health`, { headers: { Origin: origen } });
    const permitido = prueba.res?.headers.get('access-control-allow-origin');

    if (permitido) ok(`el panel puede llamar desde ${origen}`);
    else if (!prueba.res) aviso(`no se pudo probar ${origen}`, 'el dominio no responde todavia');
    else mal(`la API rechaza el origen ${origen}`);
  }
}

/* --------------------------------------------------------------- cierre */

console.log(
  problemas
    ? `\n${ROJO}${problemas} problema(s) que corregir.${FIN}\n`
    : `\n${VERDE}Todo en orden.${FIN}\n`
);
process.exit(problemas ? 1 : 0);
