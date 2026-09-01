/* ============================================================================
   Panel de facturación.

   El botón de checkout no cambia el plan por su cuenta: pide la sesión al
   backend y después reenvía el evento firmado al webhook, que es el único
   camino por el que el plan puede cambiar. Es a propósito, y refleja cómo
   funciona en producción: el navegador nunca es la fuente de verdad sobre un
   pago, porque el usuario puede cerrar la pestaña o llamar a la URL de
   retorno sin haber pagado nada.
   ========================================================================== */

import { useState } from "react";
import { api, ErrorApi } from "../api";
import type { EventoStripeSugerido, Uso } from "../tipos";

interface Props {
  orgId: string;
  uso: Uso;
  onActualizar: () => void;
}

interface Medidor {
  etiqueta: string;
  usado: number;
  limite: number | null;
}

function BarraUso({ etiqueta, usado, limite }: Medidor) {
  const ilimitado = limite === null;
  const porcentaje = ilimitado ? 100 : Math.min(100, (usado / Math.max(1, limite)) * 100);
  const lleno = !ilimitado && usado >= limite;
  const excedido = !ilimitado && usado > limite;

  return (
    <div className="medidor">
      <div className="medidor-fila">
        <span>{etiqueta}</span>
        <span className="valor">{ilimitado ? `${usado} · sin límite` : `${usado} de ${limite}`}</span>
      </div>
      <div className="medidor-pista">
        <div
          className={`medidor-barra${excedido ? " excedido" : lleno ? " lleno" : ""}`}
          style={{ width: `${ilimitado ? 100 : porcentaje}%` }}
        />
      </div>
    </div>
  );
}

export function Facturacion({ orgId, uso, onActualizar }: Props) {
  const [trabajando, setTrabajando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ultimoEvento, setUltimoEvento] = useState<EventoStripeSugerido | null>(null);

  const esPremium = uso.organizacion.plan_efectivo === "premium";
  const esDueno = uso.rol === "owner";

  async function suscribir() {
    setTrabajando(true);
    setError(null);
    setMensaje(null);
    try {
      const sesion = await api.checkout(orgId);
      setUltimoEvento(sesion.evento_sugerido);
      await api.simularWebhook(orgId, sesion.evento_sugerido);
      setMensaje("Suscripción activada. El plan lo cambió el webhook, no el navegador.");
      onActualizar();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setTrabajando(false);
    }
  }

  async function cancelar() {
    setTrabajando(true);
    setError(null);
    setMensaje(null);
    try {
      const baja = await api.cancelar(orgId);
      setUltimoEvento(baja.evento_sugerido);
      await api.simularWebhook(orgId, baja.evento_sugerido);
      setMensaje("Suscripción cancelada. La organización volvió al plan gratuito.");
      onActualizar();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : e instanceof Error ? e.message : "Error inesperado.");
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div className="grilla-dos">
      <div className="panel">
        <h3>Plan actual</h3>
        <p className="ayuda">
          {uso.organizacion.name} · <span className={`chip${esPremium ? " chip-premium" : ""}`}>
            {esPremium ? "premium" : "gratuito"}
          </span>
        </p>

        <BarraUso
          etiqueta="Tableros"
          usado={uso.uso.boards.usado}
          limite={uso.uso.boards.limite}
        />
        <BarraUso
          etiqueta="Miembros"
          usado={uso.uso.members.usado}
          limite={uso.uso.members.limite}
        />

        {!esPremium && (
          <div className="aviso aviso-info" style={{ marginTop: 4 }}>
            El plan gratuito permite hasta {uso.limites_plan_gratis.boards} tableros y{" "}
            {uso.limites_plan_gratis.members} miembros.
          </div>
        )}

        <div className="fila mt-24">
          {esPremium ? (
            <button className="btn btn-peligro" onClick={() => void cancelar()} disabled={trabajando || !esDueno}>
              {trabajando ? "Procesando..." : "Cancelar suscripción"}
            </button>
          ) : (
            <button className="btn btn-primario" onClick={() => void suscribir()} disabled={trabajando || !esDueno}>
              {trabajando ? "Procesando..." : "Pasar a premium"}
            </button>
          )}
        </div>

        {!esDueno && (
          <p className="ayuda mt-16" style={{ marginBottom: 0 }}>
            Solo el dueño de la organización puede cambiar el plan. Tu rol es {uso.rol}.
          </p>
        )}

        {mensaje && <div className="aviso aviso-ok mt-16">{mensaje}</div>}
        {error && <div className="aviso aviso-error mt-16">{error}</div>}
      </div>

      <div className="panel">
        <h3>Cómo funciona el cobro</h3>
        <p className="ayuda">
          El estado de la suscripción lo define siempre el webhook de Stripe, nunca la respuesta
          que ve el navegador. Si alguien cierra la pestaña justo después de pagar, o llama a la
          URL de retorno sin haber pagado, el sistema no se confunde.
        </p>

        <ol style={{ margin: "0 0 16px", paddingLeft: 20, color: "var(--texto-medio)", fontSize: 14 }}>
          <li>El panel pide una sesión de checkout al backend.</li>
          <li>Stripe cobra y envía un evento firmado al webhook.</li>
          <li>El backend verifica la firma con HMAC-SHA256 sobre el cuerpo crudo.</li>
          <li>Recién ahí cambia el plan en la base de datos.</li>
        </ol>

        <p className="ayuda">
          <strong style={{ color: "var(--texto)" }}>En esta demostración no hay cobro real.</strong>{" "}
          El paso 2 lo cubre el backend: genera el mismo evento que enviaría Stripe y lo firma con
          el secreto del webhook. Los pasos 3 y 4 son los de producción, sin atajos — si la firma
          no verifica, el plan no cambia.
        </p>

        {ultimoEvento && (
          <>
            <p className="ayuda" style={{ marginBottom: 8 }}>Último evento procesado:</p>
            <pre className="codigo">{JSON.stringify(ultimoEvento, null, 2)}</pre>
          </>
        )}
      </div>
    </div>
  );
}
