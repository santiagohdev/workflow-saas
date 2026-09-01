/* ============================================================================
   checkPlanLimits — tope de recursos según el plan.

   Cuenta en la base cuánto tiene la organización ahora mismo y bloquea la
   creación si el plan gratuito ya llegó al límite.

   El conteo se hace contra la base y no contra un contador guardado en la
   fila de la organización. Un contador desincronizado —porque alguien borró
   un tablero por fuera, o porque una operación falló a mitad— deja el sistema
   permitiendo de más o bloqueando de menos, y ese tipo de error es difícil de
   ver hasta que un cliente se queja.

   Un plan premium con la suscripción inactiva se trata como gratuito: es el
   caso de la tarjeta que dejó de funcionar. Se degrada, no se corta el
   acceso, así que el cliente sigue viendo sus datos pero no puede crear más.
   ========================================================================== */

import type { NextFunction, Response } from "express";
import { consultarUno } from "../db/base.ts";
import { config } from "../config.ts";
import { ErrorHttp, type RequestAuth } from "../tipos.ts";

export type Recurso = "boards" | "members";

/* COUNT() en PostgreSQL es bigint, y el driver lo entrega como texto para no
   perder precisión al pasar por el rango seguro de number. Sin el Number()
   explícito, `usado >= limite` compara una cadena y los límites del plan
   dejan de aplicarse como corresponde. */
interface Conteo {
  n: string;
}

export async function contarTableros(orgId: string): Promise<number> {
  const fila = await consultarUno<Conteo>(
    "SELECT COUNT(*) AS n FROM boards WHERE organization_id = ?",
    orgId,
  );
  return Number(fila?.n ?? 0);
}

export async function contarMiembros(orgId: string): Promise<number> {
  const fila = await consultarUno<Conteo>(
    "SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?",
    orgId,
  );
  return Number(fila?.n ?? 0);
}

/** Un plan premium solo cuenta como tal si la suscripción está activa. */
export function planEfectivo(plan: string, estado: string): "free" | "premium" {
  return plan === "premium" && estado === "active" ? "premium" : "free";
}

export function limiteDe(recurso: Recurso): number {
  return recurso === "boards" ? config.limiteTablerosGratis : config.limiteMiembrosGratis;
}

export function usoDe(recurso: Recurso, orgId: string): Promise<number> {
  return recurso === "boards" ? contarTableros(orgId) : contarMiembros(orgId);
}

export function checkPlanLimits(recurso: Recurso) {
  return async function verificarLimite(
    req: RequestAuth,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const org = req.organizacion;
    if (!org) {
      next(new ErrorHttp(500, "checkPlanLimits necesita ejecutarse después de requireRole."));
      return;
    }

    if (planEfectivo(org.plan, org.subscription_status) === "premium") {
      next();
      return;
    }

    const limite = limiteDe(recurso);

    /* Un fallo de la base acá no puede colarse como middleware que no llama a
       next: la petición quedaría colgada hasta el timeout del cliente. */
    let usado: number;
    try {
      usado = await usoDe(recurso, org.id);
    } catch (error) {
      next(error);
      return;
    }

    if (usado >= limite) {
      const queEs = recurso === "boards" ? "tableros" : "miembros";
      next(
        new ErrorHttp(
          403,
          `El plan gratuito permite hasta ${limite} ${queEs} y ya tenés ${usado}. ` +
            "Pasá a premium para crear más.",
          "limite_de_plan",
        ),
      );
      return;
    }

    next();
  };
}
