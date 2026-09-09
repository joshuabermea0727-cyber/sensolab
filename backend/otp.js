// ---------------------------------------------------------------------------
// otp.js — códigos de un solo uso para registro / login sin contraseña.
//
// En dev el código se DEVUELVE en la respuesta del endpoint (no hay envío de
// correo/SMS). En producción se cambiaría issueOtp() para despachar por email
// o SMS y no exponer el código.
// ---------------------------------------------------------------------------

import { db } from './db.js';

const TTL_MIN = 10;

const insOtp = db.prepare(`
  INSERT INTO auth_otps (email, code, purpose, expires_at)
  VALUES (?, ?, ?, ?)
`);
const findOtp = db.prepare(`
  SELECT * FROM auth_otps
  WHERE email = ? AND purpose = ? AND consumed = 0 AND expires_at > datetime('now')
  ORDER BY id DESC LIMIT 1
`);
const consumeOtp = db.prepare('UPDATE auth_otps SET consumed = 1 WHERE id = ?');
const consumeAllFor = db.prepare(
  "UPDATE auth_otps SET consumed = 1 WHERE email = ? AND purpose = ? AND consumed = 0"
);

const sixDigits = () => String(Math.floor(100000 + Math.random() * 900000));

/** Emite un OTP nuevo e invalida los anteriores del mismo email+propósito. */
export function issueOtp(email, purpose = 'verify') {
  consumeAllFor.run(email, purpose);
  const code = process.env.NODE_ENV === 'production' ? sixDigits() : '000000';
  const expiresAt = new Date(Date.now() + TTL_MIN * 60_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  insOtp.run(email, code, purpose, expiresAt);
  return { code, ttlMin: TTL_MIN };
}

/** true si el código es válido; lo consume. */
export function verifyOtp(email, code, purpose = 'verify') {
  const row = findOtp.get(email, purpose);
  if (!row) return false;
  if (String(code).trim() !== row.code) return false;
  consumeOtp.run(row.id);
  return true;
}
