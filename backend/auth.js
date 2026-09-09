// ---------------------------------------------------------------------------
// auth.js — helpers de JWT + middleware `requireAuth`.
// ---------------------------------------------------------------------------

import jwt from 'jsonwebtoken';
import { db } from './db.js';

// En producción esto DEBE venir del entorno. El fallback sólo existe para que
// el prototipo arranque sin configurar nada.
export const JWT_SECRET =
  process.env.JWT_SECRET || 'sensolab-dev-secret-change-me';
const TOKEN_TTL = '30d';

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

/**
 * Middleware: exige `Authorization: Bearer <token>` válido y carga el usuario
 * en `req.user`. Responde 401 si falta o es inválido.
 */
export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Falta el token de autenticación.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado.' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}
