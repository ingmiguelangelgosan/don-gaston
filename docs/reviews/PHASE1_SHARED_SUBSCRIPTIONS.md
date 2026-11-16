# Fase 1K — Suscripciones personales y compartidas

Fecha: 2026-11-16. Estado: incremento implementado y verificado localmente,
exclusivamente con fixtures sintéticas. **La Fase 1 completa permanece abierta.**
SQLite v10 aditiva; sin nuevos paquetes, servicios, despliegues ni integración Jarvis.

## Funcionalidad y decisiones

Se implementan `SubscriptionService`, su puerto y dominio determinista, con
persistencia en el adaptador SQLite existente:

- Alta con identidad estable, nombre, categoría, importe COP, mes inicial,
  modalidad personal/compartida, inclusión explícita del titular y externos.
- Generación mensual explícita de obligaciones pendientes; una por suscripción/mes.
  Crear el pendiente no implica cargo, consumo ni deuda de participantes.
- Versiones inmutables de participantes con vigencia posterior a todas las
  versiones y obligaciones existentes; snapshots de cada mensualidad.
- Pago total confirmado, reparto igualitario exacto, componente personal y
  cuentas por cobrar externas, dentro de la misma transacción.
- Reembolsos parciales/completos FIFO global de suscripciones por persona.
  Orden: mes, ID de suscripción y de obligación para empates. Cada asignación
  conserva el pago/obligación de origen y el reembolso recibido.
- Consultas de pendientes/pagados a fecha civil, cartera por persona/mes,
  caja mensual específica y recuperación de resultados por intención.

Trazabilidad funcional: §8 de `PRODUCT_RULES.md` y de la referencia original.
La referencia histórica permanece intacta. **Decisión explícita del usuario en
este incremento:** aceptar solo repartos exactos en centavos; el resto produce
`review_required / NON_DIVISIBLE_AMOUNT`, sin registrar pago efectivo ni distribuir
residuos. Se conserva la intención de revisión para responder igual a reintentos.

La confirmación debe coincidir con el importe mensual pendiente. Ajustes de importe
requieren otro incremento, sin inventar un cargo distinto. Fechas financieras son
civiles y explícitas; el reloj únicamente aporta auditoría UTC. Se sigue la regla
aprobada en facturas: consumo en el mes del pago, no en el mes facturado.

Un reembolso superior al saldo elegible se conserva en revisión sin efecto parcial.
Uno anterior a otro reembolso confirmado de esa persona requiere revisión temporal.
Un pago total retroactivo se valida reproduciendo las asignaciones anteriores;
si las alteraría, queda en revisión sin modificar caja ni cartera. Las revisiones
no se reactivan automáticamente cuando cambia el estado.

## Caja, consumo e identidades

| Caso sintético | Salida de caja | Consumo personal | Cuentas por cobrar |
|---|---:|---:|---|
| Personal 30.000 COP | 30.000 | 30.000 | Ninguna |
| Compartida 45.000, titular + Juan + Ana | 45.000 | 15.000 | Juan 15.000; Ana 15.000 |
| Juan reembolsa 10.000 y luego 5.000 | Sin nueva salida | Sin nuevo consumo | Juan saldado; Ana conserva 15.000 |

Cada pago es el único hecho de caja. Su componente personal positivo se proyecta
como un `Expense` con **el mismo ID**, cuyo importe puede ser menor que el total.
Invariante exacta: `total = propio + suma(participaciones externas)`.
No se suman pago y componente como movimientos distintos. Titular excluido implica
consumo cero y ausencia de gasto ordinario de valor cero. El presupuesto utiliza
solo el componente personal; los reembolsos no lo reducen ni generan ingreso ganado.

Se reutilizan categorías, cálculo de consumo, presupuestos y eventos existentes.
Se reutiliza `loan_counterparties` para identidad estable de personas, con alta
mediante `PersonalLoanService.createCounterparty`. No se leen posiciones de préstamo
desde el servicio de suscripciones ni se compensan ambos saldos. El adaptador valida
el ledger de préstamos al rehidratar identidades; no añade movimientos de capital.

