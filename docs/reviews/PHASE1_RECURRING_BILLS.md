# Fase 1I — Gastos fijos y facturas recurrentes

Fecha: 2026-11-16. Incremento implementado y verificado localmente, exclusivamente
con fixtures sintéticas. **La Fase 1 completa sigue abierta.** No se modificó
Sir Jarvis ni infraestructura; sin bancos, Telegram, IA, servicios externos,
despliegue, tareas programadas, nuevas dependencias, commits o PR.

## Decisiones y alcance

Se consultaron `AGENTS.md`, reglas de producto, arquitectura, roadmap, referencia
funcional original §5 y los módulos existentes. Se conserva ADR-001 y el driver
local `node:sqlite`; las migraciones 001–007 permanecen intactas.

La referencia original prevé generación automática. La solicitud actual autoriza
solo generación **explícita e idempotente**; su automatización se aplaza. Antes de
integrar consumo se presentó al usuario la alternativa de reconocerlo por fecha
de pago, por mes facturado al pagar o al confirmar la factura. **El usuario aprobó
consumo y presupuesto por fecha civil del pago confirmado.** El mes facturado
permanece independiente; no se reconoce consumo por obligaciones pendientes.

Implementado:

- Conceptos estables con descripción, categoría y COP. Importe fijo habitual y
  vencimiento opcionales; el importe fijo sirve como estimación, no como factura
  automáticamente confirmada. No se infieren fechas de vencimiento ausentes.
- Una obligación independiente por concepto/mes/instancia/sujeto, con fecha civil
  explícita de generación. Varias mensualidades pendientes pueden coexistir.
- Importes desconocidos (`null`), estimados o confirmados. Totales separados de
  pendientes/vencidos confirmados, estimados y cantidad de desconocidos.
- Para variables, estimación desde el último pago efectivamente confirmado y
  elegible a la fecha de generación; mayor fecha de pago, desempate por orden
  durable de registro. Conserva el ID del pago fuente y nunca se actualiza por
  pagos posteriores ni se toma de una obligación pendiente.
- Ajustes append-only con motivo, actor, instante UTC y referencia a revisión
  anterior. Control de versión antes de ajustar o pagar; no hay sobrescritura.
- Pago completo de un importe confirmado, con obligación exacta, revisión
  esperada, fecha civil, importe y referencia. Rechazo de parciales, diferencias
  no confirmadas, revisión obsoleta, pago ambiguo y segundo pago con otra intención.
- Un gasto vinculado por pago, con la misma identidad. La salida de caja de
  facturas y el consumo/presupuesto son proyecciones de ese único hecho.
- Consultas por fecha explícita y contexto autorizado; historial original,
  revisiones y pago. No se emiten recordatorios por vencimiento.

## Contrato local

`RecurringBillService(store, policy, clock)` expone:

| Método | Entrada principal / efecto |
|---|---|
| `createConcept(context, key, input)` | Descripción, categoría; `fixedAmount?`, `dueDay?` y `dueMonthOffset?` |
| `generateObligation(context, key, input)` | Concepto, mes y `generatedOn`; importe/estado explícitos opcionales y `dueOn?` |
| `adjustObligation(context, key, input)` | Obligación, `expectedRevisionId`, importe/estado y motivo |
| `confirmPayment(context, key, input)` | Obligación, revisión vigente, importe completo, `paidOn` y referencia |
| `getObligation(context, id, {asOf})` | Original, revisiones, importe actual y estado/pago a fecha civil |
| `listObligations(context, {asOf, conceptId?})` | Lista determinista y totales confirmados/estimados/desconocidos |
| `monthlyCashOutflow(context, {month})` | Caja específica de facturas; no flujo global ni suma adicional al consumo |
| `findIntent(context, key)` | Resultado original del dominio de facturas |

Importes COP como cadenas decimales canónicas, cálculos `bigint`. La versión
inicial es `obligation.id`; un ajuste devuelve el nuevo `currentRevisionId`.
Para pagar un estimado/desconocido debe confirmarse su importe con un ajuste.
Una diferencia entre importe efectivo y confirmado exige primero otro ajuste.

Vencimiento habitual: día 1–31 y desplazamiento explícito 0 (mes facturado) o 1
(mes siguiente), siempre juntos; los días inexistentes se ajustan al fin de mes.
`dueOn: null` anula esa inferencia para una obligación. Vencimiento inclusivo;
sin fecha no se clasifica como vencida. No se marca pagada por calendario.

El contexto proviene de una frontera confiable externa al payload. Permisos:
`bill:write`, `bill:pay`, `bill:read`. Se revalidan en reintentos y consultas.
Las referencias textuales no equivalen a IDs bancarios únicos; el consumidor debe
conservar su clave de intención. Cambiar el payload bajo la misma clave es conflicto.

