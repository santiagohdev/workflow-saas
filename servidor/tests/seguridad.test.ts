/* ============================================================================
   Pruebas de las piezas de seguridad.

   No prueban "que la aplicación anda": prueban las garantías que, si se
   rompen, no se notan hasta que ya es tarde. Un token falsificado que pasa,
   una firma de webhook que se acepta sin ser válida, o una contraseña que
   verifica contra un hash que no le corresponde no producen errores visibles
   — producen accesos indebidos silenciosos.
   ========================================================================== */

/* Las variables de entorno de estas pruebas se pasan en el script `test` del
   package.json, no acá. Asignarlas en el cuerpo del archivo no funciona: ESM
   eleva los import por encima de cualquier sentencia, así que config.ts ya se
   evaluó —y ya validó— antes de que estas líneas corran. Antes parecía andar
   solo porque dotenv levantaba el .env local. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { hashear, verificar as verificarPassword } from "../src/servicios/password.ts";
import { emitir, verificar as verificarToken } from "../src/servicios/jwt.ts";
import { verificarFirmaStripe, firmarParaPrueba } from "../src/servicios/stripeFirma.ts";

/* ==========================================================================
   Contraseñas
   ========================================================================== */

test("una contraseña correcta verifica", async () => {
  const hash = await hashear("unaClaveSegura123");
  assert.equal(await verificarPassword("unaClaveSegura123", hash), true);
});

test("una contraseña incorrecta no verifica", async () => {
  const hash = await hashear("unaClaveSegura123");
  assert.equal(await verificarPassword("unaClaveSegura124", hash), false);
});

test("dos usuarios con la misma contraseña producen hashes distintos", async () => {
  const a = await hashear("misma-clave-123");
  const b = await hashear("misma-clave-123");
  assert.notEqual(a, b, "sin sal por usuario, el hash sería idéntico");
  assert.equal(await verificarPassword("misma-clave-123", a), true);
  assert.equal(await verificarPassword("misma-clave-123", b), true);
});

test("un hash con formato inválido no rompe, devuelve false", async () => {
  for (const basura of ["", "abc", "scrypt$solo-una-parte", "otro$aa$bb", "$$"]) {
    assert.equal(await verificarPassword("cualquiera", basura), false, `falló con: ${basura}`);
  }
});

test("no se aceptan contraseñas de menos de 8 caracteres", async () => {
  await assert.rejects(() => hashear("corta12"));
});

/* ==========================================================================
   JWT
   ========================================================================== */

test("un token emitido se verifica y conserva los datos", () => {
  const token = emitir({ sub: "u-1", email: "a@b.test", name: "Ana" });
  const payload = verificarToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, "u-1");
  assert.equal(payload.email, "a@b.test");
});

test("un token con la firma alterada se rechaza", () => {
  const token = emitir({ sub: "u-1", email: "a@b.test", name: "Ana" });
  const partes = token.split(".");
  const alterado = `${partes[0]}.${partes[1]}.${"x".repeat(partes[2]!.length)}`;
  assert.equal(verificarToken(alterado), null);
});

test("un token con el contenido alterado se rechaza", () => {
  const token = emitir({ sub: "u-1", email: "a@b.test", name: "Ana" });
  const partes = token.split(".");
  const otroPayload = Buffer.from(JSON.stringify({ sub: "u-999", exp: 9e9 }))
    .toString("base64url");
  assert.equal(verificarToken(`${partes[0]}.${otroPayload}.${partes[2]}`), null);
});

test("se rechaza alg:none — la vulnerabilidad clásica de JWT", () => {
  const cabecera = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "atacante", email: "x@y.z", name: "X", iat: 0, exp: 9e9 }),
  ).toString("base64url");
  assert.equal(verificarToken(`${cabecera}.${payload}.`), null);
  assert.equal(verificarToken(`${cabecera}.${payload}.loquesea`), null);
});

test("un token vencido se rechaza", () => {
  const cabecera = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "u-1", email: "a@b.test", name: "Ana", iat: 1000, exp: 2000 }),
  ).toString("base64url");
  const cuerpo = `${cabecera}.${payload}`;
  const firma = createHmac("sha256", process.env["JWT_SECRET"]!)
    .update(cuerpo)
    .digest("base64url");
  assert.equal(verificarToken(`${cuerpo}.${firma}`), null);
});

test("basura no rompe la verificación", () => {
  for (const basura of ["", "a", "a.b", "a.b.c.d", "...", "eyJhbGciOiJIUzI1NiJ9"]) {
    assert.equal(verificarToken(basura), null, `falló con: ${basura}`);
  }
});

/* ==========================================================================
   Firma de webhooks de Stripe
   ========================================================================== */

const SECRETO = "whsec_de_prueba";

test("una firma generada correctamente se acepta", () => {
  const cuerpo = JSON.stringify({ type: "customer.subscription.updated" });
  const cabecera = firmarParaPrueba(cuerpo, SECRETO);
  const r = verificarFirmaStripe(Buffer.from(cuerpo), cabecera, SECRETO);
  assert.equal(r.valido, true, r.motivo);
});

test("un cuerpo modificado invalida la firma", () => {
  const cuerpo = JSON.stringify({ type: "customer.subscription.updated" });
  const cabecera = firmarParaPrueba(cuerpo, SECRETO);
  const alterado = JSON.stringify({ type: "customer.subscription.deleted" });
  assert.equal(verificarFirmaStripe(Buffer.from(alterado), cabecera, SECRETO).valido, false);
});

test("un secreto distinto invalida la firma", () => {
  const cuerpo = JSON.stringify({ a: 1 });
  const cabecera = firmarParaPrueba(cuerpo, SECRETO);
  assert.equal(verificarFirmaStripe(Buffer.from(cuerpo), cabecera, "otro_secreto").valido, false);
});

test("un evento viejo se rechaza aunque la firma sea válida", () => {
  const cuerpo = JSON.stringify({ a: 1 });
  const viejo = Math.floor(Date.now() / 1000) - 3600;
  const cabecera = firmarParaPrueba(cuerpo, SECRETO, viejo);
  const r = verificarFirmaStripe(Buffer.from(cuerpo), cabecera, SECRETO);
  assert.equal(r.valido, false);
  assert.match(r.motivo ?? "", /antigüedad/);
});

test("encabezados mal formados se rechazan sin romper", () => {
  const cuerpo = Buffer.from("{}");
  for (const cabecera of [undefined, "", "basura", "t=", "v1=abc", "t=abc,v1=def"]) {
    assert.equal(verificarFirmaStripe(cuerpo, cabecera, SECRETO).valido, false);
  }
});
