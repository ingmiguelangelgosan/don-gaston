# Fase 1J — Préstamos entre personas

Fecha: 2026-11-16. Implementado y verificado localmente con datos sintéticos.
**La Fase 1 completa permanece abierta.** Sin cambios a Sir Jarvis, infraestructura,
despliegue, conexiones bancarias, Telegram, IA, mensajes a terceros, dependencias
nuevas, commits o PR.

## Alcance implementado

Se revisaron `AGENTS.md`, reglas funcionales, arquitectura, roadmap, informe de
facturas recurrentes, referencia original §7 y patrones existentes. Se mantiene
ADR-001 con SQLite local; no se modifica la tecnología ni se habilitan datos reales.

- Contrapartes con ID estable y nombre normalizado. Nombres iguales pueden
  representar personas distintas; se opera por ID, no por coincidencia textual.
- Libro inmutable con desembolsos múltiples y abonos parciales/totales. Cada
  movimiento conserva importe COP, fecha civil, referencia, actor, intención e
  instante UTC de registro.
- Saldos agregados por contraparte y dirección: `receivable` («me deben») y
  `payable` («le debo»), sin compensación automática ni asignaciones inventadas
  a desembolsos individuales.
- Exceso de abono devuelve/persiste `review_required`, sin aplicar una parte,
  reducir capital ni generar caja. Una revisión antigua mantiene su resultado
  original incluso si se registra nuevo capital.
- Abonos retroactivos se validan contra todos los saldos intermedios cronológicos
  de confirmados, incluidos movimientos posteriores; un prefijo negativo exige
  revisión. Misma fecha desempata por orden durable de registro.
- Consultas de posición/historial a fecha civil explícita, totales separados por
  dirección y caja mensual exclusiva de préstamos. No hay un consolidado global.

| Operación | Caja | Posición | Ingreso ganado / consumo |
|---|---|---|---|
| Recibir préstamo | Entrada | Aumenta pasivo | Sin incremento |
| Prestar dinero | Salida | Aumenta cuenta por cobrar | Sin incremento |
| Recibir devolución | Entrada | Reduce cuenta por cobrar | Sin incremento |
| Devolver préstamo | Salida | Reduce pasivo | Sin incremento |

Cada movimiento confirmado es un único hecho de caja con una proyección de
capital; no se escriben hechos redundantes en `facts` ni en salarios/presupuestos.

## Contrato local y decisiones

`PersonalLoanService(store, policy, clock)`:

| Método | Datos y resultado |
|---|---|
| `createCounterparty(context, key, {name})` | Identidad estable; el nombre no es único |
| `recordDisbursement(context, key, input)` | Contraparte, dirección, importe, fecha y referencia; capital confirmado |
| `recordRepayment(context, key, input)` | Mismos campos; abono confirmado o revisión durable |
| `getPosition(context, {counterpartyId,direction,asOf})` | Capital desembolsado, devuelto, saldo e historial, incluyendo revisiones identificadas |
| `listPositions(context, {asOf})` | Ambas posiciones por persona y totales separados |
| `monthlyCashFlow(context, {month})` | Entradas/salidas confirmadas y sus movimientos únicos |
| `findIntent(context, key)` | Resultado original del dominio de préstamos |

Input monetario decimal canónico positivo; `Money` usa centavos COP con `bigint`.
No hay redondeo, interés, comisión o condiciones inferidas. Nombre 1–200 caracteres
y referencia 1–128, normalizados sin controles internos. Persona, dirección y
fecha deben ser explícitas; campos adicionales no autorizados se rechazan.

Permisos `loan:counterparty`, `loan:disburse`, `loan:repay` y `loan:read`. El servicio
congela y valida contexto vinculado fuera del payload; autoriza antes de acceso o
replay. Otro actor autorizado del mismo ámbito puede reintentar, conservando actor
original. Clave igual y contenido diferente produce `IDEMPOTENCY_CONFLICT`.

