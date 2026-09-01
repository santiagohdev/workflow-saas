/* ============================================================================
   Webhook de Stripe y simulación de checkout.

   El estado de la suscripción se toma SIEMPRE de lo que informa Stripe por
   webhook, nunca de lo que dice el navegador al volver del checkout. Alguien
   puede cerrar la pestaña justo después de pagar, o llamar a la URL de
   retorno sin haber pagado: en ambos casos el webhook es la única fuente
   confiable.

   El endpoint es idempotente. Stripe reintenta los eventos que no reciben un
   2xx, y también puede entregarlos más de una vez: aplicar el mismo evento
   dos veces tiene que dar el mismo resultado.
   ========================================================================== */

import { Router, type Request, type Response } from "express";
import { ahora, consultarUno, ejecutar, uuid } from "../db/base.ts";
import { config } from "../config.ts";
import { firmarParaPrueba, verificarFirmaStripe } from "../servicios/stripeFirma.ts";
import { autenticar } from "../middleware/autenticar.ts";
import { requireRole } from "../middleware/requireRole.ts";
import { ErrorHttp, type Organization, type RequestAuth } from "../tipos.ts";

export const rutasStripe = Router();

/* Los estados de Stripe que damos por buenos para habilitar premium. */
const ESTADOS_ACTIVOS = new Set(["active", "trialing"]);

interface EventoStripe {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}


/* --------------------------------------------------------------------------
   Aplicación del evento sobre la base.

   Vive en una función aparte porque la usan dos caminos: el webhook real y el
   endpoint de simulación local. Que ambos pasen por acá garantiza que lo que
   se prueba en desarrollo es exactamente lo que va a correr en producción.
   -------------------------------------------------------------------------- */
async function procesarEvento(evento: EventoStripe): Promise<{ ok: boolean; tipo: string }> {
  const tipo = evento.type ?? "";
  const objeto = evento.data?.object ?? {};

  try {
    switch (tipo) {
      case "checkout.session.completed": {
        const metadata = (objeto["metadata"] ?? {}) as Record<string, unknown>;
        const orgId = typeof metadata["organization_id"] === "string" ? metadata["organization_id"] : null;
        const customer = typeof objeto["customer"] === "string" ? objeto["customer"] : null;
        if (orgId) {
          await ejecutar(
            `UPDATE organizations
                SET plan = 'premium', subscription_status = 'active',
                    stripe_customer_id = COALESCE(?, stripe_customer_id), updated_at = ?
              WHERE id = ?`,
            customer, ahora(), orgId,
          );
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const customer = typeof objeto["customer"] === "string" ? objeto["customer"] : null;
        const estado = typeof objeto["status"] === "string" ? objeto["status"] : "";
        if (customer) {
          const activo = ESTADOS_ACTIVOS.has(estado);
          await ejecutar(
            `UPDATE organizations
                SET plan = ?, subscription_status = ?, updated_at = ?
              WHERE stripe_customer_id = ?`,
            activo ? "premium" : "free", activo ? "active" : "inactive", ahora(), customer,
          );
        }
        break;
      }

      case "customer.subscription.deleted": {
        const customer = typeof objeto["customer"] === "string" ? objeto["customer"] : null;
        if (customer) {
          /* Se degrada a gratuito, no se borra nada. Los datos del cliente
             siguen ahí; lo que pierde es la capacidad de crear más. */
          await ejecutar(
            `UPDATE organizations
                SET plan = 'free', subscription_status = 'inactive', updated_at = ?
              WHERE stripe_customer_id = ?`,
            ahora(), customer,
          );
        }
        break;
      }

      default:
        /* Un evento que no manejamos igual se responde con 200: devolver un
           error haría que Stripe lo reintente para siempre. */
        break;
    }
    return { ok: true, tipo };
  } catch (error) {
    console.error("[stripe] error procesando", tipo, error);
    return { ok: false, tipo };
  }
}

/* --------------------------------------------------------------------------
   POST /api/webhooks/stripe

   La ruta recibe el cuerpo como Buffer. El montaje con express.raw() se hace
   en index.ts ANTES de express.json(), porque una vez que el cuerpo se parsea
   ya no se puede recuperar byte a byte y la firma deja de verificar.
   -------------------------------------------------------------------------- */
rutasStripe.post("/stripe", async (req: Request, res: Response) => {
  const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));

  const firma = verificarFirmaStripe(
    crudo,
    req.header("stripe-signature"),
    config.stripeWebhookSecret,
  );

  if (!firma.valido) {
    console.warn("[stripe] firma rechazada:", firma.motivo);
    res.status(400).json({ error: "Firma inválida.", codigo: "firma_invalida" });
    return;
  }

  let evento: EventoStripe;
  try {
    evento = JSON.parse(crudo.toString("utf8")) as EventoStripe;
  } catch {
    res.status(400).json({ error: "El cuerpo no es JSON válido.", codigo: "json_invalido" });
    return;
  }

  const resultado = await procesarEvento(evento);
  if (!resultado.ok) {
    res.status(500).json({ error: "Error procesando el evento." });
    return;
  }

  res.json({ recibido: true, tipo: resultado.tipo });
});

