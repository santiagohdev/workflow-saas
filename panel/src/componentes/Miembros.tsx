import { useCallback, useEffect, useState } from "react";
import { api, ErrorApi } from "../api";
import { JERARQUIA, type Miembro, type Rol, type Uso } from "../tipos";

interface Props {
  orgId: string;
  uso: Uso;
  onActualizar: () => void;
}

const ROLES: ReadonlyArray<{ valor: Rol; texto: string; ayuda: string }> = [
  { valor: "viewer", texto: "Viewer", ayuda: "solo lectura" },
  { valor: "member", texto: "Member", ayuda: "crea y mueve tareas" },
  { valor: "admin", texto: "Admin", ayuda: "además crea tableros y suma gente" },
  { valor: "owner", texto: "Owner", ayuda: "además borra tableros y gestiona el plan" },
];

export function Miembros({ orgId, uso, onActualizar }: Props) {
  const [miembros, setMiembros] = useState<Miembro[]>([]);
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<Rol>("member");
  const [error, setError] = useState<string | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);

  const puedeGestionar = JERARQUIA[uso.rol] >= JERARQUIA.admin;

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const datos = await api.miembros(orgId);
      setMiembros(datos.miembros);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudieron cargar los miembros.");
    } finally {
      setCargando(false);
    }
  }, [orgId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function agregar() {
    setError(null);
    setMensaje(null);
    try {
      await api.agregarMiembro(orgId, email.trim(), rol);
      setEmail("");
      setMensaje("Miembro agregado.");
      await cargar();
      onActualizar();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo agregar.");
    }
  }

  async function quitar(userId: string, nombre: string) {
    setError(null);
    setMensaje(null);
    try {
      await api.quitarMiembro(orgId, userId);
      setMensaje(`${nombre} ya no es miembro.`);
      await cargar();
      onActualizar();
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo quitar.");
    }
  }

  return (
    <div className="grilla-dos">
      <div className="panel">
        <h3>Miembros</h3>
        <p className="ayuda">
          {uso.uso.members.usado}
          {uso.uso.members.limite !== null ? ` de ${uso.uso.members.limite}` : " (sin límite)"} en{" "}
          {uso.organizacion.name}
        </p>

        {cargando ? (
          <div className="vacio">Cargando...</div>
        ) : (
          <table className="tabla">
            <thead>
              <tr>
                <th>Persona</th>
                <th>Rol</th>
                {puedeGestionar && <th />}
              </tr>
            </thead>
            <tbody>
              {miembros.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div>{m.name}</div>
                    <div style={{ fontSize: 12, color: "var(--texto-tenue)" }}>{m.email}</div>
                  </td>
                  <td><span className="chip chip-rol">{m.role}</span></td>
                  {puedeGestionar && (
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn btn-chico btn-peligro"
                        onClick={() => void quitar(m.id, m.name)}
                      >
                        Quitar
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {mensaje && <div className="aviso aviso-ok mt-16">{mensaje}</div>}
        {error && <div className="aviso aviso-error mt-16">{error}</div>}
      </div>

      <div className="panel">
        <h3>Agregar miembro</h3>
        <p className="ayuda">
          La persona tiene que tener cuenta. Podés sumar a alguien de las cuentas de prueba, por
          ejemplo <code>dani@delta.test</code>: va a pertenecer a las dos organizaciones con un rol
          distinto en cada una.
        </p>

        {puedeGestionar ? (
          <div className="pila">
            <div>
              <label className="etiqueta" htmlFor="mail-nuevo">Email</label>
              <input
                id="mail-nuevo"
                className="campo"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="persona@empresa.test"
              />
            </div>
            <div>
              <label className="etiqueta" htmlFor="rol-nuevo">Rol</label>
              <select
                id="rol-nuevo"
                className="campo"
                value={rol}
                onChange={(e) => setRol(e.target.value as Rol)}
              >
                {ROLES.filter((r) => JERARQUIA[r.valor] <= JERARQUIA[uso.rol]).map((r) => (
                  <option key={r.valor} value={r.valor}>
                    {r.texto} — {r.ayuda}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btn-primario" onClick={() => void agregar()} disabled={!email.trim()}>
              Agregar
            </button>
          </div>
        ) : (
          <div className="aviso aviso-info">
            Se requiere rol admin o superior para gestionar miembros. Tu rol es {uso.rol}.
          </div>
        )}

        <div className="mt-24">
          <h3 style={{ fontSize: 14 }}>Qué puede hacer cada rol</h3>
          <table className="tabla mt-16">
            <tbody>
              {ROLES.map((r) => (
                <tr key={r.valor}>
                  <td style={{ width: 90 }}><span className="chip chip-rol">{r.texto}</span></td>
                  <td style={{ color: "var(--texto-medio)", fontSize: 13 }}>{r.ayuda}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
