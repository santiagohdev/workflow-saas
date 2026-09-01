/* ============================================================================
   Firma y verificación de JWT (HS256).

   Implementado sobre node:crypto en vez de traer una dependencia. Un JWT son
   tres partes en base64url separadas por puntos —cabecera, contenido y firma—
   y la firma es un HMAC-SHA256 de las dos primeras. Escribirlo a mano deja el
   mecanismo a la vista y quita una dependencia de la superficie de ataque.

   Dos detalles que hacen la diferencia entre una implementación correcta y
   una que se rompe en producción:

   - El algoritmo se valida contra lo que esperamos, no contra lo que declara
     el token. Aceptar el "alg" que viene en la cabecera es la vulnerabilidad
     clásica de JWT: un atacante manda alg:none y entra sin firma.
   - La comparación de firmas usa timingSafeEqual.
   ========================================================================== */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { PayloadToken } from "../tipos.ts";
import { config } from "../config.ts";

const CABECERA = { alg: "HS256", typ: "JWT" } as const;

function aBase64Url(dato: Buffer | string): string {
  return Buffer.from(dato)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function desdeBase64Url(texto: string): Buffer {
  const relleno = texto.length % 4 === 0 ? "" : "=".repeat(4 - (texto.length % 4));
  return Buffer.from(texto.replace(/-/g, "+").replace(/_/g, "/") + relleno, "base64");
}

function firmar(contenido: string): string {
  return aBase64Url(createHmac("sha256", config.jwtSecret).update(contenido).digest());
}

export interface DatosToken {
  sub: string;
  email: string;
  name: string;
}

export function emitir(datos: DatosToken): string {
  const emitido = Math.floor(Date.now() / 1000);
  const payload: PayloadToken = {
    ...datos,
    iat: emitido,
    exp: emitido + config.jwtExpiraHoras * 3600,
  };
  const cuerpo = `${aBase64Url(JSON.stringify(CABECERA))}.${aBase64Url(JSON.stringify(payload))}`;
  return `${cuerpo}.${firmar(cuerpo)}`;
}

/** Devuelve el contenido si el token es válido; null en cualquier otro caso. */
export function verificar(token: string): PayloadToken | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;

  const [cabeceraB64, payloadB64, firmaB64] = partes;
  if (!cabeceraB64 || !payloadB64 || !firmaB64) return null;

  // El algoritmo se valida contra el nuestro, nunca se toma el del token.
  let cabecera: { alg?: unknown };
  try {
    cabecera = JSON.parse(desdeBase64Url(cabeceraB64).toString("utf8")) as { alg?: unknown };
  } catch {
    return null;
  }
  if (cabecera.alg !== CABECERA.alg) return null;

  const esperada = Buffer.from(firmar(`${cabeceraB64}.${payloadB64}`));
  const recibida = Buffer.from(firmaB64);
  if (esperada.length !== recibida.length) return null;
  if (!timingSafeEqual(esperada, recibida)) return null;

  let payload: PayloadToken;
  try {
    payload = JSON.parse(desdeBase64Url(payloadB64).toString("utf8")) as PayloadToken;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;

  return payload;
}
