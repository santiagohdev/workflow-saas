/* ============================================================================
   Verificación de la firma de los webhooks de Stripe.

   Implementa el algoritmo documentado por Stripe sobre node:crypto, sin la
   dependencia del SDK. Eso permite probar el webhook localmente sin cuenta ni
   claves reales, y deja el mecanismo a la vista en vez de escondido.

   El encabezado stripe-signature viene así:

       t=1700000000,v1=5257a8...,v1=otra...

   La firma es HMAC-SHA256 de `${t}.${cuerpoCrudo}` con el secreto del
   webhook. Tres detalles que hacen que esto sea seguro y no decorativo:

   - Se firma el cuerpo CRUDO, byte a byte. Si el cuerpo se parsea a JSON y se
     vuelve a serializar antes de verificar, el más mínimo cambio de formato
     rompe la firma. Por eso la ruta del webhook usa express.raw().
   - La comparación es de tiempo constante.
   - Se rechazan los eventos viejos. Sin ventana de tolerancia, alguien que
     capture un evento legítimo puede reenviarlo indefinidamente.
   ========================================================================== */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ResultadoFirma {
  valido: boolean;
  motivo?: string;
}

const TOLERANCIA_SEGUNDOS = 300;

export function verificarFirmaStripe(
  cuerpoCrudo: Buffer,
  cabeceraFirma: string | undefined,
  secreto: string,
  toleranciaSegundos = TOLERANCIA_SEGUNDOS,
): ResultadoFirma {
  if (!cabeceraFirma) return { valido: false, motivo: "Falta el encabezado stripe-signature." };

  let marca = "";
  const firmas: string[] = [];

  for (const parte of cabeceraFirma.split(",")) {
    const separador = parte.indexOf("=");
    if (separador === -1) continue;
    const clave = parte.slice(0, separador).trim();
    const valor = parte.slice(separador + 1).trim();
    if (clave === "t") marca = valor;
    else if (clave === "v1") firmas.push(valor);
  }

  if (!marca || firmas.length === 0) {
    return { valido: false, motivo: "El encabezado de firma está mal formado." };
  }

  const momento = Number.parseInt(marca, 10);
  if (!Number.isFinite(momento)) {
    return { valido: false, motivo: "La marca de tiempo no es un número." };
  }

  const desfase = Math.abs(Math.floor(Date.now() / 1000) - momento);
  if (desfase > toleranciaSegundos) {
    return { valido: false, motivo: `El evento tiene ${desfase}s de antigüedad; se rechaza.` };
  }

  const esperada = createHmac("sha256", secreto)
    .update(`${marca}.${cuerpoCrudo.toString("utf8")}`)
    .digest("hex");

  const bufferEsperado = Buffer.from(esperada, "utf8");

  for (const firma of firmas) {
    const recibida = Buffer.from(firma, "utf8");
    if (recibida.length !== bufferEsperado.length) continue;
    if (timingSafeEqual(recibida, bufferEsperado)) return { valido: true };
  }

  return { valido: false, motivo: "La firma no coincide." };
}

/** Genera un encabezado válido. Se usa en los tests y en el script de prueba local. */
export function firmarParaPrueba(cuerpo: string, secreto: string, momento?: number): string {
  const t = momento ?? Math.floor(Date.now() / 1000);
  const firma = createHmac("sha256", secreto).update(`${t}.${cuerpo}`).digest("hex");
  return `t=${t},v1=${firma}`;
}
