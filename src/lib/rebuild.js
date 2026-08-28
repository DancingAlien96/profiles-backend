import { obtenerDB } from '../db.js';

/**
 * Dispara el build hook de Netlify para regenerar el sitio estatico.
 *
 * Se agrupa con un temporizador: si el cliente guarda cinco veces seguidas
 * mientras acomoda su perfil, solo se dispara un build al final. Sin esto
 * gastarias los minutos de build de Netlify en cada tecla de "Guardar".
 *
 * La espera se reinicia con cada guardado, asi que hay un tope: alguien que
 * edite sin pausas veria su pagina congelada todo ese rato porque el
 * temporizador nunca llegaria a vencer.
 *
 * El "hay algo por publicar" se guarda en la base y no solo en memoria: un
 * despliegue o un reinicio del VPS entre el guardado y el disparo se llevaba
 * por delante el aviso, y el cambio se quedaba sin publicar para siempre.
 */
const ESPERA_POR_DEFECTO = 20;
const TOPE_POR_DEFECTO = 120;

let timer = null;

function segundos(nombre, porDefecto) {
  const valor = Number(process.env[nombre]);
  return (Number.isFinite(valor) && valor >= 0 ? valor : porDefecto) * 1000;
}

/* ------------------------------------------------- estado persistente */

function leerPendiente() {
  try {
    const fila = obtenerDB()
      .prepare("SELECT valor FROM meta WHERE clave = 'rebuild_pendiente_desde'")
      .get();
    return fila ? Number(fila.valor) : null;
  } catch {
    return null;
  }
}

function guardarPendiente(desde) {
  try {
    const db = obtenerDB();
    if (desde === null) {
      db.prepare("DELETE FROM meta WHERE clave = 'rebuild_pendiente_desde'").run();
    } else {
      db.prepare(
        "INSERT INTO meta (clave, valor) VALUES ('rebuild_pendiente_desde', ?) " +
          'ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
      ).run(String(desde));
    }
  } catch {
    // Si la base no esta lista, el agrupado sigue funcionando en memoria.
  }
}

/* -------------------------------------------------------- disparo */

async function disparar(hook) {
  timer = null;
  try {
    const res = await fetch(hook, { method: 'POST' });
    if (res.ok) {
      guardarPendiente(null);
      console.log(`[rebuild] build solicitado a Netlify (HTTP ${res.status})`);
    } else {
      // Se deja pendiente para reintentarlo en el proximo guardado o arranque.
      console.error(`[rebuild] Netlify respondio ${res.status}; queda pendiente`);
    }
  } catch (err) {
    console.error('[rebuild] fallo al llamar el build hook:', err.message, '- queda pendiente');
  }
}

export function scheduleRebuild() {
  const hook = process.env.NETLIFY_BUILD_HOOK;
  if (!hook) {
    console.warn('[rebuild] NETLIFY_BUILD_HOOK sin configurar: no se regenera el sitio');
    return;
  }

  const espera = segundos('REBUILD_DELAY_SECONDS', ESPERA_POR_DEFECTO);
  const tope = segundos('REBUILD_MAX_DELAY_SECONDS', TOPE_POR_DEFECTO);

  let desde = leerPendiente();
  if (desde === null) {
    desde = Date.now();
    guardarPendiente(desde);
  }

  // Si el primer cambio pendiente ya lleva esperando demasiado, no se pospone
  // otra vez: se publica lo que hay.
  if (Date.now() - desde >= tope) {
    if (timer) clearTimeout(timer);
    console.log('[rebuild] se alcanzo el tope de espera, se publica ya');
    disparar(hook);
    return;
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => disparar(hook), espera);
}

/**
 * Al arrancar: si quedo algo sin publicar de antes del reinicio, se publica.
 * Es el caso de un despliegue justo despues de que un cliente guardara.
 */
export function recuperarPendiente() {
  const hook = process.env.NETLIFY_BUILD_HOOK;
  if (!hook) return;

  const desde = leerPendiente();
  if (desde === null) return;

  console.log('[rebuild] habia un cambio sin publicar antes del reinicio, se publica');
  disparar(hook);
}

export function rebuildPending() {
  return leerPendiente() !== null;
}
