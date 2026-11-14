# Primer incremento de Fase 1: gastos simples

Fecha: 2026-11-08. Autorización: solicitud explícita del usuario para continuar Fase 1
con datos ficticios. Este incremento no completa toda la fase.

## Resultado y reglas

Implementado: objetos monetarios exactos, alta de categorías explícitas, registro de
un gasto simple ya efectuado, consulta por intención y totales de consumo por mes y
categoría. Un gasto tiene ID estable, importe positivo, moneda COP, categoría, fecha
civil y actor creador; su ámbito de sujeto/instancia se conserva en el libro. Una
categoría tiene ID estable, nombre y actor. No se ofrecen actualización o borrado.
Los nombres no son claves de identidad: categorías homónimas con intenciones
distintas pueden coexistir; renombrado y subcategorías no forman parte del incremento.

Ejemplo sintético: «Gasté $45.000 COP en gasolina» se representa como intención
estructurada con `amount: "45000.00"`, `currency: "COP"`, categoría explícita y
`occurredOn: "2026-11-08"`. No se interpreta lenguaje natural. COP usa dos unidades
decimales: `4500000n` centavos. `bigint` evita aritmética monetaria binaria; JSON usa
texto decimal para unidades menores. No hay redondeo: se rechaza precisión extra,
incluidos ceros adicionales. Las demás monedas y operaciones de redondeo siguen pendientes.

La fecha civil explícita determina el mes; no se consulta el reloj ni la zona del
host. El informe es de consumo. No se implementaron caja, obligaciones, ingresos,
préstamos, presupuestos, deudas, salarios, reembolsos ni integraciones.

## Idempotencia y frontera

Cada mutación exige clave de intención externa y estable. La clave es única por
instancia y sujeto, compartida entre tipos de operación. Una huella SHA-256 cubre
tipo/versionado interno y campos canónicos: nombre normalizado para categoría;
importe en centavos, moneda, categoría y fecha para gasto. `45000` y `45000.00`
son equivalentes; otra fecha, categoría o importe produce conflicto con la misma
clave. Otro actor autorizado puede recuperar el resultado original sin cambiar
su actor creador. Otra clave produce otro hecho, incluso con contenido idéntico.

El puerto exige almacenar huella, hecho y respuesta en una transacción. El adaptador
actual **simula** esa propiedad mediante una sola inserción síncrona en un `Map`,
sin I/O ni esperas y validando la categoría antes del commit. Los errores no consumen
la intención. Una respuesta incierta se recupera con `findIntent`, sin regenerar clave.
Un nuevo adaptador o reinicio pierde todo: no hay recuperación durable, transacciones
de DB ni evidencia de exclusión entre procesos.

Actor, sujeto e instancia se reciben fuera del payload financiero. El servicio toma
un snapshot, revalida la política por acción y rechaza campos extra como `subjectRef`
o `confirmed`. Las fixtures vinculan contextos permitidos explícitamente; la prueba
de aislamiento usa ámbitos sintéticos, sin introducir un producto multiusuario.
La autenticación real y la procedencia confiable del contexto siguen pendientes.
El servicio y el adaptador son APIs internas de proceso, no una frontera pública.

## Responsables y archivos

| Responsable | Archivos / entrega |
|---|---|
| Coordinador | `src/domain/errors.ts`, `money.ts`, `expenses.ts`; `src/application/expense-service.ts`, `expense-store.ts`; `src/infrastructure/in-memory-expense-store.ts`; `src/app/expense-example.ts` |
| Coordinador | `package.json` (solo script de ejemplo), `README.md`, `docs/ROADMAP.md`, `docs/adr/001-persistence.md`, este informe |
| test_engineer | `tests/money.test.ts`, `tests/expenses.test.ts`, `tests/fixtures/expense-context.ts` |
| finance_domain | Revisión de reglas y referencia, entrega al coordinador sin editar archivos |
| security_reviewer | Revisión de código y comprobación sintética efímera, sin editar archivos |

No se modificaron reglas de producto, referencia histórica, configuración de agentes,
lockfile, dependencias o infraestructura. No se crearon commits, PR ni despliegues.
No se accedió a Jarvis, credenciales, datos reales o proveedores externos.

## Evidencia ejecutada

- `node --test tests/money.test.ts tests/expenses.test.ts`: 22/22 aprobadas por
  test_engineer; `npm.cmd run typecheck`: salida 0.
- Coordinador: `npm.cmd run check`, salida 0: formato, lint sin warnings, typecheck,
  **26/26 pruebas aprobadas** (22 nuevas + 4 previas) y compilación.
- Coordinador: `npm.cmd run example:expense`, salida 0: reintento conserva identidad,
  recuperación por intención y total mensual `4500000` centavos COP.
- Revisor: script efímero Node por stdin, salida 0, para replay/conflicto, exactitud,
  inmutabilidad, fallo sin consumir clave, payload con sujeto extra, aislamiento y
  revocación. Sin escrituras de archivos; no constituye prueba de producción.

Los tests cubren fracciones exactas y valores sobre `Number.MAX_SAFE_INTEGER`,
precisión/formato inválidos, gasto cero/negativo, fechas imposibles y bisiestas,
meses contiguos, filtro y totales vacíos, reintentos y conflictos, respuesta perdida
simulada, 20 reintentos agendados dentro de un proceso, fallos sin mutación, identidad
editable rechazada, permisos/revocación, aislamiento y objetos inmutables.

## Decisiones y riesgos pendientes

- **ADR-001 sigue pendiente:** no se ha elegido SQLite, PostgreSQL o Supabase. La
  nota del ADR describe el simulador y no aprueba una DB. Faltan unicidad transaccional
  durable, fallos/concurrencia entre procesos y respaldo/restauración con fixtures.
- **ADR-002 sigue pendiente:** no existe contrato cotejado ni integración con Jarvis.
- Pendientes posteriores: correcciones por compensación auditables, edición histórica
  de categorías, otras monedas y redondeos, calendario de cierres y proyección de caja.
- Implementada la aplicación de una política inyectada; **simulados** su origen y
  el contexto de identidad. Autenticación y autorizaciones operativas no verificadas.
- Revisor de seguridad sin hallazgos bloqueantes del alcance local. Su rol declara
  sandbox `read-only`; el runtime visible no permite certificar su aplicación efectiva.
  Todas sus operaciones fueron de lectura o ejecución en memoria.
- CI remoto, Linux y seguridad operativa no verificados en este incremento.

Trazabilidad: PRODUCT_RULES §1–2, §11 y reglas transversales; referencia histórica §2
y §11; ROADMAP Fase 1; arquitectura de lectura/mutación. La revisión de dominio no
identificó contradicciones que requirieran cambiar reglas o solicitar otra decisión.

Siguiente incremento recomendado: resolver y aprobar ADR-001 con comparación de
transacciones, unicidad, aislamiento, respaldo y costo; después implementar el mismo
flujo de gastos con almacenamiento aislado y pruebas de reinicio/rollback/concurrencia,
todavía con fixtures sintéticas. No ampliar a otros módulos financieros en ese paso.
