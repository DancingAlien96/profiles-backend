import 'dotenv/config';
import { createApp } from './app.js';
import { connectDB } from './db.js';

const port = process.env.PORT || 3000;

connectDB()
  .then(() => createApp().listen(port, () => console.log(`[api] escuchando en :${port}`)))
  .catch((err) => {
    console.error('[api] no se pudo iniciar:', err.message);
    process.exit(1);
  });
