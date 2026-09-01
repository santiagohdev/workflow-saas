import { useCallback, useEffect, useState } from "react";
import { api, ErrorApi } from "../api";
import { JERARQUIA, type Board, type Uso } from "../tipos";

interface Props {
  orgId: string;
  uso: Uso;
  onAbrir: (boardId: string) => void;
  onActualizar: () => void;
}

export function Tableros({ orgId, uso, onAbrir, onActualizar }: Props) {
  const [tableros, setTableros] = useState<Board[]>([]);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [error, setError] = useState<string | null>(null);

  const puedeCrear = JERARQUIA[uso.rol] >= JERARQUIA.admin;
  const puedeBorrar = uso.rol === "owner";
  const enElLimite =
    uso.uso.boards.limite !== null && uso.uso.boards.usado >= uso.uso.boards.limite;

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const datos = await api.tableros(orgId);
      setTableros(datos.tableros);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudieron cargar los tableros.");
    } finally {
      setCargando(false);
    }
  }, [orgId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function crear() {
    setError(null);
    try {
      await api.crearTablero(orgId, nombre.trim(), descripcion.trim());
      setNombre("");
      setDescripcion("");
      setCreando(false);
      await cargar();
      onActualizar();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo crear el tablero.");
    }
  }

  async function borrar(boardId: string, nombreTablero: string) {
    if (!confirm(`¿Borrar "${nombreTablero}" con todas sus tareas?`)) return;
    setError(null);
    try {
      await api.borrarTablero(orgId, boardId);
      await cargar();
      onActualizar();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo borrar.");
    }
  }

  if (cargando) return <div className="vacio">Cargando tableros...</div>;

  return (
    <div>
      <div className="fila" style={{ marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 20, letterSpacing: "-0.02em" }}>Tableros</h2>
          <p style={{ margin: 0, color: "var(--texto-medio)", fontSize: 14 }}>
            {uso.uso.boards.usado}
            {uso.uso.boards.limite !== null ? ` de ${uso.uso.boards.limite}` : ""} en{" "}
            {uso.organizacion.name}
          </p>
        </div>
        {puedeCrear && !creando && (
          <button className="btn btn-primario" onClick={() => setCreando(true)} disabled={enElLimite}>
            + Nuevo tablero
          </button>
        )}
      </div>

      {enElLimite && puedeCrear && (
        <div className="aviso aviso-info" style={{ marginBottom: 16 }}>
          Llegaste al límite de {uso.uso.boards.limite} tableros del plan gratuito. Pasá a premium
          desde la pestaña de facturación para crear más.
        </div>
      )}

      {error && (
        <div className="aviso aviso-error" style={{ marginBottom: 16 }}>{error}</div>
      )}

      {creando && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="pila">
            <div>
              <label className="etiqueta" htmlFor="nombre-tablero">Nombre</label>
              <input
                id="nombre-tablero"
                className="campo"
                autoFocus
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && nombre.trim() && void crear()}
              />
            </div>
            <div>
              <label className="etiqueta" htmlFor="desc-tablero">Descripción (opcional)</label>
              <input
                id="desc-tablero"
                className="campo"
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
              />
            </div>
            <div className="fila">
              <button className="btn btn-primario" onClick={() => void crear()} disabled={!nombre.trim()}>
                Crear
              </button>
              <button className="btn" onClick={() => { setCreando(false); setNombre(""); }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {tableros.length === 0 ? (
        <div className="vacio">Todavía no hay tableros.</div>
      ) : (
        <div className="grilla-tableros">
          {tableros.map((t) => (
            <div key={t.id} style={{ position: "relative" }}>
              <button className="tarjeta-tablero" onClick={() => onAbrir(t.id)}>
                <h3>{t.name}</h3>
                <p>{t.description || "Sin descripción"}</p>
              </button>
              {puedeBorrar && (
                <button
                  className="btn btn-chico btn-peligro"
                  style={{ position: "absolute", top: 12, right: 12 }}
                  onClick={() => void borrar(t.id, t.name)}
                  aria-label={`Borrar ${t.name}`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