Exceso total produce `EXCEEDS_PENDING_BALANCE`. Si el importe cabe en el total pero
su fecha rompe un saldo histórico intermedio, produce `PAYMENT_DATE_REQUIRES_REVIEW`.
Los resultados en revisión tienen `cashDirection=null` y no modifican el saldo.
Resolver una revisión exige una decisión explícita nueva; no hay flujo conversacional
implementado. Un desembolso retroactivo agrega capital y no reinterpreta revisiones.

`principalBalanceAfter` es evidencia del saldo total conocido al registrar la
decisión, no un saldo bancario conciliado ni necesariamente el saldo a esa fecha
retroactiva. La consulta `asOf` usa las fechas financieras de hechos actualmente
conocidos; no reconstruye conocimiento histórico por `recordedAt`. Las contrapartes
conocidas pueden aparecer sin movimientos elegibles y con saldos cero.

## Casos sintéticos verificados

| Caso | Movimientos | Resultado |
|---|---|---|
| A, madre ficticia | Préstamo recibido $80.000; devolución $30.000 | Le debo $50.000; caja entrada $80.000 y salida $30.000 |
| B, Juan ficticio | Presto $200.000; devuelve $70.000; presto otros $50.000 | Me debe $180.000; tres movimientos individuales |
| C, misma persona | Me debe $200.000 y le debo $50.000 | Ambas posiciones visibles; sin netear |

Los nombres y cifras son fixtures, no operaciones reales. Se verificó además
liquidación exacta con centavos, pago sin deuda previa, nombres repetidos con IDs
distintos y cantidades superiores a signed 64 bits.

Una prueba crea previamente gasto, presupuesto/alerta y salario devengado con
abono recibido; después ejecuta los cuatro efectos de capital. Compara las vistas
previas y posteriores y demuestra que consumo, presupuesto/eventos, devengado y
recibido salarial permanecen intactos.

## SQLite v9 e integridad

Migración 009 aditiva: `loan_counterparties`, `loan_movements`, `loan_intents`.
Las migraciones 001–008, el objeto monetario y el adaptador en memoria permanecen
sin cambios. FK recíprocas por ámbito vinculan hechos/intenciones; restricciones
validan moneda, importes canónicos, dirección, estado y orientación de caja.
Triggers prohíben actualización/borrado y colisiones de claves con gastos, deudas,
salarios y facturas en ambos sentidos.

Lectura del saldo, decisión, registro y resultado idempotente comparten
`BEGIN IMMEDIATE`. Consultas usan snapshot. Verificación al abrir/leer reproduce
decisiones por secuencia durable y compara comando, huella, resultado y filas.
No presenta una revisión original como confirmada porque el saldo posterior cambió.
Respaldo/restauración reutilizan el mecanismo previo en destinos sintéticos separados.

La prueba de migración construye v8 con gasto corregido, presupuesto, alertas,
ACK/cursor, deuda con reemplazo, salario con asignaciones y factura ajustada/pagada
con estimación posterior. Verifica rollback a v8 y después compara las filas e
intenciones previas tras migrar a v9 y registrar movimientos de préstamo. Las
pruebas de migración de versiones anteriores siguen pasando con v9 como destino.

## Evidencia ejecutada

Entorno local Windows/PowerShell, Node 24.19.0. Comandos ejecutados por el coordinador:

| Verificación | Resultado |
|---|---|
| `npm.cmd run format` | Salida 0 |
| `npm.cmd run check` → formato | Aprobado |
| `npm.cmd run check` → lint | Aprobado, sin warnings |
| `npm.cmd run check` → typecheck | Aprobado |
| `npm.cmd run check` → pruebas | **280/280**, sin fallos ni omitidas |
| `npm.cmd run check` → build | Aprobado |
| `git diff --check` | Salida 0 |

Son **246 pruebas anteriores + 34 nuevas**: 26 de dominio/integración y 8 de
migración/integridad. Cobertura nueva: casos A/B/C, varios desembolsos, abonos y
liquidación, exceso durable, fechas retroactivas, independencia de direcciones,
idempotencia global, permisos/aislamiento, importes mayores de 64 bits, rollback
tras contraparte/movimiento, pérdida de respuesta tras commit, reinicio y restauración.

