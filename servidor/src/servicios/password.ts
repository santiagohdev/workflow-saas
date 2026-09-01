/* ============================================================================
   Hash de contraseñas con scrypt.

   scrypt viene en node:crypto, así que no hace falta una dependencia nativa
   que compile en cada instalación. Es una función deliberadamente lenta y con
   uso intensivo de memoria: eso es lo que la hace resistente a ataques por
   fuerza bruta con hardware dedicado.

   Cada contraseña lleva su propia sal. Sin sal por usuario, dos personas con
   la misma contraseña producen el mismo hash, y eso le regala información a
   quien consiga leer la tabla.

   La comparación usa timingSafeEqual: comparar con === deja escapar
   información por el tiempo que tarda en fallar.
   ========================================================================== */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const LARGO_SAL = 16;
const LARGO_CLAVE = 64;

export async function hashear(contrasena: string): Promise<string> {
  if (contrasena.length < 8) {
    throw new Error("La contraseña debe tener al menos 8 caracteres.");
  }
  const sal = randomBytes(LARGO_SAL);
  const derivada = await scryptAsync(contrasena, sal, LARGO_CLAVE);
  return `scrypt$${sal.toString("hex")}$${derivada.toString("hex")}`;
}

export async function verificar(contrasena: string, guardado: string): Promise<boolean> {
  const partes = guardado.split("$");
  if (partes.length !== 3 || partes[0] !== "scrypt") return false;

  const salHex = partes[1];
  const claveHex = partes[2];
  if (!salHex || !claveHex) return false;

  let sal: Buffer;
  let esperada: Buffer;
  try {
    sal = Buffer.from(salHex, "hex");
    esperada = Buffer.from(claveHex, "hex");
  } catch {
    return false;
  }
  if (esperada.length !== LARGO_CLAVE) return false;

  const derivada = await scryptAsync(contrasena, sal, LARGO_CLAVE);
  return timingSafeEqual(derivada, esperada);
}
