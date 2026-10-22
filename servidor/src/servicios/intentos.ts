/* ============================================================================
   Límite de intentos fallidos de inicio de sesión.

   Sin un tope, la contraseña de cualquier cuenta se puede adivinar probando
   sin parar: scrypt hace lento cada intento, pero no limita cuántos se hacen.
   Después de varios fallos seguidos, la combinación queda bloqueada hasta que
   vence la ventana.

   La clave combina email e IP. Solo por email, cualquiera podría dejar sin
   acceso a otra persona fallando a propósito con su cuenta; con la IP, el
   bloqueo le cae a quien falla.

   Vive en memoria: con una sola instancia alcanza y no suma dependencias. Si
   el servicio pasa a correr en varias, cada una cuenta por su lado y hace
   falta un almacén compartido.
   ========================================================================== */

export const MAX_FALLOS = 5;
export const VENTANA_MS = 15 * 60 * 1000;

interface Registro {
  fallos: number;
  desde: number;
}

const registros = new Map<string, Registro>();

/** Segundos que faltan para poder volver a intentar; 0 si no está bloqueado. */
export function segundosDeBloqueo(clave: string, ahora = Date.now()): number {
  const registro = registros.get(clave);
  if (!registro) return 0;

  if (ahora - registro.desde >= VENTANA_MS) {
    registros.delete(clave);
    return 0;
  }

  return registro.fallos >= MAX_FALLOS
    ? Math.ceil((registro.desde + VENTANA_MS - ahora) / 1000)
    : 0;
}

export function registrarFallo(clave: string, ahora = Date.now()): void {
  const registro = registros.get(clave);
  if (!registro || ahora - registro.desde >= VENTANA_MS) {
    registros.set(clave, { fallos: 1, desde: ahora });
    return;
  }
  registro.fallos++;
}

/** Un ingreso correcto borra los fallos anteriores. */
export function limpiarFallos(clave: string): void {
  registros.delete(clave);
}

/* Los registros vencidos se borran solos: sin esto, el mapa crece con cada
   email que alguien pruebe. unref() para que este reloj no mantenga vivo el
   proceso cuando el servidor se cierra. */
setInterval(() => {
  const ahora = Date.now();
  for (const [clave, registro] of registros) {
    if (ahora - registro.desde >= VENTANA_MS) registros.delete(clave);
  }
}, 60_000).unref();
