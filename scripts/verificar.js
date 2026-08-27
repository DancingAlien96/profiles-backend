/**
 * Comprueba que el despliegue quedo bien. Se corre EN el VPS:
 *
 *   npm run verificar
 *
 * Revisa las cosas que fallan en silencio: el puerto expuesto a internet,
 * el proxy mal configurado, el CORS incompleto, HTTPS ausente.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { cargarConfig } from '../src/config.js';

const DOMINIO = process.argv.includes('--dominio')
  ? process.argv[process.argv.indexOf('--dominio') + 1]
  : 'https://backtarjetas.ecodama.online';

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
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const perfiles = await mongoose.connection.db.collection('profiles').countDocuments();
  ok(`conecta con Atlas`, `base "${mongoose.connection.name}", ${perfiles} perfil(es)`);
  if (mongoose.connection.name === 'test') {
    mal('la base se llama "test"', 'Falta /perfiles en MONGODB_URI, antes del "?".');
  }
  await mongoose.disconnect();
} catch (err) {
  mal(
    `no conecta con Atlas: ${err.message}`,
    'Revisa que la IP del VPS este autorizada en Network Access de Atlas.'
  );
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
        'clientes juntos. Copia deploy/nginx.conf.example.'
    );
  } else if (d.ipVista === '127.0.0.1' || d.ipVista === '::1' || d.ipVista === '::ffff:127.0.0.1') {
    mal(
      `Express ve la IP del proxy (${d.ipVista}) en vez de la del visitante`,
      'Falta app.set("trust proxy", 1) o la cabecera no llega bien.'
    );
  } else {
    ok('Nginx pasa la IP real del visitante', d.ipVista);
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
    'Agrega el dominio de tu sitio en Netlify.'
  );
} else {
  const publicos = config.origenes.filter(
    (o) => !o.includes('localhost') && !o.includes('127.0.0.1')
  );

  if (!publicos.length) {
    mal(
      'CORS_ORIGINS solo tiene origenes locales',
      'Agrega el dominio de tu sitio en Netlify o el panel fallara para los clientes.'
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
