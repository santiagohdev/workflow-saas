# Multi-Tenant Enterprise Workflow and Task Management SaaS

Gestor de tareas estilo Kanban con arquitectura multi-inquilino: varias
organizaciones conviven en el mismo sistema sin verse entre sí, cada persona
puede pertenecer a más de una con un rol distinto en cada una, y los límites de
uso dependen del plan contratado.

Corre en local sin ninguna clave de API: alcanza con una base PostgreSQL, propia
o el plan gratuito de Supabase.

**Stack:** Node.js · TypeScript · Express · React · Vite · PostgreSQL

---

## Arrancar

Hacen falta Node 22.5 o superior y una base PostgreSQL: una local o un proyecto
gratuito de Supabase. Su cadena de conexión va en `DATABASE_URL`, dentro de
`servidor/.env`. Las tablas se crean solas al arrancar.

```bash
# Backend
cd servidor
cp .env.example .env   # completar DATABASE_URL y JWT_SECRET
npm install
npm run semilla     # crea dos organizaciones de ejemplo
npm start           # http://localhost:4000

# Panel (en otra terminal)
cd panel
cp .env.example .env
npm install
npm run dev         # http://localhost:5173
```

### O en un solo puerto (modo producción)

```bash
cd servidor
npm run prod        # compila el panel y lo sirve desde http://localhost:4000
```

Así queda todo en un único origen: sin CORS, sin dos procesos, y con el panel
compilado y minificado. Es la forma en que conviene desplegarlo.

En modo producción el servidor exige el secreto real del webhook de Stripe en
`STRIPE_WEBHOOK_SECRET`, y no arranca con el valor de ejemplo, que está
publicado en este repositorio. Para una demostración sin cobros reales va
`DEMO_SIMULAR_PAGOS=true`: habilita el pago simulado del panel y el servidor usa
un secreto aleatorio en cada arranque.

### Que la demo no se apague

En los planes gratuitos, Render duerme la instancia después de 15 minutos sin
tráfico, y Supabase pausa el proyecto después de una semana sin actividad en la
base. Un proyecto pausado no vuelve solo: hay que restaurarlo desde el panel de
Supabase.

`GET /api/health` consulta la base y responde 503 si no llega. Un monitor
gratuito, como UptimeRobot o cron-job.org, que lo llame cada 5 minutos mantiene
despiertas las dos cosas y avisa por mail si algo se cae.

Si la base no responde al arrancar, el servidor levanta igual: el panel carga,
la API contesta 503 con un mensaje claro y la conexión se reintenta sola hasta
que la base vuelve.

### Cuentas de prueba

Contraseña para todas: `demo1234`

| Cuenta | Organización | Rol | Para ver |
|---|---|---|---|
| `ana@estudionorte.test` | Estudio Norte | owner | Todo, incluido el plan |
| `bruno@estudionorte.test` | Estudio Norte | member | Crea tareas, no tableros |
| `cami@estudionorte.test` | Estudio Norte | viewer | Solo lectura |
| `dani@delta.test` | Delta Software | owner | Organización en plan premium |
| `eli@delta.test` | Delta Software | admin | Gestiona miembros, no el plan |

Estudio Norte y Delta Software están completamente separadas. Entrando con una
cuenta no se ve absolutamente nada de la otra: es la garantía central del
sistema y se puede comprobar a mano.

---

## Las tres decisiones que sostienen el proyecto

### 1. El aislamiento se aplica en cada consulta

Toda tabla de contenido lleva `organization_id`, y toda consulta filtra por él
además del identificador del recurso:

```sql
SELECT * FROM boards WHERE id = ? AND organization_id = ?
```

Puede parecer redundante —el tablero ya sabe a qué organización pertenece— pero
es justamente lo que impide que un identificador filtrado o adivinado sirva
para leer datos de otra empresa. El aislamiento no es una comprobación en la
entrada: es una propiedad de cada consulta.

El middleware `requireRole` responde **404 y no 403** cuando alguien pide una
organización de la que no es miembro. Un 403 confirmaría que esa organización
existe, y eso ya es información que no le corresponde.

### 2. El plan lo define el webhook, nunca el navegador

El estado de la suscripción se toma siempre de lo que informa Stripe por
webhook. Alguien puede cerrar la pestaña justo después de pagar, o llamar a la
URL de retorno sin haber pagado: en ambos casos el webhook es la única fuente
confiable.

La verificación de firma está implementada sobre `node:crypto` siguiendo el
algoritmo documentado por Stripe, sin el SDK. Eso permite probar el ciclo
completo sin cuenta y deja el mecanismo a la vista:

- Se firma el **cuerpo crudo**, byte a byte. Por eso la ruta se monta con
  `express.raw()` **antes** de `express.json()`: si el cuerpo se parsea primero,
  la firma no verifica nunca. Es el error más común al integrar webhooks.
- La comparación usa `timingSafeEqual`.
- Los eventos con más de cinco minutos se rechazan, para que capturar un evento
  legítimo no sirva para reenviarlo indefinidamente.
- En producción no arranca sin el secreto real: el de ejemplo está en este
  repositorio, y con él cualquiera podría firmar un pago falso.

El pago simulado de la demostración pasa por el mismo camino, con una
restricción más: solo acepta el alta o la baja de la suscripción de la propia
organización. El evento lo arma el navegador, y sin ese control el dueño de una
organización podría dar de baja a otra cuyo identificador de cliente conozca.

