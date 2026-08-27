import { Router } from 'express';
import * as Invitacion from '../models/Invitation.js';
import * as Perfil from '../models/Profile.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

/* ------------------------------------------------------------- publico */

/**
 * Estado de una invitacion. La usa el formulario de alta para saber si puede
 * mostrarse antes de que el cliente llene nada.
 */
router.get('/:token', (req, res) => {
  const resultado = Invitacion.revisar(req.params.token);
  if (!resultado.ok) return res.status(410).json({ error: resultado.motivo });

  // Solo lo necesario: nada de notas internas ni fechas de creacion.
  res.json({
    ok: true,
    plantilla: resultado.invitacion.plantilla,
    // Si viene fijada, el formulario la muestra bloqueada: la tarjeta NFC o el
    // QR ya estan impresos con esa direccion.
    slug: resultado.invitacion.slug,
    expiresAt: resultado.invitacion.expires_at,
  });
});

/* ------------------------------------------------------ administracion */

router.post('/', requireAdmin, (req, res) => {
  const { nota, plantilla, dias } = req.body || {};
  const slug = req.body?.slug ? String(req.body.slug).toLowerCase().trim() : null;

  // Fijar la direccion es lo que permite imprimir el QR y la tarjeta NFC
  // antes de que el cliente llene el formulario, asi que se valida aqui:
  // despues ya no se puede cambiar sin invalidar lo impreso.
  if (slug) {
    const motivo = Perfil.motivoSlugNoDisponible(slug) || (
      Invitacion.slugApartado(slug) ? 'Ya hay otra invitacion pendiente con esa direccion.' : null
    );
    if (motivo) return res.status(409).json({ error: motivo });
  }

  const diasValidos = Number(dias) > 0 && Number(dias) <= 90 ? Number(dias) : undefined;
  const invitacion = Invitacion.crear({ nota, plantilla, slug, dias: diasValidos });

  res.status(201).json({ invitacion });
});

router.get('/', requireAdmin, (_req, res) => {
  res.json(Invitacion.listar().map(Invitacion.aPublico));
});

router.delete('/:token', requireAdmin, (req, res) => {
  if (!Invitacion.borrar(req.params.token)) {
    return res.status(404).json({ error: 'Invitacion no encontrada' });
  }
  res.json({ ok: true });
});

export default router;
