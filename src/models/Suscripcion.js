/**
 * La suscripcion de cada tarjeta: $6.99 al mes, una por perfil.
 *
 * Estados y quien los mueve:
 *
 *   pendiente_pago  se creo el perfil pero nadie ha pagado todavia
 *   activa          pago recibido; vale hasta periodo_fin
 *   en_gracia       fallo un cobro, pero la tarjeta SIGUE visible
 *   suspendida      se acabo la gracia; la tarjeta deja de mostrarse entera
 *   cancelada       el cliente o el dueño la dieron de baja
 *   cortesia        regalada: no caduca y la pasarela no la toca nunca
 *
 * La gracia existe por el plastico: el cliente reparte tarjetas NFC y codigos
 * QR impresos que no se pueden corregir. Que una tarjeta muera por una tarjeta
 * de credito vencida, delante de un prospecto que la acaba de escanear, es un
 * daño que no se arregla devolviendo el dinero.
 */
import { obtenerDB } from '../db.js';

const ahora = () => new Date().toISOString();

const DIAS_GRACIA_POR_DEFECTO = 7;

export const diasDeGracia = () => {
  const valor = Number(process.env.DIAS_DE_GRACIA);
  return Number.isFinite(valor) && valor >= 0 ? valor : DIAS_GRACIA_POR_DEFECTO;
};

const sumarDias = (dias, desde = new Date()) =>
  new Date(desde.getTime() + dias * 24 * 3600 * 1000).toISOString();

/** Un mes natural, no 30 dias: es lo que cobra la pasarela. */
function sumarUnMes(desde = new Date()) {
  const d = new Date(desde);
  const dia = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1);
  // Del 31 de enero se pasa al 3 de marzo si no se corrige.
  if (d.getUTCDate() < dia) d.setUTCDate(0);
  return d.toISOString();
}

/* ------------------------------------------------------------- lectura */

export function porSlug(slug) {
  return (
    obtenerDB()
      .prepare('SELECT * FROM suscripciones WHERE slug = ?')
      .get(String(slug).toLowerCase()) || null
  );
}

/**
 * El estado de verdad, ya contando el paso del tiempo.
 *
 * La gracia vence sola. Se calcula al leer y no con una tarea programada,
 * porque una tarea que deja de correr no avisa: las tarjetas se quedarian
 * visibles sin pagar y nadie lo notaria hasta revisar las cuentas.
 */
export function estadoEfectivo(fila) {
  if (!fila) return 'sin_suscripcion';
  // La cortesia no caduca: no tiene periodo que se acabe.
  if (fila.estado === 'cortesia') return 'cortesia';
  if (fila.estado === 'en_gracia' && fila.gracia_hasta && fila.gracia_hasta <= ahora()) {
    return 'suspendida';
  }
  return fila.estado;
}

/** Marca una tarjeta como regalada. No vuelve a cobrarse ni caduca. */
export function marcarCortesia(slug) {
  const t = ahora();
  obtenerDB()
    .prepare(
      `INSERT INTO suscripciones (slug, estado, creada_en, actualizada_en)
       VALUES (?, 'cortesia', ?, ?)
       ON CONFLICT(slug) DO UPDATE SET estado = 'cortesia', gracia_hasta = NULL, actualizada_en = excluded.actualizada_en`
    )
    .run(String(slug).toLowerCase(), t, t);
  return porSlug(slug);
}

/**
 * Que ve quien abre la tarjeta. Solo dos valores, y a proposito: el visitante
 * no tiene por que enterarse de si el cliente esta en gracia o debiendo.
 *
 * Una tarjeta SIN fila de suscripcion se ve entera. Son dos casos legitimos:
 * las que existian antes de que hubiera cobro, y las que el dueño regala o
 * cobra por fuera. Ninguna de las dos ha dejado de pagar.
 *
 * El sentido del fallo importa aqui mas que en otros sitios. Equivocarse hacia
 * "se ve" regala una tarjeta; equivocarse hacia "suspendida" apaga el codigo
 * QR impreso de alguien que si pago, y eso no se arregla con un reembolso.
 */