Cuatro carreras entre procesos reales: mismo abono/intención, contenido incompatible,
dos abonos que compiten por saldo insuficiente y dos desembolsos distintos que
deben conservarse. Integridad: append-only/FK/estado/caja, corrupción sintética de
importe, revisión, contraparte y fecha, movimiento huérfano, bloqueo, límite
monetario, solo lectura y almacén cerrado.

La ejecución dirigida inicial obtuvo 25/26: la comparación de snapshots del test
intentaba serializar directamente el `bigint` de una fracción presupuestaria.
Se corrigió únicamente el serializador de la fixture y la ejecución completa
posterior aprobó todos los casos. No fue una pérdida monetaria del dominio.

Logs ignorados: `.cache/personal-loans-format.log`, `.cache/personal-loans-check.log`
y `.cache/personal-loans-targeted.log` (este último conserva el ensayo previo).
Bases ficticias en `.cache/personal-loan-tests/` y
`.cache/personal-loan-migration-tests/`, sin limpieza automática. No se ejecutó
CI remoto, prueba física de corte de energía ni auditoría integral.

## Archivos y coordinación

| Responsable de escritura | Archivos |
|---|---|
| `finance_domain` | `src/domain/personal-loans.ts`, `src/application/personal-loan-store.ts`, `src/application/personal-loan-service.ts` |
| `test_engineer`, después coordinador | `tests/personal-loans.test.ts` |
| Coordinador | `tests/fixtures/personal-loan-worker.ts`, `tests/personal-loan-migration.test.ts`, `src/infrastructure/migrations/009-personal-loans.ts`, `src/infrastructure/sqlite-personal-loans.ts` |
| Coordinador, integración | `src/application/expense-store.ts`, `src/infrastructure/sqlite-expense-store.ts` |
| Coordinador, solo expectativa de versión vigente | `tests/expense-corrections.test.ts`, `tests/monthly-budget-migration.test.ts`, `tests/event-delivery-migration.test.ts`, `tests/financed-debt-migration.test.ts`, `tests/debt-payment-correction-migration.test.ts`, `tests/salary-migration.test.ts`, `tests/recurring-bill-migration.test.ts` |
| Coordinador, documentación | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, este informe |

Dominio entregó implementación y verificaciones propias de formato/lint/smoke.
El agente de pruebas dejó cobertura parcial; al continuar ya no figuraba activo,
por lo que el coordinador tomó propiedad, completó procesos/concurrencia, corrigió
la fixture y ejecutó la validación. Sin escritores simultáneos sobre las mismas rutas.
Seguridad entregó revisión focal solo lectura del delta, sin fallos bloqueantes
confirmados; no ejecutó pruebas ni editó archivos. La configuración del rol declara
solo lectura; no se certifica independientemente su aplicación efectiva por el runtime.

## Límites y siguiente incremento

- Solo capital COP personal registrado; sin interés, amortización, vencimiento,
  condiciones inferidas, préstamo empresarial, recordatorios o mensajes a terceros.
- Sin correcciones de movimientos, edición/fusión de contrapartes, importación de
  saldos históricos separados de caja ni resolución conversacional de revisiones.
  Un desembolso representa caja real reportada, nunca una apertura sin caja implícita.
- No hay asignación FIFO a desembolsos ni compensación de direcciones; el abono
  reduce el capital agregado. No hay consolidado global de caja o ingresos.
- 4096 dígitos por importe, 32768 bytes por comando/resultado, 10000 intenciones
  de préstamos por ámbito y 64 MiB por archivo. Reconstrucción síncrona completa
  con ordenamientos repetidos; no se midió rendimiento al límite ni hay paginación.
- Autenticación operativa, protección de archivos/copias y uso real permanecen
  pendientes. Las huellas detectan inconsistencias, no autentican una reescritura
  coherente realizada por alguien con control de escritura completo del archivo.

Siguiente incremento recomendado: correcciones auditables del capital y resolución
explícita de revisiones, validando todos los movimientos posteriores. La Fase 1
completa sigue abierta; este incremento no habilita información real ni despliegue.