Las obligaciones de suscripciones permanecen en su propio libro. Las facturas
normales conservan su semántica: el pago total sigue siendo consumo personal.
No hay flujo de caja global; `monthlyCashFlow` abarca únicamente suscripciones.

## Persistencia y controles

Migración `010-subscriptions.ts`, sin modificar 001–009, añade:

- `subscription_records`: suscripciones, versiones de participantes, obligaciones,
  decisiones de pago y de reembolso con columnas tipadas y vínculos.
- `subscription_intents`: secuencia, huella, comando canónico y respuesta original.
- `subscription_participants`: composición externa por versión/obligación.
- `subscription_shares`: participación externa vinculada al pago confirmado.
- `subscription_allocations`: aplicación de reembolsos a participaciones.

FK por instancia/sujeto, relaciones recíprocas hecho/intención, restricciones únicas
por mes/vigencia/pago efectivo, triggers append-only y namespace bidireccional de
intenciones con gastos, deudas, salarios, facturas y préstamos. El componente de
consumo tiene una intención técnica interna para reutilizar las FK de alertas;
la clave externa estable es la del pago y nunca se reemplaza ante incertidumbre.

`BEGIN IMMEDIATE` abarca lectura, decisión y todas las escrituras, incluidas alertas.
Reembolsos y asignaciones también comparten commit. Consultas usan snapshot; apertura,
lecturas y restauración reproducen decisiones y verifican huellas/resultados,
filas, participantes, participaciones, asignaciones y gasto vinculado.

Se bloquea `expense:correct` sobre el componente vinculado, en aplicación y SQL,
incluida la guardia inversa contra enlazar un gasto ya corregido. Las correcciones
conjuntas de suscripción/pago/cartera no se implementan aún.

Permisos distintos `subscription:write/pay/receive/read`, validados antes de replay.
Contexto de actor/instancia/sujeto vinculado fuera del payload, copiado y congelado.
La consulta de intenciones filtra resultados propios; otra identidad autorizada
del mismo ámbito puede recuperar el resultado original, sin cambiar su actor.

## Evidencia ejecutada

Windows/PowerShell, Node 24.19.0. El coordinador ejecutó:

| Comando | Resultado real |
|---|---|
| `node --test tests/subscriptions.test.ts` inicial | 13/13; cobertura parcial disponible entonces |
| `node --test tests/subscription-migration.test.ts` | 11/11 |
| `npm.cmd run format` | Salida 0 |
| `npm.cmd run check`: formato, lint, typecheck | Aprobados |
| `npm.cmd run check`: pruebas completas | **321/321**, 0 fallos, 0 omitidas |
| `npm.cmd run check`: build | Aprobado |
| `git -c core.safecrlf=false diff --check` | Salida 0 |

También se comprobó con `git diff --exit-code` que 001–009, `Money`, el adaptador
en memoria y los manifiestos de dependencias permanecen sin cambios.

Son **280 pruebas anteriores + 41 nuevas**: 30 de dominio/integración y 11 de
migración/integridad. El especialista de pruebas también ejecutó las 30 dirigidas,
formato/lint de sus archivos y typecheck antes de la verificación completa.

Cobertura nueva verificada:

- Casos A–D, titular excluido, meses separados, FIFO entre varias suscripciones,
  participantes históricos inmutables, división indivisible, exceso y retroactividad.
- Importes y participaciones superiores a 64 bits, reembolso de un centavo,
  replay/conflictos de todas las mutaciones, permisos revocados, aislamiento y entradas
  inválidas, bloqueo de correcciones aisladas y separación de salarios/préstamos.
- Fallos tras registro, componente de consumo, alerta y asignación FIFO: rollback
  completo sin intención parcial. Respuesta perdida tras commit y recuperación con
  la misma clave después de reabrir.
- Cuatro carreras entre procesos reales: mismo pago/clave, payload incompatible,
  dos claves por una obligación y reembolsos que compiten por saldo insuficiente.
