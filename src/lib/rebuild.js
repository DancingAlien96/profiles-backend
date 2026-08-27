/**
 * Dispara el build hook de Netlify para regenerar el sitio estatico.
 *
 * Se agrupa con un temporizador: si el cliente guarda cinco veces seguidas
 * mientras acomoda su perfil, solo se dispara un build al final. Sin esto
 * gastarias los minutos de build de Netlify en cada tecla de "Guardar".
 */
let timer = null;
let pending = false;

export function scheduleRebuild() {
  const hook = process.env.NETLIFY_BUILD_HOOK;
  if (!hook) {
    console.warn('[rebuild] NETLIFY_BUILD_HOOK sin configurar: no se regenera el sitio');
    return;
  }

  const delay = Number(process.env.REBUILD_DELAY_SECONDS || 60) * 1000;
  pending = true;
  if (timer) clearTimeout(timer);

  timer = setTimeout(async () => {
    timer = null;
    pending = false;
    try {
      const res = await fetch(hook, { method: 'POST' });
      console.log(`[rebuild] build solicitado a Netlify (HTTP ${res.status})`);
    } catch (err) {
      console.error('[rebuild] fallo al llamar el build hook:', err.message);
    }
  }, delay);
}

/** Segundos aproximados que faltan para que el sitio publico se actualice. */
export function rebuildPending() {
  return pending;
}