## Caso sintético ejecutado

| Paso | Resultado verificado |
|---|---|
| Octubre: importe confirmado $95.000, pago el 2026-10-10 | Un gasto/pago, mismo ID |
| Noviembre: $98.000 confirmados, pendiente | No crea consumo ni caja |
| Generar diciembre el 2026-12-01 | $95.000 estimados; fuente: pago de octubre |
| Ajustar noviembre a importe real ficticio $99.000 | Conserva obligación original de $98.000 y revisión con motivo |
| Pagar noviembre el 2026-12-03 | Una salida de $99.000 y consumo de diciembre por ese importe |
| Consultar diciembre | Sigue pendiente, estimado en $95.000 desde octubre |
| Reintentar generación/pago | Mismos IDs, sin duplicar registros ni alertas |

Los $99.000 son una fixture explícita para demostrar el ajuste real posterior;
no son un dato inferido del usuario. El caso prueba además que el consumo de
noviembre sigue en cero y que no se suma la obligación estimada de diciembre.

## Persistencia y consistencia

Migración **008 aditiva**: `bill_concepts`, `bill_obligations`, `bill_adjustments`,
`bill_payments`, `bill_intents`. FK recíprocas vinculan registros/intenciones por
ámbito; restricciones únicas protegen periodo, cadena de revisión y pago único.
Triggers bloquean edición/borrado, colisiones con los namespaces anteriores,
revisiones no vigentes y ajustes después de pagar.

El pago enlaza un único `Expense` de `facts`, con `expenseId = payment.id`.
`bill_payments` guarda metadatos, no un importe contable redundante. Se preservan
formato y verificadores del gasto. Su registro técnico en `intents` tiene una
clave interna aleatoria enlazada desde el pago: permite reutilizar el FK de
alertas presupuestarias sin reconstruir tablas anteriores. La intención externa
permanece estable y su replay devuelve el pago original; no se crea otra clave
interna tras una respuesta incierta de un commit exitoso.

`BEGIN IMMEDIATE` cubre revisión del saldo/importe, pago, vínculo, gasto, ambas
intenciones y alertas. Las consultas usan snapshot. Los verificadores reconstruyen
comandos en secuencia durable y cotejan estado, estimación fuente, revisiones y
correspondencia exacta del gasto: ID, importe, categoría, fecha, actor, huella y
resultado. Las copias restauradas pasan el mismo verificador.

Una anulación/reemplazo ordinario de un gasto vinculado se rechaza en aplicación
y SQL: dejaría obligación y caja inconsistentes. Correcciones conjuntas de factura,
pago y gasto aún no implementadas; los gastos ordinarios previos mantienen su flujo.

## Verificaciones realmente ejecutadas

Windows/PowerShell, Node 24.19.0. El coordinador ejecutó:

| Comando | Resultado |
|---|---|
| `node --test tests/recurring-bills.test.ts` | 30/30 aprobadas durante integración |
| `node --test tests/recurring-bill-migration.test.ts` | Caso inicial de migración aprobado; luego ampliado a 8 casos en suite completa |
| `npm.cmd run format` | Salida 0 |
| `npm.cmd run check` | Salida 0: formato, lint sin warnings, typecheck, **246/246 pruebas** y build |
| `git diff --check` | Salida 0 |

**208 pruebas previas + 38 nuevas**: 30 de dominio/integración y 8 de migración/
integridad. Sin omitidas. Cobertura nueva:

- Estimaciones por fecha de pago y desempate de registro, periodos independientes,
  ausencia de importes/fechas, vencimiento inclusivo y febrero bisiesto, ajuste
  auditable, pago completo, revisión obsoleta e importes superiores a signed 64 bits.
- Presupuesto del mes pagado, umbrales 80/100 y salto directo al 100, replay sin
  alertas duplicadas y bloqueo de correcciones desacopladas.
- Permisos revocados, actor/payload no confiables, aislamiento de sujeto/instancia,
  claves reutilizadas o incompatibles entre dominios, lectura/cierre de almacén.
- Seis puntos de rollback: concepto, obligación, ajuste, pago, gasto y alerta;
  pérdida de respuesta después del commit, reapertura y restauración separada.
- Cinco carreras entre procesos reales: replay del pago, payload incompatible,
  dos claves para pagar una obligación, pago frente a ajuste y generación duplicada.
- Migración v7→v8 con rollback de esquema y conservación de filas/intenciones
  previas de gastos, correcciones, presupuesto, alertas/ACK/cursor, deuda corregida
  y salario con asignaciones. Las pruebas de migraciones 1–6 siguen aprobadas.
