# Fase 1F — Deudas financiadas y pagos de cuotas

Fecha de verificación final: 2026-11-15. Alcance aprobado: registrar una deuda
financiada existente y pagos confirmados completos/parciales por cuota, en modo
simplificado y exclusivamente con fixtures sintéticas. **La Fase 1 completa sigue
abierta.** No se ejecutan pagos reales ni se conectan bancos, Jarvis o canales.

## Resultado implementado

- Apertura inmutable con descripción, valor financiado, número/valor nominal de
  cuotas, fecha de referencia, saldo reportado y resumen de pagos anteriores.
- Tasa E.A., condiciones y dinero histórico opcionales, preservando desconocido
  cuando faltan; sin inferencia de tasas ni reconstrucción de pagos históricos.
- Confirmación explícita de pagos por cuota con fecha, importe, referencia,
  actor, instante e intención idempotente.
- Abonos parciales y consulta del avance nominal de cada cuota, historial de
  resultados, total confirmado y saldo claramente marcado como estimado.
- Una sola salida de caja por pago confirmado; ninguna alta de gasto de consumo,
  afectación de presupuesto o alerta de vencimiento.
- Resultados durables de revisión para excedentes, sin efecto en saldo/caja.
- Migración SQLite v5 aditiva, aislamiento, transacciones, reinicios y restauración.

Se revisó la [referencia original §4](../REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md):
el resumen histórico incluye cantidad de cuotas y dinero desembolsado conocido;
el modo simplificado descuenta pagos como estimación, pues pueden incluir intereses.
El documento histórico permanece intacto. No se implementa su modo informado.

## Caso de uso verificado

Estas cifras son fixtures explícitas, no información de una compra o crédito real:

| Dato | Valor ficticio |
|---|---|
| Descripción | iPhone sintético |
| Valor financiado | 4.800.000 COP |
| Plan nominal | 24 cuotas de 250.000 COP |
| Fecha de referencia | 2026-11-01 |
| Saldo de referencia reportado | 4.000.000 COP |
| Resumen anterior | 8 cuotas completas, 2.000.000 COP desembolsados |
| Tasa E.A. | Desconocida; no se asume cero |
| Nuevo pago | Cuota 9, 250.000 COP, fecha civil 2026-11-14 |

Antes del nuevo pago hay ocho cuotas históricas y dieciséis nominales pendientes;
caja actual y pagos registrados nuevos son cero. Confirmar la cuota 9 deja quince
cuotas nominales pendientes, **saldo estimado de 3.750.000 COP**, una única salida
mensual de caja de 250.000 COP y consumo mensual sin incremento. Repetir la misma
intención conserva el ID, actor, instante y resultado; caja continúa en 250.000 COP.

La diferencia entre valor financiado, total nominal y saldo reportado no se convierte
en un cálculo inventado de intereses. No se resta nuevamente el dinero histórico
del saldo de referencia. El README muestra la misma operación con otra fecha civil
ficticia del mismo mes; las pruebas no dependen del reloj del servidor para periodos.

## API y semántica

`FinancedDebtService` recibe `FinancedDebtStore`, política y reloj UTC opcional.

| Operación | Permiso y resultado |
|---|---|
| `registerDebt(context, key, input)` | `debt:write`; apertura original inmutable |
| `confirmPayment(context, key, input)` | `debt:pay`; pago confirmado o resultado de revisión |
| `getDebt(context, debtId)` | `debt:read`; apertura, saldo estimado, historial y cuotas |
| `monthlyCashOutflow(context, {month})` | `debt:read`; solo pagos confirmados de deuda en ese mes |
| `findIntent(context, key)` | `debt:read`; resultado original de deuda/pago, sin exponer otros dominios |

La apertura requiere `description`, `financedAmount`, `installmentCount`,
`installmentAmount`, `referenceOn`, `referenceBalance` y
`historicalPaidInstallments`. Opcionales: `historicalPaidAmount`,
`annualEffectiveRate`, `terms` y moneda (COP predeterminada). No se deriva dinero
histórico multiplicando cantidad por cuota; su ausencia es `null`.