export function acceso(slug) {
  const fila = porSlug(slug);
  if (!fila) return 'completo';

  const estado = estadoEfectivo(fila);
  return ['activa', 'en_gracia', 'cortesia'].includes(estado) ? 'completo' : 'suspendido';
}

export function listarTodas() {
  return obtenerDB().prepare('SELECT * FROM suscripciones').all();
}

/* ------------------------------------------------------------ escritura */

export function crearPendiente(slug, { checkoutId = null } = {}) {
  const t = ahora();
  obtenerDB()
    .prepare(
      `INSERT INTO suscripciones (slug, estado, checkout_id, creada_en, actualizada_en)
       VALUES (?, 'pendiente_pago', ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET checkout_id = excluded.checkout_id, actualizada_en = excluded.actualizada_en`
    )
    .run(String(slug).toLowerCase(), checkoutId, t, t);
  return porSlug(slug);
}

/**
 * Pago recibido: la tarjeta queda activa un mes mas.
 *
 * Al renovar se cuenta desde periodo_fin y no desde hoy, para que quien paga
 * con unos dias de retraso no pierda esos dias.
 */
export function activar(slug, { suscripcionId, clienteId } = {}) {
  const actual = porSlug(slug);
  const base =
    actual?.periodo_fin && actual.periodo_fin > ahora() ? new Date(actual.periodo_fin) : new Date();

  const t = ahora();
  obtenerDB()
    .prepare(
      `UPDATE suscripciones
          SET estado = 'activa',
              periodo_fin = ?,
              gracia_hasta = NULL,
              suscripcion_id = COALESCE(?, suscripcion_id),
              cliente_id = COALESCE(?, cliente_id),
              actualizada_en = ?
        WHERE slug = ?`
    )
    .run(sumarUnMes(base), suscripcionId ?? null, clienteId ?? null, t, String(slug).toLowerCase());

  return porSlug(slug);
}

/** Fallo un cobro: empieza la gracia, pero la tarjeta sigue viendose. */
export function marcarImpago(slug) {
  const t = ahora();
  obtenerDB()
    .prepare(
      `UPDATE suscripciones
          SET estado = 'en_gracia', gracia_hasta = ?, actualizada_en = ?
        WHERE slug = ? AND estado IN ('activa', 'en_gracia')`
    )
    .run(sumarDias(diasDeGracia()), t, String(slug).toLowerCase());

  return porSlug(slug);
}

export function cambiarEstado(slug, estado) {
  const t = ahora();
  return obtenerDB()
    .prepare('UPDATE suscripciones SET estado = ?, actualizada_en = ? WHERE slug = ?')
    .run(estado, t, String(slug).toLowerCase()).changes;
}

/* ------------------------------------------------- eventos ya aplicados */

/**
 * Svix reintenta si no contestamos 2xx, asi que el mismo evento puede llegar
 * varias veces. Sin esto, un reintento de un cobro correcto sumaria otro mes.
 * Devuelve false si ya se habia procesado.
 */
export function registrarEvento({ id, tipo, slug, cuerpo }) {
  try {
    obtenerDB()
      .prepare(
        'INSERT INTO eventos_webhook (id, tipo, slug, cuerpo, recibido_en) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, tipo, slug ?? null, cuerpo, ahora());
    return true;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

/** Para el panel: la suscripcion con su estado ya resuelto. */
export function aPublico(fila) {
  if (!fila) return null;
  return {
    slug: fila.slug,
    estado: estadoEfectivo(fila),
    estadoGuardado: fila.estado,
    periodoFin: fila.periodo_fin,
    graciaHasta: fila.gracia_hasta,
    tienePasarela: Boolean(fila.suscripcion_id),
  };
}
