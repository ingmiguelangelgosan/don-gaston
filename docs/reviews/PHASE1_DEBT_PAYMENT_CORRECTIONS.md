# Fase 1G — Correcciones auditables de pagos de deudas

Fecha: 2026-11-15. Incremento autorizado exclusivamente con datos sintéticos:
anulación/reemplazo de pagos registrados por error, historial y proyecciones
vigentes. **La Fase 1 completa permanece abierta.**

## Implementado y caso principal

- Anular un pago confirmado vigente mediante intención explícita y motivo.
- Reemplazar importe, fecha civil, referencia o cuota, dentro de la misma deuda.
- Conservar originales, propuestas, eventos, motivo, actor, instante UTC y vínculos
  entre original y reemplazo. Sin UPDATE/DELETE de hechos financieros.
- Calcular saldo estimado, progreso de cuotas y caja mensual solo con pagos efectivos.
- Preservar idempotencia, aislamiento y exclusión de correcciones incompatibles.
- Validar contra todos los pagos vigentes, incluidos los posteriores; registrar
  revisiones sin efecto financiero cuando un reemplazo no cabe en saldo/cuota.
- Migrar SQLite v5→v6 conservando registros y resultados anteriores.

Caso sintético ejecutado: referencia de **4.000.000 COP**, pago original de
**250.000 COP**, reemplazo de **200.000 COP**. Resultado: saldo **estimado de
3.800.000 COP** y salida de caja vigente de **200.000 COP**. Original y reemplazo
siguen consultables; la cuota nominal de 250.000 queda parcial con 50.000 pendientes.
No aumenta consumo ni se generan alertas de presupuesto.

Una anulación elimina de las vistas vigentes un registro equivocado. **No representa
una devolución bancaria real**, ingreso, reembolso ni movimiento negativo. No hay
modelado de devoluciones reales en este incremento.

## API y reglas

`DebtPaymentCorrectionsService` recibe el puerto `DebtPaymentCorrectionStore`, una
política y un reloj UTC opcional. Permiso `debt:correct` para mutaciones y
`debt:read` para historial/intención; se revalidan antes de replay. Identidad y reloj
se toman de la aplicación, fuera del payload financiero editable.

| Operación | Resultado |
|---|---|
| `voidPayment(context, key, {paymentId, reason})` | Evento aplicado sin reemplazo; original deja de contribuir |
| `replacePayment(context, key, {paymentId, reason, replacement})` | Evento aplicado con pago nuevo o resultado `review_required` sin efectos |
| `getPaymentHistory(context, paymentId)` | Pago original, estado, `correctedBy` y `replaces` |
| `findIntent(context, key)` | Resultado original de corrección; no devuelve intenciones de otros tipos |

El reemplazo exige todos sus campos: cuota, importe positivo, moneda explícita COP,
fecha civil y referencia. No se infieren campos omitidos ni se cambia la deuda.
Valen las restricciones de cuota/fecha anteriores: no seleccionar cuotas del resumen
histórico, fuera del plan o una fecha anterior a la referencia de deuda. Motivo de
1–500 caracteres normalizado, sin controles; timestamp UTC canónico de aplicación.

Solo un pago confirmado y vigente puede corregirse. Target ajeno/inexistente:
`PAYMENT_NOT_FOUND`. Intento de pago en revisión: `PAYMENT_NOT_CONFIRMED`.
Target retirado por una corrección aplicada: `PAYMENT_ALREADY_CORRECTED`. Estos
fallos no consumen una nueva intención. Se puede corregir el reemplazo vigente,
conservando una cadena auditable. No se puede reactivar el original mediante replay.

El historial distingue `active`, `voided`, `replaced` y `review_required` (este último
para un intento de pago no confirmado). `correctedBy` es la corrección aplicada;
`replaces` enlaza con el evento que creó un reemplazo. Las correcciones que requieren
revisión se recuperan por su clave de intención y conservan la propuesta; no se
presentan como vínculo aplicado ni se incluye un listado paginado nuevo de revisiones.

`getDebt.payments` conserva todos los registros de pago, incluidos retirados e
intentos en revisión. El nuevo campo `effectivePayments` enumera solo confirmados
vigentes. Saldo, cuotas y `confirmedPaymentsTotal` se proyectan desde estos últimos.
`monthlyCashOutflow` excluye anulados/sustituidos y sigue siendo caja de pagos de deuda,
no un consolidado global de caja. No se deben sumar los importes del historial completo.

Las fechas civiles del original y reemplazo determinan los meses que cambian. La
corrección deja evidencia de cuándo se registró, aunque afecte un mes anterior.
Las consultas muestran estado vigente; no implementan consultas temporales «como
se veía entonces». Los campos `estimatedBalanceAfter` de recibos históricos son
evidencia de su decisión original, no el saldo vigente, y nunca se sobrescriben.

## Pagos posteriores, revisión e idempotencia

Dentro de la transacción se obtiene el conjunto de pagos efectivos, se retira
hipotéticamente el original y se valida el candidato contra todos los restantes.
Esto incluye pagos registrados después, y abonos de la misma cuota o cuota destino.