- Constraints SQL, corrupción sintética de estimación/resultado/revisión/gasto,
  pago huérfano, rechazo en lectura y reapertura, bloqueo y límites de tamaño.

Logs locales ignorados: `.cache/recurring-bills-format.log`,
`.cache/recurring-bills-check.log` y `.cache/recurring-bills-targeted.log`.
Bases sintéticas en `.cache/recurring-bill-tests/` y
`.cache/recurring-bill-migration-tests/`; conservadas sin limpieza automática.
No se ejecutó CI remoto, pruebas de fallo físico de energía ni auditoría general.

## Archivos y coordinación

| Propietario de escritura | Archivos |
|---|---|
| `finance_domain` | `src/domain/recurring-bills.ts`, `src/application/recurring-bill-store.ts`, `src/application/recurring-bill-service.ts` |
| `test_engineer` | `tests/recurring-bills.test.ts`, `tests/fixtures/bill-worker.ts` |
| Coordinador | `src/infrastructure/migrations/008-recurring-bills.ts`, `src/infrastructure/sqlite-recurring-bills.ts`, integración en `src/infrastructure/sqlite-expense-store.ts`, acciones/resultados en `src/application/expense-store.ts`, `tests/recurring-bill-migration.test.ts` |
| Coordinador, solo expectativas de versión vigente | `tests/expense-corrections.test.ts`, `tests/monthly-budget-migration.test.ts`, `tests/event-delivery-migration.test.ts`, `tests/financed-debt-migration.test.ts`, `tests/debt-payment-correction-migration.test.ts`, `tests/salary-migration.test.ts` |
| Coordinador, documentación | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, este informe |

Dominio entregó implementación y verificaciones propias de formato/lint/smoke.
El especialista de pruebas dejó los archivos; el coordinador ejecutó y consolidó
su cobertura, sin atribuirle una ejecución no confirmada. El revisor de seguridad
entregó recomendaciones iniciales y una revisión final del delta, solo lectura,
sin fallos bloqueantes confirmados ni ejecución de pruebas propia. Su configuración
declara sandbox de solo lectura; este informe no certifica de forma independiente
su aplicación por el runtime. Sin escrituras simultáneas sobre rutas compartidas.

## Limitaciones y orquestación futura

- Conceptos inmutables, sin edición/cancelación; no pagos parciales, importes cero,
  anulaciones de obligación ni correcciones de pagos vinculados en este incremento.
- `generatedOn` es una fecha financiera informada, no el reloj del servidor. Un
  pago anterior a ella se rechaza. La consulta `asOf` usa hechos actualmente
  conocidos y fecha civil, no el estado conocido en un instante de auditoría.
  Las revisiones de importe son las vigentes; no se ocultan retroactivamente por
  `recordedAt`. Las estimaciones iniciales no cambian por pagos registrados después.
- Vencidos son subconjunto de pendientes. Caja de facturas es una vista específica,
  no un flujo global; tampoco se suma otra vez a consumo. Dinero desconocido no
  se convierte en cero ni se agrega a totales exactos confirmados.
- 4096 dígitos por importe, 32768 bytes por comando/resultado, 10000 intenciones
  de facturas por ámbito y 64 MiB por archivo. Reconstrucción síncrona completa,
  potencial coste cuadrático, sin paginación; rendimiento al límite no medido.
  Errores explícitos, sin borrar o reparar silenciosamente registros corruptos.
- Autenticación operativa, permisos de archivos/copias y uso real siguen pendientes.
  Las huellas no detectan una reescritura coherente por quien controla todo el archivo.

**Futura orquestación Jarvis, no implementada:** tras aprobar contrato y vincular
identidad/permisos, el orquestador determinará el mes civil y la fecha de generación
con calendario/zona explícitos. Enumerará los conceptos autorizados y enviará una
intención estable por instancia/sujeto/concepto/mes; los reintentos conservarán
payload y clave. Ante respuesta incierta consultará el estado de la intención;
la unicidad concepto/mes impide otra obligación si cambia accidentalmente la clave.
Un fallo de un concepto no convierte en pagados los demás. No se requiere una
transacción mensual masiva: cada obligación tiene su commit y recuperación.

Antes de automatizar faltan definir activación/desactivación y revisión de conceptos,
calendario de ejecución, recuperación de meses omitidos, política de reintentos y
permisos del orquestador. Una factura recibida requerirá confirmación explícita de
importe y periodo; un pago ambiguo deberá aclararse antes de `confirmPayment`.
Generar obligaciones no autoriza mensajes de vencimiento ni ejecuta pagos bancarios.

Siguiente incremento recomendado: correcciones auditables conjuntas de factura,
pago y gasto, definiendo su efecto en caja, consumo, alertas ya emitidas y
estimaciones posteriores. La Fase 1 completa no se declara terminada.