- Respaldo/restauración en destinos sintéticos separados; preservación de snapshots,
  gasto propio, participaciones, asignaciones y respuestas idempotentes.
- Migración v9 con historia no vacía de gastos/correcciones, presupuestos/eventos,
  ACK/cursor, deudas corregidas, salarios, facturas y préstamos. Fallo de migración
  revierte a v9; éxito conserva filas previas y habilita v10. Las migraciones desde
  versiones anteriores siguen cubiertas por sus pruebas existentes.
- Integridad SQL, ocho variantes de corrupción sintética detectadas en lectura y
  reapertura, bloqueo SQLite, límite monetario, modo solo lectura y almacén cerrado.

Logs ignorados: `.cache/subscriptions-format.log` y `.cache/subscriptions-check.log`.
Bases y copias ficticias bajo `.cache/`, conservadas sin limpieza automática.
No se ejecutó CI remoto, prueba física de corte de energía ni auditoría integral.

## Archivos y coordinación

| Responsable exclusivo | Archivos |
|---|---|
| `finance_domain` | `src/domain/subscriptions.ts`, `src/application/subscription-service.ts`, `src/application/subscription-store.ts` |
| `test_engineer` inicial y especialista de continuación, sucesivamente | `tests/subscriptions.test.ts`, `tests/fixtures/subscription-worker.ts` |
| Coordinador | `src/infrastructure/migrations/010-subscriptions.ts`, `src/infrastructure/sqlite-subscriptions.ts`, `tests/subscription-migration.test.ts` |
| Coordinador, integración | `src/application/expense-store.ts`, `src/infrastructure/sqlite-expense-store.ts` |
| Coordinador, solo expectativa de versión destino | `tests/expense-corrections.test.ts`, `tests/monthly-budget-migration.test.ts`, `tests/event-delivery-migration.test.ts`, `tests/financed-debt-migration.test.ts`, `tests/debt-payment-correction-migration.test.ts`, `tests/salary-migration.test.ts`, `tests/recurring-bill-migration.test.ts`, `tests/personal-loan-migration.test.ts` |
| Coordinador, documentación | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, este informe |

La primera ronda de especialistas se interrumpió por límite de sesión; se conservaron
sus archivos. La continuación de pruebas y revisión se asignó después de comprobar
que los anteriores ya no estaban activos. No hubo escritores simultáneos por ruta.
Seguridad revisó exclusivamente este incremento en modo lectura, sin hallazgos
bloqueantes identificados; no ejecutó pruebas ni escribió archivos. La configuración
declara sandbox de lectura; no se certifica independientemente su aplicación runtime.

## Límites y pendientes

- Solo COP, mensual y reparto equitativo exacto. No se ajustan precio/categoría,
  modalidad, cancelaciones ni periodos ya generados. Sin pagos parciales del total;
  sí reembolsos parciales de participantes. No hay resolución automática de revisiones.
- Sin correcciones conjuntas de pagos/reembolsos/asignaciones, conciliación bancaria,
  transferencias reales, scheduler, cobro automático o mensajes a terceros.
- Máximo 100 externos, 4096 dígitos por importe, 32768 bytes por comando/resultado,
  10000 intenciones y 10000 filas por tabla de vínculos y ámbito, archivo de 64 MiB.
  Reconstrucción síncrona completa, incluidos préstamos para identidades; sin
  paginación ni rendimiento medido al límite.
- Consultas a fecha reflejan hechos actualmente conocidos, no una reconstrucción
  del conocimiento histórico. Las huellas no autentican un archivo reescrito
  coherentemente por alguien con acceso total. Identidad operativa y protección de
  archivos/copias para información real siguen pendientes.

Siguiente incremento recomendado: correcciones conjuntas auditables de pagos y
reembolsos de suscripciones, validando las asignaciones FIFO posteriores y definiendo
la resolución de revisiones. No se autoriza operación real ni se completa toda la Fase 1.