Si el candidato excede saldo estimado o remanente nominal de cuota, se persiste
`review_required` con `EXCEEDS_ESTIMATED_BALANCE` o
`EXCEEDS_INSTALLMENT_REMAINDER`. El evento conserva la propuesta y la decisión,
pero no retira el original, no crea pago nuevo y no modifica caja/saldo. No se
redistribuyen importes ni se retiran otros pagos para hacer caber la propuesta.

Anular un pago positivo libera capacidad sin crear un reembolso. Un reemplazo válido
puede liberar o consumir capacidad, siempre respetando los otros pagos efectivos.
Los resultados antiguos en revisión permanecen así aunque luego haya capacidad:
no se promueven automáticamente ni se reevalúan silenciosamente al reabrir la base.
La resolución asistida de revisiones sigue pendiente.

Huella versionada `debt:void-payment:v1` / `debt:replace-payment:v1` sobre target,
motivo y propuesta normalizada. No incluye IDs generados ni actor/reloj. Mismo key
y contenido devuelve el evento original antes de comprobar nuevamente vigencia;
distinto contenido genera `IDEMPOTENCY_CONFLICT`. El namespace financiero sigue
compartido con los módulos previos. La respuesta de una revisión también es durable.

No se infieren capital, intereses, comisiones ni saldo bancario exacto. La proyección
sigue declarando `balanceKind: 'estimated'`, capital/intereses desconocidos y el
indicador de revisión de deuda conserva su significado previo.

## Persistencia e integridad

La migración `006-debt-payment-corrections.ts` añade `debt_payment_corrections` y
`debt_payment_actions`, más índices/triggers. Reconstruye `debt_intents` añadiendo
`correction_id` y copiando exactamente las columnas anteriores. No cambia importes,
estados, huellas, IDs o respuestas históricas. Las migraciones 001–005 permanecen
intactas y el runner verifica v5 antes del cambio y v6 antes del commit.

Un reemplazo se guarda en `debt_payment_results`, ligado a la misma intención de
corrección. Su JSON/huella de pago se preservan en el evento, mientras la intención
devuelve la corrección completa. Anulación/revisión no crean una fila de pago nueva.
FK recíprocas y un trigger comprueban que `payment_id` corresponda exactamente al
reemplazo de la corrección, incluyendo NULL. No se admite un pago oculto bajo la
intención de una anulación. Las referencias incluyen instancia/sujeto y deuda.

Un índice único parcial permite solo una corrección **aplicada** por pago. Intentos
en revisión pueden coexistir sin retirarlo. `BEGIN IMMEDIATE` cubre lectura de
vigencia/capacidad, decisión, evento, reemplazo opcional e intención. Dos correcciones
incompatibles se serializan; solo una puede aplicarse. Un fallo antes del commit
revierte todo; una respuesta perdida después se recupera repitiendo la intención.

La tabla de acciones establece orden durable entre pagos ordinarios y correcciones.
Los pagos v5 se incorporan en su orden previo. Triggers registran nuevas acciones
atómicamente; un reemplazo pertenece a la acción de corrección y no se duplica como
confirmación independiente. Se usa orden de registro, no `paidOn`, para reproducir
las decisiones que eran válidas en cada momento.

Al abrir, se rehidratan registros/huellas/JSON y se reproduce esa secuencia con los
pagos efectivos de cada paso. Se comprueban decisión, motivos y saldo derivado,
además de cobertura completa y única de pagos/correcciones en las acciones.
Eliminar una acción o alterar el saldo y su JSON para que coincidan es rechazado.
Esto no certifica protección frente a un administrador capaz de alterar toda la
historia y sus controles de forma coherente.

Dinero en centavos textuales y `bigint`; no se añaden sumas monetarias SQL ni importes
flotantes. Se conservan los límites de tamaño existentes. Hay un máximo operativo
de 10000 acciones/resultados por deuda; se comprueba antes de nuevas escrituras para
no crear un historial que la siguiente apertura no pueda verificar. Las consultas
fallan explícitamente con `STORAGE_LIMIT`, sin truncar dinero o historia.

Escritura migra hasta v6. Bases v5 en solo lectura siguen sirviendo los puertos
anteriores, pero historial/correcciones de pagos exige v6. No hay downgrade ni cambio
de driver/dependencias. Lecturas de historia y proyecciones usan snapshot.

## Pruebas ejecutadas

El coordinador ejecutó `npm.cmd run format` y `npm.cmd run check`: **código 0**.
Formato correcto, ESLint sin warnings, typecheck, **170/170 tests aprobados** y build.
Son **145 previos + 22 de correcciones + 3 de migración/integridad**. También se
ejecutaron por separado los 22 y los 3 casos nuevos, ambos con código 0.

Registro local: `.cache/debt-payment-corrections-check.log`; formato en
`.cache/debt-payment-corrections-format.log`. Fixtures bajo `.cache/`, retenidas e
ignoradas por Git. No se eliminaron ni restauraron datos reales. Reproducción:

```powershell
node --test tests/debt-payment-corrections.test.ts tests/debt-payment-correction-migration.test.ts
npm.cmd run check
```

| Área | Evidencia sintética aprobada |
|---|---|
| Caso principal | 250.000→200.000, saldo 3.800.000, cuota parcial, original y reemplazo consultables |
| Anulación | Original fuera de caja/saldo, sin pago negativo ni reembolso |
| Campos y cadenas | Importe, referencia, fecha y cuota; solo la hoja vigente cuenta, vínculos en ambas direcciones |
| Pagos posteriores | Remanente de cuota, cuota destino y saldo global limitan reemplazo; revisiones durables sin efectos |
| Historia | Reintento de alta no reactiva original; revisiones antiguas no se promueven tras liberar saldo |
| Continuidad | Nuevos pagos usan capacidad corregida; decisiones sobreviven reapertura |
| Exactitud | Importes mayores de 64 bits, sin incremento de consumo ni eventos |
| Validación/permisos | Moneda explícita, campos inválidos, límites, revocación, sujeto/instancia ajenos y namespace financiero |
| Rollback | Fallos tras evento y reemplazo, anulación fallida sin retiro; misma clave puede reintentarse |
| Respuesta incierta | Fallo después de commit conserva corrección y caja única |
| Procesos | Reintentos simultáneos obtienen un ID; correcciones incompatibles tienen un ganador |
| Copias | Restauración separada conserva IDs, claves, vínculos y proyecciones vigentes |
| Migración | Base v5 con pagos confirmados/revisión: rollback, columnas/JSON anteriores iguales, operación en v6 |
| Integridad SQL | Append-only, FK por ámbito, no pago oculto bajo anulación, cobertura de acciones y decisión alterada rechazadas |

No se repitió una auditoría general. No se verificaron Linux, CI remoto, carga masiva,
cortes eléctricos o recuperación física de producción. Las pruebas de rollback son
inyecciones sintéticas controladas y las carreras usan procesos locales.

## Archivos y coordinación

| Responsable | Archivos / entrega |
|---|---|
| finance_domain | `src/domain/debt-payment-corrections.ts`, `src/application/debt-payment-correction-store.ts`, `debt-payment-corrections-service.ts` |
| Coordinador | `src/application/expense-store.ts`, campo de pagos efectivos en `src/domain/financed-debts.ts` |
| Coordinador | `src/infrastructure/sqlite-financed-debts.ts`, `sqlite-expense-store.ts`, `migrations/006-debt-payment-corrections.ts` |
| test_engineer | `tests/debt-payment-corrections.test.ts`, `tests/fixtures/debt-correction-worker.ts` |
| Coordinador | `tests/debt-payment-correction-migration.test.ts`; expectativas de versión actual en cuatro pruebas de migración anteriores |
| Coordinador | `README.md`, reglas funcionales, roadmap, arquitectura, ADR-001 y este informe |
| security_reviewer | Inspección en lectura de dominio, servicio y migración; observaciones de integridad |

No hubo escrituras simultáneas sobre rutas compartidas. Dominio entregó código y
verificación focal de formato/lint/reglas. Pruebas escribió y formateó sus casos,
pero alcanzó el límite de uso antes de ejecutar la suite dirigida; el coordinador
la ejecutó y completó la verificación integrada.

Seguridad revisó dominio/servicio/migración y destacó el vínculo exacto entre
corrección e ID de reemplazo, así como cobertura inversa de acciones. Alcanzó su
límite antes de cerrar la revisión final del adaptador. El coordinador asumió esa
inspección y probó integridad/timeline; **no se presenta como revisión independiente
completa del adaptador**. El revisor no realizó escrituras; el enforcement de su
sandbox de solo lectura no está certificado.

## Pendientes y limitaciones

- Identidad/autorización son fixtures; no hay autenticación operativa ni binding
  con Jarvis. No se habilita información real.
- Resolver revisiones de forma asistida, conciliar saldos y modelar devoluciones
  bancarias reales requieren reglas separadas. No se implementó ninguno.
- No hay traslado entre deudas, corrección de apertura histórica, amortización
  avanzada ni inferencia de capital/intereses/comisiones.
- No hay consultas temporales, recorrido paginado de cadenas o listado general de
  correcciones en revisión. Los enlaces por ID y resultados por intención sí existen.
- Permanecen límites operativos y pendientes de privacidad/backup del ADR. La
  reconstrucción histórica prioriza integridad; no se ha medido a escala masiva.
- No se añadieron gastos ordinarios, alertas, recordatorios, canales, bancos, IA,
  préstamos personales, salarios, facturas o conciliación con extractos. No se tocó
  Jarvis, infraestructura, dependencias ni lockfile. Sin despliegues, commits o PR.

Siguiente incremento recomendado: definir resolución explícita de revisiones y
conciliación de saldos reportados mediante fixtures, conservando la historia. La
Fase 1 completa sigue abierta.