/* --------------------------------------------------------------------------
   POST /api/billing/:orgId/checkout

   Simulación del checkout, para que el flujo completo se pueda probar sin
   cuenta de Stripe. Genera el identificador de cliente y devuelve el evento
   que Stripe enviaría, ya listo para reinyectar por el webhook.

   En producción, acá se crearía una sesión real con el SDK y se devolvería
   su URL. El resto del sistema no cambia: sigue esperando el webhook.
   -------------------------------------------------------------------------- */
rutasStripe.post(
  "/:orgId/checkout",
  autenticar,
  requireRole("owner"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;

      const customer = org.stripe_customer_id ?? `cus_sim_${uuid().replace(/-/g, "").slice(0, 14)}`;

      await ejecutar(
        "UPDATE organizations SET stripe_customer_id = ?, updated_at = ? WHERE id = ?",
        customer,
        ahora(),
        org.id,
      );

      res.json({
        modo: "simulado",
        stripe_customer_id: customer,
        /* Este es el evento que Stripe mandaría al webhook una vez pagado.
           El panel lo reenvía a /api/webhooks/stripe para cerrar el ciclo. */
        evento_sugerido: {
          id: `evt_sim_${uuid().replace(/-/g, "").slice(0, 14)}`,
          type: "customer.subscription.updated",
          data: {
            object: {
              id: `sub_sim_${uuid().replace(/-/g, "").slice(0, 14)}`,
              customer,
              status: "active",
            },
          },
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   POST /api/billing/:orgId/cancel — baja simulada.
   -------------------------------------------------------------------------- */
rutasStripe.post(
  "/:orgId/cancel",
  autenticar,
  requireRole("owner"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = req.organizacion!;
      if (!org.stripe_customer_id) {
        throw new ErrorHttp(400, "La organización no tiene una suscripción activa.", "sin_suscripcion");
      }

      res.json({
        modo: "simulado",
        evento_sugerido: {
          id: `evt_sim_${uuid().replace(/-/g, "").slice(0, 14)}`,
          type: "customer.subscription.deleted",
          data: { object: { customer: org.stripe_customer_id, status: "canceled" } },
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   POST /api/billing/:orgId/simular-webhook

   Solo fuera de producción. Firma el evento con el secreto del servidor y lo
   procesa por el mismo camino que un evento real de Stripe.

   Existe porque el panel no tiene —ni debe tener— el secreto del webhook: es
   una credencial de servidor. Sin este endpoint, recorrer el ciclo completo
   en local exigiría la CLI de Stripe y una cuenta.

   Importante: no es un atajo que salte la verificación. El evento se firma de
   verdad y se verifica de verdad. Lo único que cambia es quién lo origina.
   -------------------------------------------------------------------------- */
rutasStripe.post(
  "/:orgId/simular-webhook",
  autenticar,
  requireRole("owner"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      if (config.esProduccion) {
        throw new ErrorHttp(404, "Ruta no disponible.", "ruta_inexistente");
      }

      const cuerpo = req.body as Record<string, unknown>;
      const evento = cuerpo["evento"];
      if (!evento || typeof evento !== "object") {
        throw new ErrorHttp(400, "Falta el evento a simular.", "campo_faltante");
      }

      const crudo = Buffer.from(JSON.stringify(evento), "utf8");
      const cabecera = firmarParaPrueba(crudo.toString("utf8"), config.stripeWebhookSecret);

      const verificacion = verificarFirmaStripe(crudo, cabecera, config.stripeWebhookSecret);
      if (!verificacion.valido) {
        throw new ErrorHttp(500, `La firma simulada no verifica: ${verificacion.motivo}`);
      }

      const resultado = procesarEvento(JSON.parse(crudo.toString("utf8")) as EventoStripe);
      res.json({ simulado: true, ...resultado });
    } catch (error) {
      next(error);
    }
  },
);

/* --------------------------------------------------------------------------
   GET /api/billing/:orgId — estado de facturación.
   -------------------------------------------------------------------------- */
rutasStripe.get(
  "/:orgId",
  autenticar,
  requireRole("viewer"),
  async (req: RequestAuth, res: Response, next) => {
    try {
      const org = (await consultarUno<Organization>("SELECT * FROM organizations WHERE id = ?", req.organizacion!.id))!;
      res.json({ facturacion: org });
    } catch (error) {
      next(error);
    }
  },
);
