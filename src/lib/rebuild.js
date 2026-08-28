import { obtenerDB } from '../db.js';

/**
 * Dispara el build hook de Netlify para regenerar el sitio estatico.
 *
 * Aqui se decide CUANDO se publica, y el objetivo es que los minutos de build
 * de Netlify no se puedan agotar por mucha actividad que haya:
 *
 *  1. Agrupado: varios guardados seguidos salen en un solo build.
 *  2. Separacion minima entre builds: aunque editen cien clientes a la vez,
 *     no se lanza un build por cada uno.
 *  3. Tope MENSUAL de deploys: llegado al limite, los cambios esperan al mes
 *     siguiente. Nunca se pierden; solo tardan mas en verse.
 *
 * El tope mensual no es un lujo. Netlify cobra por creditos y cada deploy de
 * produccion cuesta 15: con los 300 del plan gratuito salen unos 19 deploys al
 * mes contando el trafico. Al agotarlos, Netlify PAUSA el sitio y los
 * visitantes ven "Site not available" hasta el mes siguiente, o sea que se
 * caerian las tarjetas de todos los clientes a la vez.
 */
const ESPERA_POR_DEFECTO = 20;      // agrupar guardados seguidos
const TOPE_POR_DEFECTO = 120;       // no posponer indefinidamente
const SEPARACION_POR_DEFECTO = 600; // 10 min entre builds
// 300 creditos del plan gratuito / 15 por deploy = 20, menos margen para el
// trafico y para tus propios despliegues de codigo.
const MAX_MENSUAL_POR_DEFECTO = 14;

let timer = null;

function segundos(nombre, porDefecto) {
  const valor = Number(process.env[nombre]);
  return (Number.isFinite(valor) && valor >= 0 ? valor : porDefecto) * 1000;
}

const maxMensual = () => {
  const valor = Number(process.env.DEPLOYS_MAX_POR_MES);
  return Number.isFinite(valor) && valor > 0 ? valor : MAX_MENSUAL_POR_DEFECTO;
};

const zona = () => process.env.ZONA_HORARIA || 'America/Guatemala';

function diaDeHoy() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zona() }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** El ciclo de facturacion de Netlify es mensual. */
const mesActual = () => diaDeHoy().slice(0, 7);

/* ------------------------------------------------- estado persistente */

function leer(clave) {
  try {
    const fila = obtenerDB().prepare('SELECT valor FROM meta WHERE clave = ?').get(clave);
    return fila ? fila.valor : null;
  } catch {
    return null;
  }
}

function guardar(clave, valor) {
  try {
    const db = obtenerDB();
    if (valor === null) {
      db.prepare('DELETE FROM meta WHERE clave = ?').run(clave);
    } else {
      db.prepare(
        'INSERT INTO meta (clave, valor) VALUES (?, ?) ' +
          'ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
      ).run(clave, String(valor));
    }
  } catch {
    // Si la base no esta lista, el agrupado sigue funcionando en memoria.
  }
}

/** Deploys ya lanzados este mes. Cambia de mes solo, sin tarea de limpieza. */
function deploysDelMes() {
  return leer('builds_mes') === mesActual() ? Number(leer('builds_count') || 0) : 0;
}

function apuntarBuild() {
  const usados = deploysDelMes();
  guardar('builds_mes', mesActual());
  guardar('builds_count', usados + 1);
  guardar('ultimo_build', Date.now());
}

/** Milisegundos hasta el primer dia del mes siguiente. */
function hastaElMesQueViene() {
  const hoy = new Date(`${diaDeHoy()}T00:00:00Z`);
  const siguiente = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 1));
  // Se limita a 24 dias: setTimeout no admite mas, y al arrancar se reevalua.
  return Math.min(siguiente - hoy, 24 * 24 * 3600 * 1000);
}

/* -------------------------------------------------------- disparo */

function devolverCupo() {
  guardar('builds_count', Math.max(0, deploysDelMes() - 1));
}

