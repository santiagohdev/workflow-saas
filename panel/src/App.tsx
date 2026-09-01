/* ============================================================================
   Raíz de la aplicación.

   Mantiene tres cosas: quién está conectado, en qué organización está parado y
   qué pestaña mira. Todo lo demás lo resuelven los componentes hijos contra
   la API.

   El selector de organización no es decorativo: una misma cuenta puede
   pertenecer a varias empresas con un rol distinto en cada una, y cambiar de
   organización cambia lo que puede hacer. Es el multi-tenant visible.
   ========================================================================== */

import { useCallback, useEffect, useState } from "react";
import { almacen, api, ErrorApi } from "./api";
import type { OrganizacionResumen, Usuario, Uso } from "./tipos";
import { Login } from "./componentes/Login";
import { Tableros } from "./componentes/Tableros";
import { Kanban } from "./componentes/Kanban";
import { Facturacion } from "./componentes/Facturacion";
import { Miembros } from "./componentes/Miembros";

type Pestana = "tableros" | "miembros" | "facturacion";

export function App() {
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [organizaciones, setOrganizaciones] = useState<OrganizacionResumen[]>([]);
  const [orgActiva, setOrgActiva] = useState<string | null>(null);
  const [uso, setUso] = useState<Uso | null>(null);
  const [pestana, setPestana] = useState<Pestana>("tableros");
  const [tableroAbierto, setTableroAbierto] = useState<string | null>(null);
  const [iniciando, setIniciando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Al cargar, si hay un token guardado se valida contra el servidor. Confiar
     en que existe no alcanza: pudo haber vencido o la cuenta pudo borrarse. */
  useEffect(() => {
    async function restaurar() {
      if (!almacen.leerToken()) {
        setIniciando(false);
        return;
      }
      try {
        const sesion = await api.sesion();
        setUsuario(sesion.usuario);
        setOrganizaciones(sesion.organizaciones);
        setOrgActiva(sesion.organizaciones[0]?.id ?? null);
      } catch {
        almacen.borrarToken();
      } finally {
        setIniciando(false);
      }
    }
    void restaurar();
  }, []);

  const refrescarUso = useCallback(async () => {
    if (!orgActiva) {
      setUso(null);
      return;
    }
    try {
      setUso(await api.uso(orgActiva));
      setError(null);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo cargar la organización.");
    }
  }, [orgActiva]);

  useEffect(() => {
    void refrescarUso();
  }, [refrescarUso]);

  function entrar(token: string, u: Usuario, orgs: OrganizacionResumen[]) {
    almacen.guardarToken(token);
    setUsuario(u);
    setOrganizaciones(orgs);
    setOrgActiva(orgs[0]?.id ?? null);
    setPestana("tableros");
    setTableroAbierto(null);
  }

  function salir() {
    almacen.borrarToken();
    setUsuario(null);
    setOrganizaciones([]);
    setOrgActiva(null);
    setUso(null);
    setTableroAbierto(null);
  }

  function cambiarOrganizacion(id: string) {
    setOrgActiva(id);
    setTableroAbierto(null);
    setPestana("tableros");
  }

  if (iniciando) return <div className="vacio" style={{ paddingTop: 80 }}>Cargando...</div>;
  if (!usuario) return <Login onEntrar={entrar} />;

  return (
    <div className="app">
      <header className="barra">
        <span className="marca">Workflow</span>

        {organizaciones.length > 0 && (
          <select
            className="campo"
            style={{ width: "auto", padding: "6px 10px" }}
            value={orgActiva ?? ""}
            onChange={(e) => cambiarOrganizacion(e.target.value)}
            aria-label="Organización activa"
          >
            {organizaciones.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.role}
              </option>
            ))}
          </select>
        )}

        <nav className="pestanas">
          {(["tableros", "miembros", "facturacion"] as const).map((p) => (
            <button
              key={p}
              className={`pestana${pestana === p ? " activa" : ""}`}
              onClick={() => {
                setPestana(p);
                setTableroAbierto(null);
              }}
            >
              {p === "tableros" ? "Tableros" : p === "miembros" ? "Miembros" : "Facturación"}
            </button>
          ))}
        </nav>

        <span className="crece" />

        {uso && (
          <span className={`chip${uso.organizacion.plan_efectivo === "premium" ? " chip-premium" : ""}`}>
            {uso.organizacion.plan_efectivo}
          </span>
        )}
        <span style={{ color: "var(--texto-medio)", fontSize: 14 }}>{usuario.name}</span>
        <button className="btn btn-chico" onClick={salir}>Salir</button>
      </header>

      <main className="cuerpo">
        <div className="contenedor">
          {error && <div className="aviso aviso-error" style={{ marginBottom: 16 }}>{error}</div>}

          {!orgActiva || !uso ? (
            <div className="vacio">Seleccioná una organización.</div>
          ) : pestana === "tableros" ? (
            tableroAbierto ? (
              <Kanban
                orgId={orgActiva}
                boardId={tableroAbierto}
                rol={uso.rol}
                onVolver={() => setTableroAbierto(null)}
                onCambio={() => void refrescarUso()}
              />
            ) : (
              <Tableros
                orgId={orgActiva}
                uso={uso}
                onAbrir={setTableroAbierto}
                onActualizar={() => void refrescarUso()}
              />
            )
          ) : pestana === "miembros" ? (
            <Miembros orgId={orgActiva} uso={uso} onActualizar={() => void refrescarUso()} />
          ) : (
            <Facturacion orgId={orgActiva} uso={uso} onActualizar={() => void refrescarUso()} />
          )}
        </div>
      </main>
    </div>
  );
}
