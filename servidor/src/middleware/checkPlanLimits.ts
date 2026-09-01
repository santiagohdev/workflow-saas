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

interface Conteo {
  n: number;
}

export function contarTableros(orgId: string): number {
  const fila = consultarUno<Conteo>("SELECT COUNT(*) AS n FROM boards WHERE organization_id = ?", orgId);
  return fila?.n ?? 0;
}

export function contarMiembros(orgId: string): number {
  const fila = consultarUno<Conteo>("SELECT COUNT(*) AS n FROM organization_members WHERE organization_id = ?", orgId);
  return fila?.n ?? 0;
}

/** Un plan premium solo cuenta como tal si la suscripción está activa. */
export function planEfectivo(plan: string, estado: string): "free" | "premium" {
  return plan === "premium" && estado === "active" ? "premium" : "free";
}

export function limiteDe(recurso: Recurso): number {
  return recurso === "boards" ? config.limiteTablerosGratis : config.limiteMiembrosGratis;
}

export function usoDe(recurso: Recurso, orgId: string): number {
  return recurso === "boards" ? contarTableros(orgId) : contarMiembros(orgId);
}

export function checkPlanLimits(recurso: Recurso) {
  return function verificarLimite(req: RequestAuth, _res: Response, next: NextFunction): void {
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
    const usado = usoDe(recurso, org.id);

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
