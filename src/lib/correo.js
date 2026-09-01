/**
 * Avisos por correo al dueño del negocio, con Resend.
 *
 * Sirven para actuar, no para archivar: cuando alguien compra hay que
 * contactarlo para acordar el diseño de su tarjeta, y cuando a alguien le
 * falla el cobro hay unos dias de gracia para llamarlo antes de que su tarjeta
 * se apague. Por eso cada correo lleva los datos de contacto del cliente ya
 * listos para pulsar.
 *
 * Regla de oro: un fallo aqui NUNCA puede romper lo que lo disparo. Estos
 * avisos salen desde el webhook de pagos; si un error de Resend se propagara,
 * la pasarela reintentaria el evento y una tarjeta pagada podria quedarse sin
 * activar por no haberse podido mandar un correo.
 */

const API = () => process.env.RESEND_API_URL || 'https://api.resend.com/emails';

const escapar = (t = '') =>
  String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const sitio = () =>
  (process.env.SITE_URL || 'https://www.professionalprofiles.online').replace(/\/$/, '');

/** A quien se avisa. Sin esto no se manda nada, y no es un error. */
const destino = () => process.env.EMAIL_AVISOS || null;

/**
 * Remitente. Ojo con el valor por defecto: mientras no verifiques un dominio
 * propio en Resend, `onboarding@resend.dev` SOLO puede escribirle a la
 * direccion con la que abriste la cuenta. Para escribirle a cualquier otra
 * hay que verificar el dominio.
 */
const remitente = () =>
  process.env.EMAIL_FROM || 'Professional Profiles <onboarding@resend.dev>';

/**
 * Manda un correo. Nunca lanza: devuelve true o false y deja rastro en el log.
 */
async function enviar({ asunto, html }) {
  const para = destino();
  const clave = process.env.RESEND_API_KEY;

  if (!para || !clave) {
    // No es un fallo: los avisos son opcionales. Se dice una vez y se sigue.
    console.log('[correo] sin RESEND_API_KEY o EMAIL_AVISOS: no se manda aviso');
    return false;
  }

  try {
    const res = await fetch(API(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${clave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: remitente(), to: [para], subject: asunto, html }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const detalle = await res.text();
      console.error(`[correo] Resend respondio ${res.status}: ${detalle.slice(0, 200)}`);
      return false;
    }
    console.log(`[correo] aviso enviado: ${asunto}`);
    return true;
  } catch (err) {
    console.error('[correo] no se pudo enviar:', err.message);
    return false;
  }
}

/* ----------------------------------------------------------- plantillas */

const ESTILO_BOTON =
  'display:inline-block;padding:12px 22px;border-radius:10px;background:#0a1428;' +
  'color:#e6c25a;text-decoration:none;font-weight:600';

/**
 * Los contactos del cliente, como enlaces que se pueden pulsar desde el
 * correo. Es lo que hace util el aviso: se le escribe sin ir a buscar nada.
 */
function contactos(perfil) {
  const NOMBRES = {
    whatsapp: 'WhatsApp',
    phone: 'Teléfono',
    email: 'Correo',
    instagram: 'Instagram',
    facebook: 'Facebook',
    tiktok: 'TikTok',
    linkedin: 'LinkedIn',
    web: 'Sitio web',
  };

  const filas = (perfil.links || [])
    .filter((e) => e?.url)
    .map((e) => {
      const nombre = NOMBRES[e.type] || e.label || e.type;
      const visible = e.sublabel || e.url.replace(/^https?:\/\/|^mailto:|^tel:/, '');
      return `<tr>
        <td style="padding:4px 14px 4px 0;color:#6b7280">${escapar(nombre)}</td>
        <td style="padding:4px 0"><a href="${escapar(e.url)}" style="color:#1b4f9c">${escapar(visible)}</a></td>
      </tr>`;
    });

  if (!filas.length) {
    return '<p style="color:#9ca3af">No dejó ningún contacto en su tarjeta.</p>';
  }
  return `<table style="border-collapse:collapse;font-size:15px">${filas.join('')}</table>`;
}

function envoltura({ titulo, color, cuerpo, perfil }) {
  const url = `${sitio()}/${perfil.slug}`;
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:8px">
    <div style="border-left:4px solid ${color};padding-left:16px;margin-bottom:24px">
      <h1 style="margin:0;font-size:20px;color:#111827">${escapar(titulo)}</h1>
    </div>

    <p style="font-size:17px;margin:0 0 4px;color:#111827"><strong>${escapar(perfil.name)}</strong></p>
    ${perfil.role ? `<p style="margin:0 0 18px;color:#6b7280">${escapar(perfil.role)}</p>` : ''}

    ${cuerpo}

    <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin:26px 0 10px">
      Cómo contactarlo
    </h2>
    ${contactos(perfil)}

    <p style="margin:28px 0 0">
      <a href="${escapar(url)}" style="${ESTILO_BOTON}">Ver su tarjeta</a>
    </p>
    <p style="margin:10px 0 0;font-size:13px;color:#9ca3af">${escapar(url)}</p>
  </div>`;
}

/** Alguien pago y su tarjeta ya esta activa. */
export function avisarVenta(perfil) {
  return enviar({
    asunto: `Nueva tarjeta pagada: ${perfil.name}`,
    html: envoltura({
      titulo: 'Tienes un cliente nuevo',
      color: '#16a34a',
      perfil,
      cuerpo:
        '<p style="color:#374151;line-height:1.6">Ya pagó y su tarjeta está activa. ' +
        'Escríbele para acordar el diseño.</p>',
    }),
  });
}

/**
 * Fallo un cobro. Es el aviso mas urgente de los tres: hay una cuenta atras
 * antes de que la tarjeta deje de verse, y con el QR ya impreso conviene
 * llamar al cliente antes de que se entere por un prospecto.
 */
export function avisarImpago(perfil, { graciaHasta, dias }) {
  const fecha = graciaHasta
    ? new Date(graciaHasta).toLocaleDateString('es-GT', {
        day: 'numeric',
        month: 'long',
        timeZone: process.env.ZONA_HORARIA || 'America/Guatemala',
      })
    : null;

  return enviar({
    asunto: `Cobro fallido: ${perfil.name}`,
    html: envoltura({
      titulo: 'Le falló el cobro',
      color: '#dc2626',
      perfil,
      cuerpo:
        '<p style="color:#374151;line-height:1.6">Su tarjeta <strong>sigue viéndose completa</strong> ' +
        `durante ${dias} días. ` +
        (fecha
          ? `Si no se resuelve, el <strong>${escapar(fecha)}</strong> pasará a mostrar la página de no disponible.`
          : '') +
        '</p><p style="color:#374151;line-height:1.6">Si tiene tarjetas impresas circulando, ' +
        'conviene avisarle antes de que se entere por un cliente suyo.</p>',
    }),
  });
}

/** El cliente dio de baja la suscripcion. */
export function avisarBaja(perfil) {
  return enviar({
    asunto: `Suscripción cancelada: ${perfil.name}`,
    html: envoltura({
      titulo: 'Se dio de baja',
      color: '#6b7280',
      perfil,
      cuerpo:
        '<p style="color:#374151;line-height:1.6">Su tarjeta ya no se muestra. ' +
        'Los datos se conservan: si vuelve a pagar, se reactiva tal como estaba.</p>',
    }),
  });
}