### 3. Los límites se cuentan contra la base

`checkPlanLimits` consulta cuántos tableros o miembros tiene la organización
ahora mismo, en vez de leer un contador guardado. Un contador desincronizado
—porque alguien borró un tablero, o porque una operación falló a mitad— deja el
sistema permitiendo de más o bloqueando de menos, y ese error es difícil de ver
hasta que un cliente se queja.

Una organización premium con la suscripción inactiva se trata como gratuita: es
el caso de la tarjeta vencida. Se degrada, no se corta el acceso.

---

## Roles

La jerarquía vive como dato, no como cadenas de condicionales:

```ts
const JERARQUIA = { viewer: 1, member: 2, admin: 3, owner: 4 };
```

| Rol | Puede |
|---|---|
| `viewer` | Ver tableros y tareas |
| `member` | Además crear, mover y borrar tareas y columnas |
| `admin` | Además crear tableros y gestionar miembros |
| `owner` | Además borrar tableros y cambiar el plan |

Nadie puede otorgar un rol por encima del propio: un admin que pudiera nombrar
owners se convertiría en owner cuando quisiera. Y no se puede quitar al único
owner, porque una organización sin dueño no la administra nadie.

---

## Base de datos

PostgreSQL. El esquema vive en dos lugares:

- **`servidor/src/db/base.ts`** — tablas e índices. Se aplican solos al
  arrancar: una base vacía queda lista sin pasos manuales, y sobre una que ya
  existe no hacen nada.
- **`sql/001_supabase.sql`** — el mismo esquema más las políticas de RLS y los
  triggers, para aplicar una vez desde el editor SQL de Supabase.

La aplicación no habla con el driver directamente sino con `consultarUno` /
`consultarTodos` / `ejecutar` / `enTransaccion`, que son la única frontera entre
SQL y los tipos del dominio. Las consultas se escriben con `?` y esa capa las
traduce a `$1, $2`; dentro de una transacción, todas usan la misma conexión sin
recibirla como parámetro.

Todos los identificadores son uuid. Uno mal formado se responde con 404 antes de
consultar: si llegara a PostgreSQL, la consulta fallaría por el tipo de dato y
saldría como un 500.

---

## Tests

```bash
cd servidor && npm test
```

21 pruebas sobre las piezas de seguridad. No verifican "que la aplicación
anda": verifican las garantías que, si se rompen, no se notan hasta que ya es
tarde.

Entre ellas, el rechazo de `alg:none` —la vulnerabilidad clásica de JWT, donde
un atacante declara que el token no lleva firma y el verificador le cree—,
tokens con contenido alterado, firmas de webhook sobre cuerpos modificados,
eventos reenviados fuera de la ventana de tolerancia y el bloqueo después de
varios intentos fallidos de login.

---

## Estructura

```
sql/001_supabase.sql          esquema PostgreSQL

servidor/
  src/
    index.ts                  orden del middleware (raw antes que json)
    config.ts                 configuración validada al arrancar
    tipos.ts                  tipos del dominio
    db/base.ts                capa de datos y frontera tipada
    db/semilla.ts             datos de demostración
    middleware/
      autenticar.ts           quién es
      requireRole.ts          pertenencia + jerarquía
      checkPlanLimits.ts      topes por plan
      errores.ts              4xx con detalle, 5xx genérico
    rutas/
      auth.ts                 registro, login, sesión
      organizaciones.ts       uso del plan y miembros
      tableros.ts             CRUD de tableros, columnas y tareas
      stripe.ts               webhook y facturación
    servicios/
      password.ts             scrypt con sal por usuario
      jwt.ts                  HS256 sobre node:crypto
      stripeFirma.ts          verificación HMAC-SHA256
      intentos.ts             límite de intentos de login

panel/
  src/
    App.tsx                   sesión, organización activa, pestañas
    api.ts                    cliente HTTP
    componentes/
      Login.tsx
      Tableros.tsx
      Kanban.tsx              arrastre nativo HTML5
      Miembros.tsx
      Facturacion.tsx
```

---

## Detalles de implementación

**Arrastre sin librerías.** El Kanban usa la API nativa de HTML5. La tarjeta
cae donde se suelta —una línea marca el hueco—, en otra columna o dentro de la
misma, y el servidor renumera la columna en una sola consulta. Mover una
tarjeta actualiza el estado local antes de que el servidor responda, para que
el cambio se vea al instante; si la petición falla se revierte y se avisa, en
vez de dejar la interfaz mostrando algo que no ocurrió.

**Contraseñas con scrypt**, incluido en `node:crypto`, con sal por usuario y
comparación de tiempo constante. Sin sal, dos personas con la misma contraseña
producirían el mismo hash.

**Límite de intentos de login.** Después de 5 fallos seguidos, esa combinación
de email e IP queda bloqueada 15 minutos y recibe un 429 con `Retry-After`. Con
la IP en la clave, nadie puede dejar sin acceso a otra persona fallando a
propósito con su email.

**Un tablero nuevo nace con sus columnas** en la misma transacción. Un tablero
vacío no le sirve a nadie.

**Registrarse crea usuario, organización y membresía** en una sola transacción.
Si cualquiera de las tres falla no queda ninguna: un usuario sin organización no
puede hacer nada, y una organización sin dueño no la administra nadie.