El resumen de N cuotas completas representa las primeras N del plan. En su vista
individual, `paid` y `pending` son `null`: se conoce el resumen, no la distribución
histórica exacta. No se inventan fechas de vencimiento, pagos individuales ni una
salida por la compra original al dar de alta la deuda.

`confirmPayment` exige `debtId`, `installmentNumber`, `amount`, `paidOn` y `reference`.
La cuota debe ser posterior al resumen histórico y estar dentro del plan. La fecha
debe ser civil válida e igual o posterior a la fecha de referencia; no se compara
con el reloj para inferir si se pagó. La operación es una confirmación explícita
autorizada de algo ya pagado, no una orden de transferencia. No hay borradores ni
campo editable `confirmed` que permita sustituir la autorización.

Los abonos completan únicamente la cuota seleccionada. La vista nominal distingue
`historical`, `pending`, `partial` y `paid`. No hay FIFO, pagos distribuidos entre
varias cuotas, anticipos repartidos ni liquidación bancaria inferida. El saldo se
calcula como referencia menos suma de pagos confirmados. La consulta declara
siempre `balanceKind: 'estimated'`, `principalBalance: null` e `interestPaid: null`.
Un saldo estimado cero no demuestra saldo bancario cero.

La cuota nominal puede diferir del saldo reportado. Se conservan aperturas con
inconsistencias, marcando `requiresReview` si hay saldo cero y cuotas pendientes,
saldo positivo sin cuotas pendientes, o dinero histórico sin cuotas completas
identificadas. El último caso podría ser un abono anterior, pero no se le inventa
una asignación. Este indicador no evalúa todas las posibles condiciones bancarias.

La tasa es un porcentaje E.A. decimal textual exacto no negativo, hasta seis
decimales y 100 caracteres; se normalizan ceros finales. Se admite cero informado,
distinto de ausencia. Ni tasa ni condiciones textuales se usan para inventar
capital, intereses, comisiones o seguros. No se aplica redondeo monetario.

## Excedentes e idempotencia

Si el importe supera el saldo estimado, el resultado es `review_required` con
`EXCEEDS_ESTIMATED_BALANCE`. Si cabe en el saldo pero supera el remanente nominal de
la cuota, es `EXCEEDS_INSTALLMENT_REMAINDER`. Ambos conservan importe solicitado,
fecha, cuota, referencia, actor, instante y saldo estimado sin reducción.

Estos resultados se guardan en el historial de intentos, pero no son pagos confirmados
ni generan caja. El historial de `getDebt` incluye ambos estados explícitos;
`monthlyCashOutflow` filtra solo confirmados. Resolver una revisión no está
implementado: no se redistribuye el excedente ni se altera un resultado existente.

Huella versionada de apertura `debt:register:v1` y de pago
`debt:confirm-payment:v1`. Incluyen payload normalizado; excluyen ID generado,
actor/instante y la decisión derivada. La respuesta original queda almacenada.
Reintentar primero recupera esa respuesta, antes de reevaluar saldo/cuota, incluso
si la respuesta era revisión o la cuota ya quedó completa. Mismo key con otro
contenido u otra operación produce `IDEMPOTENCY_CONFLICT`.

La clave comparte ámbito con categorías, gastos, correcciones y presupuestos.
Los servicios anteriores filtran explícitamente los tipos que pueden devolver,
evitando revelar deuda con un permiso de gastos. La referencia textual del pago
no es un ID bancario único: dos abonos legítimos pueden tener la misma descripción;
la deduplicación requiere que el origen conserve su clave de intención estable.
No se puede detectar universalmente que dos claves nuevas describen el mismo pago real.

## Persistencia, atomicidad y precisión

La migración `005-financed-debts.ts` añade:

| Tabla | Responsabilidad |
|---|---|
| `financed_debts` | Apertura y resumen histórico inmutables |
| `debt_payment_results` | Hecho de pago confirmado o intento en revisión, con orden de registro |
| `debt_intents` | Huella y respuesta original, vinculadas por FK recíprocas |

