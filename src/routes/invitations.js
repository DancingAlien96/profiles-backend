import { Router } from 'express';
import * as Invitacion from '../models/Invitation.js';
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
    expiresAt: resultado.invitacion.expires_at,
  });
});

/* ------------------------------------------------------ administracion */

router.post('/', requireAdmin, (req, res) => {
  const { nota, plantilla, dias } = req.body || {};

  const diasValidos = Number(dias) > 0 && Number(dias) <= 90 ? Number(dias) : undefined;
  const invitacion = Invitacion.crear({ nota, plantilla, dias: diasValidos });

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