async function disparar(hook) {
  timer = null;

  // Se vuelve a comprobar aqui: entre que se programo el disparo y este
  // momento pudo gastarse el ultimo deploy del mes.
  if (deploysDelMes() >= maxMensual()) {
    programar(hook, 0);
    return;
  }

  // El cupo se reserva ANTES de llamar, no despues. Si se apuntara al volver,
  // durante el await habria una ventana en la que otro disparo veria cupo
  // libre y se pasaria del tope.
  apuntarBuild();

  try {
    const res = await fetch(hook, { method: 'POST' });
    if (res.ok) {
      guardar('rebuild_pendiente_desde', null);
      console.log(`[rebuild] deploy ${deploysDelMes()}/${maxMensual()} de este mes solicitado (HTTP ${res.status})`);
    } else {
      devolverCupo();
      console.error(`[rebuild] Netlify respondio ${res.status}; queda pendiente`);
    }
  } catch (err) {
    devolverCupo();
    console.error('[rebuild] fallo al llamar el build hook:', err.message, '- queda pendiente');
  }
}

/** Programa el disparo respetando agrupado, separacion minima y tope diario. */
function programar(hook, esperaBase) {
  const separacion = segundos('REBUILD_MIN_INTERVAL_SECONDS', SEPARACION_POR_DEFECTO);
  const ultimo = Number(leer('ultimo_build') || 0);

  if (deploysDelMes() >= maxMensual()) {
    const espera = hastaElMesQueViene();
    console.warn(
      `[rebuild] alcanzado el tope de ${maxMensual()} deploys este mes. ` +
        'Los cambios quedan guardados y se publicaran al empezar el mes que viene. ' +
        'Si necesitas mas, sube DEPLOYS_MAX_POR_MES y revisa tus creditos en Netlify.'
    );
    if (timer) clearTimeout(timer);
    // unref: una espera de dias no debe impedir que el proceso termine si es
    // lo unico que queda vivo. En el servicio da igual, en un script no.
    timer = setTimeout(() => programar(hook, 0), espera);
    timer.unref?.();
    return;
  }

  // Nunca antes de que pase la separacion minima desde el build anterior.
  const desdeUltimo = Date.now() - ultimo;
  const espera = Math.max(esperaBase, separacion - desdeUltimo, 0);

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => disparar(hook), espera);
  timer.unref?.();
}

export function scheduleRebuild() {
  const hook = process.env.NETLIFY_BUILD_HOOK;
  if (!hook) {
    console.warn('[rebuild] NETLIFY_BUILD_HOOK sin configurar: no se regenera el sitio');
    return;
  }

  const espera = segundos('REBUILD_DELAY_SECONDS', ESPERA_POR_DEFECTO);
  const tope = segundos('REBUILD_MAX_DELAY_SECONDS', TOPE_POR_DEFECTO);

  let desde = Number(leer('rebuild_pendiente_desde') || 0);
  if (!desde) {
    desde = Date.now();
    guardar('rebuild_pendiente_desde', desde);
  }

  // Si el primer cambio pendiente lleva mucho esperando, ya no se pospone mas
  // por agrupar; aun asi la separacion minima y el tope diario se respetan.
  const esperaBase = Date.now() - desde >= tope ? 0 : espera;
  programar(hook, esperaBase);
}

/**
 * Al arrancar: si quedo algo sin publicar de antes del reinicio, se publica.
 * Es el caso de un despliegue justo despues de que un cliente guardara.
 */
export function recuperarPendiente() {
  const hook = process.env.NETLIFY_BUILD_HOOK;
  if (!hook || !leer('rebuild_pendiente_desde')) return;

  console.log('[rebuild] habia un cambio sin publicar antes del reinicio');
  programar(hook, 0);
}

export function rebuildPending() {
  return Boolean(leer('rebuild_pendiente_desde'));
}

/** Para el diagnostico: cuantos builds van hoy y cuantos quedan. */
export function estadoBuilds() {
  const usados = deploysDelMes();
  const max = maxMensual();
  return {
    esteMes: usados,
    max,
    restantes: Math.max(0, max - usados),
    creditosEstimados: usados * 15,
    pendiente: rebuildPending(),
    ultimo: Number(leer('ultimo_build') || 0) || null,
  };
}
