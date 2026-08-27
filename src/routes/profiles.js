import { Router } from 'express';
import bcrypt from 'bcryptjs';
import Profile from '../models/Profile.js';
import { requireAuth, requireOwner, requireAdmin } from '../middleware/auth.js';
import { scheduleRebuild } from '../lib/rebuild.js';

const router = Router();

// La foto llega ya comprimida por el navegador (400x400 WebP). Este limite
// es la red de seguridad por si alguien llama la API por fuera del panel.
const MAX_PHOTO_BYTES = 200 * 1024;

/* --------------------------------------------------------------- publico */

/** Lista completa. La consume el build de Netlify para generar las paginas. */
router.get('/', async (_req, res) => {
  const profiles = await Profile.find({ published: true }).sort({ slug: 1 });
  res.json(profiles.map((p) => p.toPublic()));
});

router.get('/:slug', async (req, res) => {
  const profile = await Profile.findOne({ slug: req.params.slug.toLowerCase() });
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
  res.json(profile.toPublic());
});

/** Sirve la imagen. La usa el build para bajarla y publicarla en Netlify. */
router.get('/:slug/photo', async (req, res) => {
  const profile = await Profile.findOne({ slug: req.params.slug.toLowerCase() }).select(
    '+photo.data photo.contentType photo.updatedAt'
  );
  if (!profile?.photo?.data) return res.status(404).json({ error: 'Sin foto' });

  res.set('Content-Type', profile.photo.contentType || 'image/webp');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(profile.photo.data);
});

/* ------------------------------------------------- edicion (dueño) */

router.put('/:slug', requireAuth, requireOwner, async (req, res) => {
  const profile = await Profile.findOne({ slug: req.params.slug.toLowerCase() });
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

  // Lista blanca: el cliente edita contenido, nunca slug, clave ni estado.
  const editable = ['name', 'role', 'tagline', 'footer', 'links', 'theme'];
  for (const field of editable) {
    if (req.body[field] !== undefined) profile[field] = req.body[field];
  }

  try {
    await profile.save();
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  scheduleRebuild();
  res.json({ profile: profile.toPublic(), rebuild: true });
});

/** Recibe la foto como data URL (base64) desde el panel. */
router.put('/:slug/photo', requireAuth, requireOwner, async (req, res) => {
  const { dataUrl } = req.body || {};
  const match = /^data:(image\/(?:webp|jpeg|png));base64,(.+)$/.exec(dataUrl || '');
  if (!match) {
    return res.status(400).json({ error: 'Imagen invalida. Debe ser WebP, JPEG o PNG.' });
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_PHOTO_BYTES) {
    return res.status(413).json({
      error: `La imagen pesa ${Math.round(buffer.length / 1024)} KB y el maximo es ${MAX_PHOTO_BYTES / 1024} KB.`,
    });
  }

  const profile = await Profile.findOne({ slug: req.params.slug.toLowerCase() });
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });

  profile.photo = { data: buffer, contentType: match[1], updatedAt: new Date() };
  await profile.save();

  scheduleRebuild();
  res.json({ ok: true, bytes: buffer.length });
});

/* ----------------------------------------------------- administracion */

router.post('/', requireAdmin, async (req, res) => {
  const { slug, name, password, theme, role, tagline, footer, links } = req.body || {};
  if (!slug || !name || !password) {
    return res.status(400).json({ error: 'slug, name y password son obligatorios' });
  }

  const exists = await Profile.findOne({ slug: String(slug).toLowerCase() });
  if (exists) return res.status(409).json({ error: 'Ya existe un perfil con ese slug' });

  try {
    const profile = await Profile.create({
      slug: String(slug).toLowerCase(),
      name,
      role: role || '',
      tagline: tagline || '',
      footer: footer || '',
      links: links || [],
      theme: theme || 'oro-tech',
      passwordHash: await bcrypt.hash(String(password), 12),
      mustChangePassword: true,
    });
    scheduleRebuild();
    res.status(201).json({ profile: profile.toPublic() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Restablece la clave de un cliente que la olvido. */
router.post('/:slug/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Falta la nueva clave' });

  // updateOne y no save(): passwordHash, failedAttempts y lockedUntil llevan
  // `select: false`, y un save() sobre campos no seleccionados es fragil.
  const resultado = await Profile.updateOne(
    { slug: req.params.slug.toLowerCase() },
    {
      $set: {
        passwordHash: await bcrypt.hash(String(password), 12),
        mustChangePassword: true,
        failedAttempts: 0,
      },
      $unset: { lockedUntil: '' },
    }
  );
  if (!resultado.matchedCount) return res.status(404).json({ error: 'Perfil no encontrado' });

  res.json({ ok: true });
});

router.patch('/:slug/published', requireAdmin, async (req, res) => {
  const profile = await Profile.findOneAndUpdate(
    { slug: req.params.slug.toLowerCase() },
    { published: Boolean(req.body?.published) },
    { new: true }
  );
  if (!profile) return res.status(404).json({ error: 'Perfil no encontrado' });
  scheduleRebuild();
  res.json({ profile: profile.toPublic() });
});

export default router;