No reconstruye ni cambia filas de las tablas financieras previas. Claves únicas
por ámbito y triggers cruzados en `intents` / `debt_intents` impiden la reutilización
de una clave entre módulos, en ambos órdenes de inserción. Las FK recíprocas
unen registro e intención; los pagos solo referencian deudas de su instancia/sujeto.
Triggers append-only impiden UPDATE/DELETE de aperturas, pagos e intenciones.

El componente interno `SqliteFinancedDebts` reutiliza la conexión y el ciclo de vida
del adaptador. `BEGIN IMMEDIATE` abarca lectura de saldo/cuota, decisión, registro
del resultado e intención. Dos pagos concurrentes no pueden consumir el mismo
remanente de saldo o cuota; la segunda decisión observa el primero confirmado.
Un fallo antes del commit revierte todo. Un fallo simulado después conserva el
resultado durable, recuperable con la misma clave. Las consultas usan snapshot.

La única fuente de salida de caja es la fila confirmada de pago; la vista mensual
la reutiliza. No se inserta en `facts` ni `budget_alerts`. La apertura histórica no
se incluye en esa proyección. Esta consulta es **caja de pagos de deuda**, no un
consolidado global de efectivo de todos los módulos.

Importes como texto canónico en centavos y `Money`/`bigint` en memoria. No hay SUM
monetario SQL ni conversión de importes a `number`. Se preservan exactamente valores
superiores a 64 bits. Límites: 4096 dígitos por importe, 32768 bytes por resultado,
base de 64 MiB y 10000 resultados por deuda/consulta mensual; hasta 1200 cuotas,
descripción 200, condiciones 1000 y referencia 128 caracteres. Un exceso operativo
produce error explícito; no se trunca un saldo o historial silenciosamente.

Al abrir se comprueban esquema/checksums/FK, huellas, JSON original, normalización
y decisiones. Se reconstruye cada decisión en orden de registro, **no** de fecha
de pago, que puede ser retroactiva. Alterar saldo derivado y JSON para que coincidan
no basta para ocultar una decisión incoherente. Esto no protege frente a un
administrador que cambie coherentemente toda la historia y controles.

Apertura con escritura migra hasta v5; consultas financieras anteriores permanecen
disponibles en bases previas de solo lectura. El nuevo puerto exige v5. No hay
downgrade, dependencia nueva, cambio de driver o modificación de migraciones 001–004.

## Pruebas realmente ejecutadas

Coordinador: `npm.cmd run format` y `npm.cmd run check`, **código 0**. El chequeo
incluyó formato, ESLint sin warnings, typecheck, **145/145 pruebas aprobadas** y
build. Son **115 anteriores + 26 de deudas + 4 de migración/integridad**.
También se ejecutaron por separado las cuatro pruebas de migración/integridad.

Registro local: `.cache/financed-debts-check.log`; formato en
`.cache/financed-debts-format.log`. Fixtures retenidas en
`.cache/financed-debt-tests/` y `.cache/debt-migration-tests/`, sin datos reales ni
limpieza automática. Reproducción:

```powershell
node --test tests/financed-debts.test.ts tests/financed-debt-migration.test.ts
npm.cmd run check
```

| Área | Evidencia aprobada con fixtures |
|---|---|
| Caso iPhone | 24 cuotas, 8 históricas, cuota 9 confirmada, saldo estimado y 15 pendientes; un solo hecho de caja |
| Caja/consumo | Apertura excluida de caja actual, pago sin gasto/budget/alertas; fechas explícitas por mes |
| Parciales | Dos abonos completan solo la cuota escogida; exceso no se reparte |
| Estimación | Capital/intereses desconocidos, tasa ausente o cero diferenciadas, condiciones preservadas, contradicciones marcadas |
| Precisión | Decisión de borde con bigint, importes mayores de 64 bits y exceso de tamaño rechazado |
| Idempotencia | Mismos ID/actor/instante/decisión; distinto payload y conflicto entre dominios; revisión permanece estable |
| Validación | Cuotas, tasa, fecha anterior a referencia, monto, referencia y campos de confirmación/identidad inesperados |
| Permisos | Revocación antes de replay, instancia/sujeto ajenos y lectura restringida por dominio |
| Fallos | Rollback después de apertura o pago, reintento con misma clave, respuesta perdida después del commit |
| Procesos | Misma clave única; payload incompatible; competencia por saldo y por remanente de la misma cuota |
| Reinicio/copias | Recuperación y replay; backup restaurado en archivo separado conserva historia y resultados |
| Migración | v4 con gastos/correcciones/presupuestos/eventos/ACK/cursor; igualdad de filas, rollback, consulta anterior y operación en v5 |
| Integridad | Append-only, FK recíprocas/ámbito, colisión SQL entre namespaces, dato no canónico y decisión alterada aun con JSON coherente |

