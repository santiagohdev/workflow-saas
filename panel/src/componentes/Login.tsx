import { useState, type FormEvent } from "react";
import { api, ErrorApi } from "../api";
import type { OrganizacionResumen, Usuario } from "../tipos";

interface Props {
  onEntrar: (token: string, usuario: Usuario, organizaciones: OrganizacionResumen[]) => void;
}

const CUENTAS_DEMO = [
  { email: "ana@estudionorte.test", etiqueta: "Ana — owner (plan gratuito)" },
  { email: "bruno@estudionorte.test", etiqueta: "Bruno — member" },
  { email: "cami@estudionorte.test", etiqueta: "Cami — viewer (solo lectura)" },
  { email: "dani@delta.test", etiqueta: "Dani — owner (plan premium)" },
] as const;

export function Login({ onEntrar }: Props) {
  const [modo, setModo] = useState<"entrar" | "registrar">("entrar");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nombre, setNombre] = useState("");
  const [organizacion, setOrganizacion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setCargando(true);
    try {
      const resultado =
        modo === "entrar"
          ? await api.entrar(email, password)
          : await api.registrar({
              email,
              password,
              name: nombre,
              organization_name: organizacion,
            });
      onEntrar(resultado.token, resultado.usuario, resultado.organizaciones);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "Error inesperado.");
    } finally {
      setCargando(false);
    }
  }

  function usarDemo(correo: string) {
    setModo("entrar");
    setEmail(correo);
    setPassword("demo1234");
    setError(null);
  }

  return (
    <div className="login-marco">
      <div className="login-caja">
        <h1>Workflow</h1>
        <p className="sub">
          {modo === "entrar"
            ? "Entrá para ver tus tableros."
            : "Creá tu cuenta y tu primera organización."}
        </p>

        <form onSubmit={enviar} className="login-campos">
          {modo === "registrar" && (
            <>
              <div>
                <label className="etiqueta" htmlFor="nombre">Tu nombre</label>
                <input
                  id="nombre"
                  className="campo"
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  required
                  autoComplete="name"
                />
              </div>
              <div>
                <label className="etiqueta" htmlFor="org">Nombre de la organización</label>
                <input
                  id="org"
                  className="campo"
                  value={organizacion}
                  onChange={(e) => setOrganizacion(e.target.value)}
                  required
                  autoComplete="organization"
                />
              </div>
            </>
          )}

          <div>
            <label className="etiqueta" htmlFor="email">Email</label>
            <input
              id="email"
              className="campo"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label className="etiqueta" htmlFor="password">Contraseña</label>
            <input
              id="password"
              className="campo"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={modo === "entrar" ? "current-password" : "new-password"}
            />
          </div>

          {error && <div className="aviso aviso-error">{error}</div>}

          <button className="btn btn-primario" type="submit" disabled={cargando}>
            {cargando ? "Un momento..." : modo === "entrar" ? "Entrar" : "Crear cuenta"}
          </button>
        </form>

        <div className="mt-16" style={{ textAlign: "center" }}>
          <button
            className="pestana"
            type="button"
            onClick={() => {
              setModo(modo === "entrar" ? "registrar" : "entrar");
              setError(null);
            }}
          >
            {modo === "entrar" ? "No tengo cuenta" : "Ya tengo cuenta"}
          </button>
        </div>

        <div className="demo-cuentas">
          <strong style={{ color: "var(--texto)" }}>Cuentas de prueba</strong>
          <div style={{ display: "grid", gap: 2, marginTop: 8 }}>
            {CUENTAS_DEMO.map((c) => (
              <button key={c.email} type="button" onClick={() => usarDemo(c.email)}>
                {c.etiqueta}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 12 }}>
            Contraseña: <code>demo1234</code>. Estudio Norte y Delta Software son organizaciones
            separadas: con una cuenta no se ve nada de la otra.
          </div>
        </div>
      </div>
    </div>
  );
}
