/* ============================================================================
   Datos de demostración.

   Crea dos organizaciones distintas con usuarios distintos. Dos y no una a
   propósito: es lo que permite comprobar a mano que el aislamiento funciona,
   iniciando sesión con una cuenta e intentando leer los tableros de la otra.

   Ejecutar:  npm run semilla
   ========================================================================== */

import { ahora, cerrar, consultarUno, ejecutar, enTransaccion, migrar, uuid } from "./base.ts";
import { hashear } from "../servicios/password.ts";

const COLUMNAS = ["Por hacer", "En curso", "En revisión", "Hecho"] as const;

interface Persona {
  email: string;
  name: string;
  password: string;
}

async function crearOrganizacion(
  nombreOrg: string,
  slug: string,
  plan: "free" | "premium",
  gente: ReadonlyArray<{ persona: Persona; rol: "owner" | "admin" | "member" | "viewer" }>,
  tableros: ReadonlyArray<{ nombre: string; descripcion: string; tareas: ReadonlyArray<[string, number, "low" | "medium" | "high" | "urgent"]> }>,
): Promise<void> {
  const momento = ahora();
  const orgId = uuid();

  const hashes = new Map<string, string>();
  for (const { persona } of gente) {
    hashes.set(persona.email, await hashear(persona.password));
  }

  await enTransaccion(async () => {
    await ejecutar(
      `INSERT INTO organizations
         (id, name, slug, plan, subscription_status, stripe_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      orgId,
      nombreOrg,
      slug,
      plan,
      plan === "premium" ? "active" : "inactive",
      plan === "premium" ? `cus_demo_${slug}` : null,
      momento,
      momento,
    );

    const idsPorEmail = new Map<string, string>();

    for (const { persona, rol } of gente) {
      let usuarioId: string;
      const existente = await consultarUno<{ id: string }>(
        "SELECT id FROM users WHERE email = ?",
        persona.email,
      );

      if (existente) {
        usuarioId = existente.id;
      } else {
        usuarioId = uuid();
        await ejecutar(
          `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
          usuarioId, persona.email, persona.name, hashes.get(persona.email)!, momento,
        );
      }

      idsPorEmail.set(persona.email, usuarioId);
      await ejecutar(
        `INSERT INTO organization_members (organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)`,
        orgId, usuarioId, rol, momento,
      );
    }

    const dueno = idsPorEmail.get(gente[0]!.persona.email)!;

    /* for...of y no forEach en los tres niveles: el callback de forEach no se
       espera, así que el COMMIT saldría antes de que terminen los INSERT y la
       semilla quedaría a medias sin que nada avise. */
    let indiceTablero = 0;
    for (const tablero of tableros) {
      const boardId = uuid();
      await ejecutar(
        `INSERT INTO boards
           (id, organization_id, name, description, position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        boardId, orgId, tablero.nombre, tablero.descripcion, indiceTablero++, dueno, momento, momento,
      );

      const columnaIds: string[] = [];
      let i = 0;
      for (const nombreColumna of COLUMNAS) {
        const columnaId = uuid();
        columnaIds.push(columnaId);
        await ejecutar(
          `INSERT INTO columns (id, organization_id, board_id, name, position, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          columnaId, orgId, boardId, nombreColumna, i++, momento,
        );
      }

      const porColumna = new Map<number, number>();
      for (const [titulo, columna, prioridad] of tablero.tareas) {
        const destino = columnaIds[Math.min(columna, columnaIds.length - 1)]!;
        const pos = porColumna.get(columna) ?? 0;
        porColumna.set(columna, pos + 1);

        await ejecutar(
          `INSERT INTO tasks
             (id, organization_id, board_id, column_id, title, description, priority,
              position, assignee_id, due_date, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, NULL, ?, ?, ?)`,
          uuid(), orgId, boardId, destino, titulo, prioridad, pos, dueno, dueno, momento, momento,
        );
      }
    }
  });

  console.log(`  ✓ ${nombreOrg}  (plan ${plan})  slug: ${slug}`);
}

async function main(): Promise<void> {
  await migrar();

  const yaHay = await consultarUno<{ n: string }>("SELECT COUNT(*) AS n FROM organizations");
  if (Number(yaHay?.n ?? 0) > 0) {
    console.log(
      "La base ya tiene datos. Vaciá las tablas si querés regenerarla:\n" +
        "  truncate organizations, users cascade;",
    );
    return;
  }

  console.log("Creando datos de demostración...\n");

  await crearOrganizacion(
    "Estudio Norte",
    "estudio-norte",
    "free",
    [
      { persona: { email: "ana@estudionorte.test", name: "Ana Duarte", password: "demo1234" }, rol: "owner" },
      { persona: { email: "bruno@estudionorte.test", name: "Bruno Paz", password: "demo1234" }, rol: "member" },
      { persona: { email: "cami@estudionorte.test", name: "Cami Rey", password: "demo1234" }, rol: "viewer" },
    ],
    [
      {
        nombre: "Rediseño del sitio",
        descripcion: "Migración y puesta a punto del sitio institucional.",
        tareas: [
          ["Auditar velocidad de carga en móvil", 0, "high"],
          ["Definir paleta y tipografías", 0, "medium"],
          ["Maquetar la portada", 1, "high"],
          ["Formulario de contacto", 1, "medium"],
          ["Revisión de accesibilidad", 2, "urgent"],
          ["Configurar dominio y SSL", 3, "low"],
        ],
      },
      {
        nombre: "Campaña de lanzamiento",
        descripcion: "Coordinación de la campaña del próximo trimestre.",
        tareas: [
          ["Escribir el copy de la landing", 0, "medium"],
          ["Producir las piezas gráficas", 1, "high"],
          ["Cargar audiencias", 3, "low"],
        ],
      },
    ],
  );

  await crearOrganizacion(
    "Delta Software",
    "delta-software",
    "premium",
    [
      { persona: { email: "dani@delta.test", name: "Dani Serra", password: "demo1234" }, rol: "owner" },
      { persona: { email: "eli@delta.test", name: "Eli Molina", password: "demo1234" }, rol: "admin" },
    ],
    [
      {
        nombre: "Plataforma interna",
        descripcion: "Backlog del equipo de producto.",
        tareas: [
          ["Modelar permisos por rol", 0, "urgent"],
          ["Endpoint de reportes", 0, "medium"],
          ["Migrar a la nueva base", 1, "high"],
          ["Pruebas de carga", 2, "medium"],
          ["Documentar la API", 3, "low"],
        ],
      },
    ],
  );

  console.log("\nCuentas para entrar (contraseña: demo1234)\n");
  console.log("  Estudio Norte  (plan gratuito, 2 de 3 tableros usados)");
  console.log("    ana@estudionorte.test     owner");
  console.log("    bruno@estudionorte.test   member");
  console.log("    cami@estudionorte.test    viewer   ← no puede crear nada");
  console.log("\n  Delta Software  (plan premium, sin límites)");
  console.log("    dani@delta.test           owner");
  console.log("    eli@delta.test            admin");
  console.log(
    "\nSon organizaciones separadas: entrando con una cuenta no se ve nada de la otra.\n",
  );
}

await main();
await cerrar();