No se afirma ejecución en Linux, CI remoto, corte eléctrico, carga masiva o datos
productivos. Las pruebas de proceso son procesos locales sintéticos coordinados;
no involucran canales, bancos ni pagos externos.

## Archivos y trabajo multiagente

| Responsable | Archivos / entrega |
|---|---|
| finance_domain | `src/domain/financed-debts.ts`, `src/application/financed-debt-store.ts`, `financed-debt-service.ts` |
| Coordinador | `src/infrastructure/migrations/005-financed-debts.ts`, `sqlite-financed-debts.ts`, `sqlite-expense-store.ts` |
| Coordinador | `src/application/expense-store.ts`, `expense-service.ts`, `expense-corrections-service.ts` |
| test_engineer | `tests/financed-debts.test.ts`, `tests/fixtures/debt-worker.ts` |
| Coordinador | `tests/financed-debt-migration.test.ts`; expectativa de versión actual en pruebas anteriores de correcciones/migración de presupuestos/eventos |
| Coordinador | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/adr/001-persistence.md`, este informe |
| security_reviewer | Revisión acotada en lectura de aislamiento, namespace, transacciones, caja e integridad |

Los agentes tuvieron propiedad exclusiva por archivo. Dominio entregó validaciones
y comprobaciones focalizadas; pruebas aportó los casos automatizados y pruebas
dirigidas; el coordinador ejecutó la suite final. No hubo escrituras simultáneas.

Seguridad confirmó por inspección el aislamiento, los filtros de resultados,
el replay anterior a decisiones nuevas y la comprobación semántica por secuencia.
No identificó bloqueantes en el delta revisado y no ejecutó pruebas ni escrituras.
El rol declara `read-only`; su enforcement efectivo por el runtime no está
certificado. No se realizó una auditoría general.

## Pendientes y límites

- Identidad y permisos están simulados con fixtures. No hay autenticación real,
  binding con Jarvis, conexión bancaria, conciliación con extractos ni aprobación
  para datos financieros reales.
- Solo modo simplificado y COP. El saldo reportado es referencia, el resultado es
  estimado; capital/intereses/comisiones/seguros y amortización detallada quedan
  pendientes aunque exista una tasa registrada.
- No se implementaron borradores de pago, correcciones/anulaciones de pagos,
  reestructuraciones, reasignaciones entre cuotas o resolución de resultados de
  revisión. La historia nunca se sobrescribe para resolver esas situaciones.
- No hay calendario de vencimientos inferido, recordatorios, préstamos entre
  personas, salarios, facturas recurrentes, suscripciones, IA ni canales.
- Historial limitado explícitamente por filas y cuotas; no hay paginación nueva
  para deudas. La reconstrucción de decisiones al abrir prioriza integridad y no
  se ha evaluado a escala masiva. Se mantienen límites/pendientes operativos del
  ADR: respaldo, permisos de archivo, cifrado y recuperación física.
- No se tocaron Jarvis, infraestructura, dependencias o lockfile; no hubo pagos
  reales, despliegues, commits ni PR.

Siguiente incremento recomendado: definir correcciones auditables de pagos y
conciliación explícita de saldos reportados, con fixtures y reglas de revisión antes
de añadir amortización. La Fase 1 completa sigue abierta.
