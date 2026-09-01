/* ============================================================================
   Vista Kanban.

   El arrastre usa la API nativa de HTML5, sin librerías. Mover una tarjeta
   actualiza el estado local antes de que el servidor responda: el usuario ve
   el cambio al instante. Si la petición falla se revierte y se avisa, en vez
   de dejar la interfaz mostrando algo que no pasó.
   ========================================================================== */

import { useCallback, useEffect, useState } from "react";
import { api, ErrorApi } from "../api";
import { JERARQUIA, type Columna, type Prioridad, type Rol, type Tarea } from "../tipos";

interface Props {
  orgId: string;
  boardId: string;
  rol: Rol;
  onVolver: () => void;
  onCambio: () => void;
}

const PRIORIDADES: ReadonlyArray<{ valor: Prioridad; texto: string }> = [
  { valor: "low", texto: "Baja" },
  { valor: "medium", texto: "Media" },
  { valor: "high", texto: "Alta" },
  { valor: "urgent", texto: "Urgente" },
];

const TEXTO_PRIORIDAD: Readonly<Record<Prioridad, string>> = {
  low: "baja",
  medium: "media",
  high: "alta",
  urgent: "urgente",
};

export function Kanban({ orgId, boardId, rol, onVolver, onCambio }: Props) {
  const [nombreTablero, setNombreTablero] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [columnas, setColumnas] = useState<Columna[]>([]);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [arrastrando, setArrastrando] = useState<string | null>(null);
  const [columnaActiva, setColumnaActiva] = useState<string | null>(null);

  const [nuevaEn, setNuevaEn] = useState<string | null>(null);
  const [textoNueva, setTextoNueva] = useState("");
  const [prioridadNueva, setPrioridadNueva] = useState<Prioridad>("medium");
  const [nombreColumna, setNombreColumna] = useState("");
  const [agregandoColumna, setAgregandoColumna] = useState(false);

  const puedeEditar = JERARQUIA[rol] >= JERARQUIA.member;

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const datos = await api.tablero(orgId, boardId);
      setNombreTablero(datos.tablero.name);
      setDescripcion(datos.tablero.description);
      setColumnas(datos.columnas);
      setTareas(datos.tareas);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo cargar el tablero.");
    } finally {
      setCargando(false);
    }
  }, [orgId, boardId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function soltarEn(columnaDestino: string) {
    setColumnaActiva(null);
    const taskId = arrastrando;
    setArrastrando(null);
    if (!taskId) return;

    const tarea = tareas.find((t) => t.id === taskId);
    if (!tarea || tarea.column_id === columnaDestino) return;

    const anterior = tareas;
    setTareas((previas) =>
      previas.map((t) => (t.id === taskId ? { ...t, column_id: columnaDestino } : t)),
    );

    try {
      await api.actualizarTarea(orgId, boardId, taskId, { column_id: columnaDestino });
    } catch (e) {
      setTareas(anterior);
      setError(e instanceof ErrorApi ? e.message : "No se pudo mover la tarea.");
    }
  }

  async function crearTarea(columnaId: string) {
    const titulo = textoNueva.trim();
    if (!titulo) return;
    try {
      const { tarea } = await api.crearTarea(orgId, boardId, {
        title: titulo,
        column_id: columnaId,
        priority: prioridadNueva,
      });
      setTareas((previas) => [...previas, tarea]);
      setTextoNueva("");
      setPrioridadNueva("medium");
      setNuevaEn(null);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo crear la tarea.");
    }
  }

  async function borrarTarea(taskId: string) {
    const anterior = tareas;
    setTareas((previas) => previas.filter((t) => t.id !== taskId));
    try {
      await api.borrarTarea(orgId, boardId, taskId);
    } catch (e) {
      setTareas(anterior);
      setError(e instanceof ErrorApi ? e.message : "No se pudo borrar la tarea.");
    }
  }

  async function crearColumna() {
    const nombre = nombreColumna.trim();
    if (!nombre) return;
    try {
      const { columna } = await api.crearColumna(orgId, boardId, nombre);
      setColumnas((previas) => [...previas, columna]);
      setNombreColumna("");
      setAgregandoColumna(false);
      onCambio();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo crear la columna.");
    }
  }

  if (cargando) return <div className="vacio">Cargando tablero...</div>;

  return (
    <div>
      <div className="tablero-encabezado">
        <button className="btn btn-chico" onClick={onVolver}>← Tableros</button>
        <div style={{ flex: 1 }}>
          <h2>{nombreTablero}</h2>
          {descripcion && <p>{descripcion}</p>}
        </div>
        {!puedeEditar && <span className="chip">solo lectura</span>}
      </div>

      {error && (
        <div className="aviso aviso-error" style={{ marginBottom: 16 }}>
          {error}{" "}
          <button className="btn btn-chico" onClick={() => setError(null)} style={{ marginLeft: 8 }}>
            cerrar
          </button>
        </div>
      )}

      <div className="kanban">
        {columnas.map((columna) => {
          const deLaColumna = tareas
            .filter((t) => t.column_id === columna.id)
            .sort((a, b) => a.position - b.position);

          return (
            <div
              key={columna.id}
              className={`columna${columnaActiva === columna.id ? " recibiendo" : ""}`}
              onDragOver={(e) => {
                if (!puedeEditar) return;
                e.preventDefault();
                setColumnaActiva(columna.id);
              }}
              onDragLeave={() => setColumnaActiva((c) => (c === columna.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                void soltarEn(columna.id);
              }}
            >
              <div className="columna-titulo">
                {columna.name}
                <span className="cuenta">{deLaColumna.length}</span>
              </div>

              <div className="columna-tareas">
                {deLaColumna.length === 0 && <div className="vacio">Sin tareas</div>}

                {deLaColumna.map((tarea) => (
                  <article
                    key={tarea.id}
                    className={`tarjeta p-${tarea.priority}${arrastrando === tarea.id ? " arrastrando" : ""}`}
                    draggable={puedeEditar}
                    onDragStart={() => setArrastrando(tarea.id)}
                    onDragEnd={() => {
                      setArrastrando(null);
                      setColumnaActiva(null);
                    }}
                  >
                    <div className="tarjeta-titulo">{tarea.title}</div>
                    <div className="tarjeta-pie">
                      <span className="prioridad">{TEXTO_PRIORIDAD[tarea.priority]}</span>
                      {puedeEditar && (
                        <button
                          className="borrar"
                          title="Borrar tarea"
                          aria-label={`Borrar ${tarea.title}`}
                          onClick={() => void borrarTarea(tarea.id)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {puedeEditar && (
                <div className="columna-nueva">
                  {nuevaEn === columna.id ? (
                    <div className="pila">
                      <input
                        className="campo"
                        autoFocus
                        placeholder="Título de la tarea"
                        value={textoNueva}
                        onChange={(e) => setTextoNueva(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void crearTarea(columna.id);
                          if (e.key === "Escape") {
                            setNuevaEn(null);
                            setTextoNueva("");
                          }
                        }}
                      />
                      <div className="fila">
                        <select
                          className="campo"
                          value={prioridadNueva}
                          onChange={(e) => setPrioridadNueva(e.target.value as Prioridad)}
                          style={{ padding: "6px 10px", fontSize: 13 }}
                        >
                          {PRIORIDADES.map((p) => (
                            <option key={p.valor} value={p.valor}>{p.texto}</option>
                          ))}
                        </select>
                        <button className="btn btn-chico btn-primario" onClick={() => void crearTarea(columna.id)}>
                          Agregar
                        </button>
                        <button className="btn btn-chico" onClick={() => { setNuevaEn(null); setTextoNueva(""); }}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn btn-chico"
                      style={{ width: "100%" }}
                      onClick={() => setNuevaEn(columna.id)}
                    >
                      + Nueva tarea
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {puedeEditar && (
          <div className="columna" style={{ flex: "0 0 240px" }}>
            <div className="columna-nueva" style={{ borderTop: "none" }}>
              {agregandoColumna ? (
                <div className="pila">
                  <input
                    className="campo"
                    autoFocus
                    placeholder="Nombre de la columna"
                    value={nombreColumna}
                    onChange={(e) => setNombreColumna(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void crearColumna();
                      if (e.key === "Escape") setAgregandoColumna(false);
                    }}
                  />
                  <div className="fila">
                    <button className="btn btn-chico btn-primario" onClick={() => void crearColumna()}>
                      Crear
                    </button>
                    <button className="btn btn-chico" onClick={() => setAgregandoColumna(false)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-chico"
                  style={{ width: "100%" }}
                  onClick={() => setAgregandoColumna(true)}
                >
                  + Nueva columna
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
