/**
 * Webhooks de Recurrente.
 *
 * Es la unica ruta que mueve el estado de una suscripcion sin que nadie del
 * negocio intervenga, asi que se protege por tres lados:
 *
 *  1. Firma: solo se atiende lo que venga firmado con la clave del endpoint.
 *  2. Pertenencia: la cuenta de la pasarela es compartida con otro sistema del
 *     negocio y Svix reparte cada evento a todos los endpoints. Lo que no
 *     lleve nuestra marca se descarta con un 200, para no ensuciar de errores
 *     el panel y que un fallo de verdad se vea.
 *  3. Idempotencia: Svix reintenta si no contestamos 2xx. El mismo cobro puede
 *     llegar varias veces y solo debe sumar un mes.
 */
import { Router } from 'express';
import * as Suscripcion from '../models/Suscripcion.js';
import { firmaValida, slugDelEvento } from '../lib/recurrente.js';
import { obtenerDB } from '../db.js';

const router = Router();

/**
 * Cuando el evento no trae nuestra metadata (los de suscripcion no siempre la
 * propagan), se busca la tarjeta por los identificadores que guardamos al
 * activarla.
 *
 * Solo se buscan identificadores unicos POR SUSCRIPCION o POR COBRO. El id de
 * cliente queda fuera a proposito, aunque tambien lo guardamos: la cuenta de
 * la pasarela es compartida con otro sistema del negocio, y una misma persona
 * puede ser cliente de los dos. Buscar por cliente haria que un evento del
 * otro sistema encontrara coincidencia aqui y moviera el estado de una tarjeta
 * que no tiene nada que ver.
 */
function slugPorIdentificadores(evento) {
  const db = obtenerDB();
  const candidatos = [
    ['suscripcion_id', evento?.subscription?.id || evento?.subscription_id],
    ['checkout_id', evento?.checkout?.id || evento?.checkout_id],
  ];

  for (const [columna, valor] of candidatos) {
    if (!valor) continue;
    const fila = db.prepare(`SELECT slug FROM suscripciones WHERE ${columna} = ?`).get(valor);
    if (fila) return fila.slug;
  }
  return null;
}

router.post('/recurrente', (req, res) => {
  // req.body es un Buffer: la firma se calcula sobre el cuerpo crudo.
  const crudo = req.body;

  let valida;
  try {
    valida = firmaValida(crudo, req.headers);
  } catch (err) {
    // Falta configuracion. Es un 500 nuestro, no del que llama: si
    // respondieramos 200 perderiamos eventos de cobros reales en silencio.
    console.error('[webhook] no se puede verificar la firma:', err.message);
    return res.status(500).json({ error: 'Webhook mal configurado' });
  }

  if (!valida) {
    console.warn('[webhook] firma invalida; se descarta');
    return res.status(400).json({ error: 'Firma invalida' });
  }

  let evento;
  try {
    evento = JSON.parse(crudo.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Cuerpo ilegible' });
  }

  const tipo = evento.event_type || evento.type || 'desconocido';
  const slug = slugDelEvento(evento) || slugPorIdentificadores(evento);

  // No es de este sistema: 200 para que Svix lo de por entregado.
  if (!slug) {
    return res.status(200).json({ ok: true, ignorado: 'no es de este sistema' });
  }

  const idEvento = req.get('svix-id');
  if (!Suscripcion.registrarEvento({ id: idEvento, tipo, slug, cuerpo: crudo.toString('utf8') })) {
    console.log(`[webhook] ${tipo} de ${slug} ya estaba aplicado; se ignora`);
    return res.status(200).json({ ok: true, repetido: true });
  }

  try {
    aplicar(tipo, slug, evento);
  } catch (err) {
    // Se contesta 500 a proposito para que Svix reintente: es dinero, y
    // perder una activacion deja al cliente pagando sin tarjeta.
    console.error(`[webhook] fallo al aplicar ${tipo} de ${slug}:`, err.message);
    obtenerDB().prepare('DELETE FROM eventos_webhook WHERE id = ?').run(idEvento);
    return res.status(500).json({ error: 'No se pudo aplicar' });
  }

  res.status(200).json({ ok: true });
});

/**
 * Reduce el nombre del evento a la accion que representa.
 *
 * La pasarela nombra el cobro segun como se pago: intent.succeeded con
 * tarjeta, pero tambien balance_intent.paid, bank_transfer_intent.succeeded o
 * automated_bank_transfer_intent.succeeded. Comparar contra una lista cerrada
 * de nombres exactos falla en silencio de la peor forma: el cliente paga, el
 * evento llega, y la tarjeta no se activa porque el nombre no estaba previsto.
 *
 * Se mira solo el final del nombre. Es seguro porque para llegar aqui el
 * evento ya demostro ser de una tarjeta nuestra: sin esa marca no se procesa.
 */
function accionDe(tipo) {
  const [familia, resultado] = String(tipo).split('.');

  if (familia.endsWith('intent')) {
    if (resultado === 'succeeded' || resultado === 'paid') return 'cobrado';
    if (resultado === 'failed') return 'fallo_un_intento';
    return null;
  }

  if (familia === 'subscription') return `suscripcion_${resultado}`;
  return null;
}

/** Traduce el evento de la pasarela a un cambio de estado. */
function aplicar(tipoOriginal, slug, evento) {
  const tipo = accionDe(tipoOriginal) || tipoOriginal;

  switch (tipo) {
    case 'cobrado': {
      Suscripcion.activar(slug, {
        suscripcionId: evento?.subscription?.id || evento?.subscription_id || null,
        clienteId: evento?.customer?.id || evento?.customer_id || null,
      });
      // La tarjeta se publica al cobrar el primer mes: hasta aqui existia
      // pero no se veia.
      obtenerDB()
        .prepare('UPDATE profiles SET published = 1 WHERE slug = ?')
        .run(slug);
      console.log(`[webhook] ${slug}: pago recibido, suscripcion activa`);
      break;
    }

    case 'suscripcion_past_due': {
      Suscripcion.marcarImpago(slug);
      console.log(
        `[webhook] ${slug}: cobro fallido, ${Suscripcion.diasDeGracia()} dias de gracia`
      );
      break;
    }

    case 'suscripcion_cancel': {
      Suscripcion.cambiarEstado(slug, 'cancelada');
      console.log(`[webhook] ${slug}: suscripcion cancelada`);
      break;
    }

    case 'suscripcion_pause': {
      Suscripcion.cambiarEstado(slug, 'suspendida');
      break;
    }

    case 'suscripcion_reactivate':
    case 'suscripcion_unpause': {
      Suscripcion.activar(slug);
      break;
    }

    case 'fallo_un_intento':
      // No cambia el estado: quien lo mueve es subscription.past_due, que
      // llega cuando la pasarela da el cobro por perdido. Un fallo suelto
      // puede ser un reintento que despues sale bien.
      console.log(`[webhook] ${slug}: intento de cobro fallido`);
      break;

    default:
      console.log(`[webhook] ${slug}: ${tipoOriginal} sin accion asociada`);
  }
}

export default router;
