/* ============================================================================
   Vista Kanban.

   El arrastre usa la API nativa de HTML5, sin librerías. La tarjeta cae en el
   lugar donde se suelta —una línea marca el hueco—, tanto en otra columna
   como dentro de la misma.

   Mover una tarjeta actualiza el estado local antes de que el servidor
   responda: el usuario ve el cambio al instante. Si la petición falla se
   revierte y se avisa, en vez de dejar la interfaz mostrando algo que no pasó.
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

/* El mismo orden que usa el servidor. Si dos tareas comparten posición
   —datos de antes del reordenamiento—, desempatan igual de los dos lados, y
   el lugar que calcula el panel es el mismo que aplica el servidor. */
function porPosicion(a: Tarea, b: Tarea): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

export function Kanban({ orgId, boardId, rol, onVolver, onCambio }: Props) {
  const [nombreTablero, setNombreTablero] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [columnas, setColumnas] = useState<Columna[]>([]);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [arrastrando, setArrastrando] = useState<string | null>(null);
  /* Dónde caería la tarjeta si se soltara ahora: la columna y el lugar dentro
     de ella, contado sin la tarjeta que se arrastra. */
  const [destino, setDestino] = useState<{ columna: string; lugar: number } | null>(null);

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

  /* dragover salta decenas de veces por segundo: si el destino no cambió se
     devuelve el mismo objeto, y React no vuelve a dibujar. */
  function marcarDestino(columna: string, lugar: number) {
    setDestino((d) => (d?.columna === columna && d.lugar === lugar ? d : { columna, lugar }));
  }

  async function soltarEn(columnaDestino: string) {
    const pedido = destino?.columna === columnaDestino ? destino.lugar : null;
    setDestino(null);
    const taskId = arrastrando;
    setArrastrando(null);
    if (!taskId) return;

    const tarea = tareas.find((t) => t.id === taskId);
    if (!tarea) return;

    const enDestino = tareas.filter((t) => t.column_id === columnaDestino).sort(porPosicion);
    const resto = enDestino.filter((t) => t.id !== taskId);
    const lugarActual = enDestino.findIndex((t) => t.id === taskId);

    /* Sin un lugar marcado, a otra columna va al final y en la misma se queda
       donde está. Soltarla en su propio lugar no es un movimiento. */
    const lugar = Math.min(pedido ?? (lugarActual === -1 ? resto.length : lugarActual), resto.length);
    if (lugar === lugarActual) return;

    /* La columna de destino queda numerada 0, 1, 2... igual que la deja el
       servidor, así la vista no salta cuando llega la respuesta. */
    const orden = [...resto];
    orden.splice(lugar, 0, tarea);
    const nuevoLugar = new Map(orden.map((t, i) => [t.id, i]));

    const anterior = tareas;
    setTareas((previas) =>
      previas.map((t) => {
        const i = nuevoLugar.get(t.id);
        return i === undefined ? t : { ...t, column_id: columnaDestino, position: i };
      }),
    );

    try {
      await api.actualizarTarea(orgId, boardId, taskId, { column_id: columnaDestino, position: lugar });
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
          const deLaColumna = tareas.filter((t) => t.column_id === columna.id).sort(porPosicion);

          /* Los lugares se cuentan sin la tarjeta que se arrastra: es la lista
             en la que va a caer. Soltarla en su propio lugar no la mueve, así
             que ahí no se marca nada. */
          const resto = deLaColumna.filter((t) => t.id !== arrastrando);
          const lugarPropio = deLaColumna.findIndex((t) => t.id === arrastrando);
          const marca =
            destino?.columna === columna.id && destino.lugar !== lugarPropio ? destino.lugar : null;

          return (
            <div
              key={columna.id}
              className={`columna${destino?.columna === columna.id ? " recibiendo" : ""}`}
              onDragOver={(e) => {
                if (!puedeEditar || !arrastrando) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                /* Sobre una tarjeta, el lugar lo calcula la tarjeta. En el
                   espacio libre de la columna, va al final. */
                if (!(e.target as HTMLElement).closest(".tarjeta")) {
                  marcarDestino(columna.id, resto.length);
                }
              }}
              onDragLeave={(e) => {
                /* dragleave también salta al pasar de la columna a una de sus
                   tarjetas: solo cuenta si el puntero salió de la columna. */
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setDestino((d) => (d?.columna === columna.id ? null : d));
                }
              }}
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

                {deLaColumna.map((tarea) => {
                  const lugar = resto.indexOf(tarea);
                  const clases = ["tarjeta", `p-${tarea.priority}`];
                  if (tarea.id === arrastrando) clases.push("arrastrando");
                  if (lugar !== -1 && marca === lugar) clases.push("destino-antes");
                  if (lugar !== -1 && lugar === resto.length - 1 && marca === resto.length) {
                    clases.push("destino-despues");
                  }

                  return (
                    <article
                      key={tarea.id}
                      className={clases.join(" ")}
                      draggable={puedeEditar}
                      onDragStart={(e) => {
                        /* Firefox no empieza el arrastre si no se carga algún dato. */
                        e.dataTransfer.setData("text/plain", tarea.id);
                        e.dataTransfer.effectAllowed = "move";
                        setArrastrando(tarea.id);
                      }}
                      onDragOver={(e) => {
                        if (!puedeEditar || !arrastrando) return;
                        if (lugar === -1) {
                          // Es la que se arrastra: soltarla encima la deja donde está.
                          marcarDestino(columna.id, lugarPropio);
                          return;
                        }
                        /* En la mitad de arriba cae antes de esta tarjeta; en la
                           de abajo, después. */
                        const caja = e.currentTarget.getBoundingClientRect();
                        marcarDestino(columna.id, e.clientY < caja.top + caja.height / 2 ? lugar : lugar + 1);
                      }}
                      onDragEnd={() => {
                        setArrastrando(null);
                        setDestino(null);
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
                  );
                })}
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
