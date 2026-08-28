/**
 * Dispara el build hook de Netlify para regenerar el sitio estatico.
 *
 * Se agrupa con un temporizador: si el cliente guarda cinco veces seguidas
 * mientras acomoda su perfil, solo se dispara un build al final. Sin esto
 * gastarias los minutos de build de Netlify en cada tecla de "Guardar".
 *
 * La espera se reinicia con cada guardado, asi que hay un tope: alguien que
 * edite sin pausas durante media hora veria su pagina congelada todo ese rato
 * porque el temporizador nunca llegaria a vencer.
 */
const ESPERA_POR_DEFECTO = 20;
const TOPE_POR_DEFECTO = 120;

let timer = null;
let pendienteDesde = null;

function segundos(nombre, porDefecto) {
  const valor = Number(process.env[nombre]);
  return (Number.isFinite(valor) && valor >= 0 ? valor : porDefecto) * 1000;
}

async function disparar(hook) {
  timer = null;
  pendienteDesde = null;
  try {
    const res = await fetch(hook, { method: 'POST' });
    console.log(`[rebuild] build solicitado a Netlify (HTTP ${res.status})`);
  } catch (err) {
    console.error('[rebuild] fallo al llamar el build hook:', err.message);
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

  if (pendienteDesde === null) pendienteDesde = Date.now();

  // Si el primer cambio pendiente ya lleva esperando demasiado, no se pospone
  // otra vez: se publica lo que hay.
  if (Date.now() - pendienteDesde >= tope) {
    if (timer) clearTimeout(timer);
    console.log('[rebuild] se alcanzo el tope de espera, se publica ya');
    disparar(hook);
    return;
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => disparar(hook), espera);
}

/** Segundos aproximados que faltan para que el sitio publico se actualice. */
export function rebuildPending() {
  return pendienteDesde !== null;
}
