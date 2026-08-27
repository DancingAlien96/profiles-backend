import mongoose from 'mongoose';

/**
 * Un enlace de la tarjeta. `sublabel` es opcional: algunos temas lo muestran
 * debajo del titulo del boton (ej. el numero de telefono bajo "WhatsApp").
 */
const linkSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ['whatsapp', 'linkedin', 'email', 'phone', 'web', 'instagram', 'facebook', 'tiktok', 'catalogo', 'ubicacion'],
    },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    sublabel: { type: String, trim: true, maxlength: 60, default: '' },
    url: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    // Identificador en la URL: /renealvarado
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]{3,40}$/, 'El slug solo admite minusculas, numeros y guiones'],
    },

    // Datos editables por el cliente
    name: { type: String, required: true, trim: true, maxlength: 60 },
    role: { type: String, trim: true, maxlength: 80, default: '' },
    tagline: { type: String, trim: true, maxlength: 300, default: '' },
    footer: { type: String, trim: true, maxlength: 80, default: '' },
    links: { type: [linkSchema], default: [], validate: [(v) => v.length <= 8, 'Maximo 8 enlaces'] },

    // Foto guardada en Mongo. `select: false` para no arrastrar el binario
    // en cada consulta: solo se lee en la ruta que la sirve.
    photo: {
      data: { type: Buffer, select: false },
      contentType: { type: String, default: '' },
      updatedAt: { type: Date },
    },

    // Apariencia: la elige el cliente entre los temas disponibles, pero no
    // puede editar el CSS. Ver web/src/themes/
    theme: { type: String, default: 'oro-tech', maxlength: 40 },

    // Acceso
    passwordHash: { type: String, required: true, select: false },
    mustChangePassword: { type: Boolean, default: true },
    failedAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, select: false },

    published: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/** Version segura para el frontend: nunca expone hash ni binarios. */
profileSchema.methods.toPublic = function () {
  return {
    slug: this.slug,
    name: this.name,
    role: this.role,
    tagline: this.tagline,
    footer: this.footer,
    links: this.links,
    theme: this.theme,
    published: this.published,
    hasPhoto: Boolean(this.photo?.updatedAt),
    photoUpdatedAt: this.photo?.updatedAt || null,
    mustChangePassword: this.mustChangePassword,
    updatedAt: this.updatedAt,
  };
};

export default mongoose.model('Profile', profileSchema);
