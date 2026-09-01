/**
 * Cliente de Recurrente, la pasarela con la que se cobra la suscripcion.
 *
 * Dos cosas viven aqui: crear el checkout que se le presenta al cliente, y
 * verificar la firma de los webhooks que devuelve la pasarela.
 *
 * Docs: https://docs.recurrente.com
 */
import crypto from 'node:crypto';

const BASE = process.env.RECURRENTE_API_URL || 'https://app.recurrente.com/api';

/**
 * Marca de este sistema en la metadata del checkout.
 *
 * La cuenta de Recurrente es la misma para varios productos del negocio, y los
 * webhooks de Svix se reparten a TODOS los endpoints de la cuenta: aqui llegan
 * tambien los cobros del otro sistema. Sin esta marca, cada uno de esos pagos
 * seria un evento que no sabriamos interpretar, y el endpoint acumularia
 * errores hasta que un fallo de verdad pasara desapercibido entre el ruido.
 */
export const APP = 'perfiles';

function credenciales() {
  const publica = process.env.RECURRENTE_PUBLIC_KEY;
  const secreta = process.env.RECURRENTE_SECRET_KEY;
  if (!publica || !secreta) {
    throw new Error('Faltan RECURRENTE_PUBLIC_KEY o RECURRENTE_SECRET_KEY');
  }
  return { 'X-PUBLIC-KEY': publica, 'X-SECRET-KEY': secreta };
}

async function pedir(ruta, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${ruta}`, {
    method,
    headers: { ...credenciales(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    // La pasarela contesto algo que no es JSON: se reporta tal cual.
  }

  if (!res.ok) {
    const detalle = datos?.message || datos?.error || texto.slice(0, 200);
    throw new Error(`Recurrente respondio ${res.status}: ${detalle}`);
  }
  return datos;
}

/**
 * Crea el checkout de la suscripcion de una tarjeta.
 *
 * El slug viaja en la metadata porque es lo unico que ata el pago a la
 * tarjeta: cuando vuelva el webhook, es como sabremos cual activar.
 */
export async function crearCheckout({ slug, exitoUrl, cancelUrl }) {
  const priceId = process.env.RECURRENTE_PRICE_ID;
  if (!priceId) throw new Error('Falta RECURRENTE_PRICE_ID');

  const respuesta = await pedir('/checkouts', {
    method: 'POST',
    body: {
      items: [{ price_id: priceId, quantity: 1 }],
      success_url: exitoUrl,
      cancel_url: cancelUrl,
      metadata: { app: APP, slug },
    },
  });

  if (!respuesta?.checkout_url) {
    throw new Error('Recurrente no devolvio checkout_url');
  }
  return { id: respuesta.id, url: respuesta.checkout_url };
}

/* --------------------------------------------------------- webhooks */

/**
 * Verifica la firma de un webhook, que viene en el formato de Svix.
 *
 * Se firma la cadena "<id>.<timestamp>.<cuerpo>" con HMAC-SHA256 y la clave
 * del endpoint, que llega en base64 detras del prefijo "whsec_".
 *
 * El cuerpo tiene que ser el CRUDO, byte a byte. Si se firma el resultado de
 * volver a serializar el JSON ya parseado, la firma no cuadra: basta con que
 * la pasarela ponga las claves en otro orden o formatee un decimal distinto.
 *
 * @param {Buffer|string} cuerpo cuerpo crudo de la peticion
 * @param {object} cabeceras     req.headers
 * @returns {boolean}
 */
export function firmaValida(cuerpo, cabeceras) {
  const secreto = process.env.RECURRENTE_WEBHOOK_SECRET;
  if (!secreto) throw new Error('Falta RECURRENTE_WEBHOOK_SECRET');

  const id = cabeceras['svix-id'];
  const marca = cabeceras['svix-timestamp'];
  const firmas = cabeceras['svix-signature'];
  if (!id || !marca || !firmas) return false;

  // Un evento viejo reenviado por alguien que lo intercepto no debe valer.
  const edad = Math.abs(Date.now() / 1000 - Number(marca));
  if (!Number.isFinite(edad) || edad > 300) return false;

  const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  const texto = `${id}.${marca}.${Buffer.isBuffer(cuerpo) ? cuerpo.toString('utf8') : cuerpo}`;
  const esperada = crypto.createHmac('sha256', clave).update(texto).digest('base64');

  // La cabecera puede traer varias firmas separadas por espacio, cada una con
  // su version: "v1,<firma> v1,<otra>". Se acepta si alguna cuadra, que es lo
  // que permite rotar la clave sin perder eventos.
  return firmas.split(' ').some((entrada) => {
    const valor = entrada.split(',')[1];
    if (!valor) return false;
    const a = Buffer.from(valor);
    const b = Buffer.from(esperada);
    // Comparacion en tiempo constante: comparar con === filtra por el tiempo
    // que tarda en fallar y deja adivinar la firma byte a byte.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/**
 * Saca el slug de nuestra tarjeta de un evento, o null si el evento no es de
 * este sistema. La metadata puede venir en varios sitios segun el evento.
 */
export function slugDelEvento(evento) {
  const posibles = [
    evento?.metadata,
    evento?.checkout?.metadata,
    evento?.payment?.metadata,
    evento?.subscription?.metadata,
  ];
  for (const meta of posibles) {
    if (meta && meta.app === APP && typeof meta.slug === 'string') return meta.slug.toLowerCase();
  }
  return null;
}
