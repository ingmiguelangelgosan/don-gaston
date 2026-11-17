# Don Gastón — agente financiero independiente

**Estado: demostración sintética de integración verificada el 2026-11-17.** Registro y consulta de gastos mediante envelope 1.0, frontera autenticada y HTTPS efímero de pruebas; SQLite financiero v10 sin cambios. **354 pruebas aprobadas.** Se conservan los módulos financieros y el adaptador en memoria. La Fase 1 sigue abierta; sin conexión al runtime real de Sir Jarvis, datos reales ni API desplegada. Sin commits ni PR en este incremento.

Don Gastón es propietario de las reglas financieras; Sir Jarvis conserva canales, identidad conversacional, orquestación y confirmaciones. Solo el alcance descrito aquí está implementado; las demás reglas de producto siguen siendo requisitos. La referencia histórica se conserva sin cambios.

## Demostración HTTPS local aprobada

```powershell
node --test tests/jarvis-demo-contract.test.ts tests/jarvis-demo-journal.test.ts tests/jarvis-synthetic-integration.test.ts
```

Genera certificados y credenciales sintéticos, abre un receptor temporal únicamente
en loopback y lo cierra al terminar. Requiere OpenSSL local (Git para Windows
incluye el utilizado en esta ejecución); no instala certificados ni dependencias.
Registra 45.000 COP, reintenta sin duplicar, consulta por intención, simula respuesta
perdida y recupera desde otro proceso. Comprueba TLS, scopes, permisos y límites.

El consumidor es simulado, con el contrato inspeccionado; **no es una prueba del
runtime real Jarvis**. Hay dos archivos sintéticos: ledger financiero y journal de
huellas de solicitudes. La reapertura exige conservar la pareja; no hay transacción
ni respaldo coordinados entre ambos. No se activa un servicio desde `npm start`.
[Perfil contractual](docs/AGENT_PROTOCOL_DRAFT.md) y
[evidencias, archivos y límites](docs/reviews/JARVIS_SYNTHETIC_INTEGRATION.md).

## Suscripciones personales y compartidas

`SubscriptionService` permite crear suscripciones, generar pendientes mensuales,
versionar participantes para meses futuros, confirmar el pago total y recibir
reembolsos parciales/completos. Los participantes reutilizan IDs de contrapartes
de `PersonalLoanService`, sin mezclar sus cuentas por cobrar con préstamos.

Ejemplo en una composición sintética con `store`, `policy`, `context`, categoría
y dos contrapartes ya creados:

```typescript
import { SubscriptionService } from './src/application/subscription-service.ts';
const subscriptions = new SubscriptionService(store, policy);
const subscription = subscriptions.createSubscription(context, 'sharing-create', {
  name: 'Suscripción ficticia', categoryId: category.id, mode: 'shared',
  monthlyAmount: '45000', effectiveMonth: '2026-11',
  includesHolder: true, counterpartyIds: [juan.id, ana.id],
});
const obligation = subscriptions.generateObligation(context, 'sharing-november', {
  subscriptionId: subscription.id, month: '2026-11', generatedOn: '2026-11-01',
});
subscriptions.confirmPayment(context, 'sharing-paid', {
  obligationId: obligation.id, amount: '45000', paidOn: '2026-11-05',
  reference: 'Pago ficticio confirmado',
});
subscriptions.receiveReimbursement(context, 'juan-partial', {
  counterpartyId: juan.id, amount: '10000', receivedOn: '2026-11-06',
  reference: 'Reembolso ficticio confirmado',
});
subscriptions.getReceivables(context, { counterpartyId: juan.id, asOf: '2026-11-30' });
subscriptions.monthlyCashFlow(context, { month: '2026-11' });
```

Resultado: salida de **45.000 COP**, consumo/presupuesto propio de **15.000 COP**,
Juan pendiente **5.000 COP**, Ana **15.000 COP**, entrada de reembolso **10.000 COP**.
Un segundo reembolso de Juan por 5.000 salda su participación, sin ingreso ganado.
Personal de 30.000 produce caja y consumo de 30.000 sin cuentas por cobrar externas.

Solo se aceptan repartos exactos en centavos: importes indivisibles quedan en
revisión durable sin pago efectivo. Reembolsos excedentes o fechas que alterarían
asignaciones anteriores también requieren revisión. Se conservan snapshots e IDs
entre reinicios; los reintentos usan la misma clave. `findIntent` recupera el resultado.

Permisos: `subscription:write`, `subscription:pay`, `subscription:receive` y
`subscription:read`; alta de contraparte existente con `loan:counterparty`.
Consumo por fecha de pago; mes facturado separado. La caja mostrada pertenece solo
a suscripciones: no hay consolidado global ni compensación automática con préstamos.
Sin cambios de precio, cancelaciones, correcciones conjuntas, scheduler o mensajes.
[Informe, archivos y verificaciones](docs/reviews/PHASE1_SHARED_SUBSCRIPTIONS.md).

## Ejecutar localmente

Entorno probado: Windows/PowerShell, Node **24.19.0**, npm **11.17.0**. Se admite Node 24 desde 24.19.0; no se actualizó el runtime del equipo. Node 24 es una [línea LTS](https://github.com/nodejs/Release), no se afirma que el patch instalado sea el último disponible.

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd run example:expense
npm.cmd run example:sqlite
npm.cmd start
```

En otras shells puede usarse `npm` en lugar de `npm.cmd`. La instalación descarga herramientas de desarrollo desde npm; arranque y pruebas no usan servicios externos. `.npmrc` desactiva scripts de instalación y usa caché local ignorada. No hay dependencias de ejecución, hooks de instalación propios ni servicios.

`.env` es opcional: los valores por defecto son locales y sintéticos. Para personalizar la configuración permitida se puede copiar `.env.example` a `.env`; no introducir secretos. El proceso valida configuración, imprime un mensaje estático y termina, sin escuchar puertos. `npm start` requiere el build generado por `npm run check` o `npm run build`.

Configuración admitida: `NODE_ENV=development|test`, `APP_MODE=local`, `DATA_MODE=synthetic`, `CURRENCY_DEFAULT=COP`, `AI_ENABLED=false`, `JARVIS_INTEGRATION_ENABLED=false`. Variables ausentes usan defaults; valores vacíos o distintos fallan. Las variables de DB, bucket y token Jarvis heredadas del kit se rechazan incluso vacías. Otras variables del sistema se ignoran, no se registran ni habilitan capacidades.

## Primer incremento: «Gasté $45.000 COP en gasolina»

`npm.cmd run example:expense` ejecuta una composición sintética aislada: crea la categoría
Gasolina, registra un gasto el `2026-11-08`, reintenta la misma intención y consulta
su resultado y total mensual. Produce `sameFactOnRetry: true` y un total de
`{"minor":"4500000","currency":"COP"}`. Cada ejecución comienza con memoria vacía.
`npm start` conserva el bootstrap de Fase 0; no abre un servidor ni ejecuta ese ejemplo.

- **Dinero exacto:** `Money` utiliza `bigint` en centavos de COP; entrada canónica
  `"45000.00"`, sin separadores de miles. Rechaza negativos, formatos ambiguos y más
  de dos decimales; no redondea. Los gastos requieren importe positivo. Solo COP
  está implementada, sin cambio de divisas. JSON representa unidades menores como texto.
- **Categorías y gastos:** IDs estables, nombre explícito, categoría existente y fecha
  civil válida `YYYY-MM-DD`; sin inferencia de fecha, clasificación automática o parser de lenguaje natural.
  Registros inmutables; correcciones por anulación/reemplazo disponibles en SQLite.
  No se ofrece edición destructiva, borrado ni subcategorías.
- **Idempotencia:** clave estable por instancia/sujeto, huella SHA-256 de operación y
  campos normalizados, resultado original en reintentos y conflicto si cambia el contenido.
  Ante respuesta incierta se consulta `findIntent` con la misma clave. Otra clave representa
  otra intención, aunque el gasto sea igual; no hay deduplicación por importe/fecha.
- **Consulta:** `monthlyTotals` agrega consumo por mes y categoría, con filtro opcional.
  Un gasto es un solo hecho; no se suman caja y consumo. No se implementó una proyección de caja.
- **Límites:** contexto de actor/sujeto/instancia separado del payload, política inyectada
  y revalidada para cada acción, incluido reintento y lectura. La política del ejemplo
  es ficticia; no autentica usuarios reales. El adaptador de memoria es interno y debe
  usarse a través del servicio. No ofrece durabilidad ni atomicidad entre procesos.

[Informe del incremento, decisiones y evidencia](docs/reviews/PHASE1_EXPENSE_INCREMENT.md).

## Incremento SQLite: escribir, terminar el proceso y recuperar

[ADR-001 aprobado](docs/adr/001-persistence.md) el 2026-11-08 para una instancia
personal con datos sintéticos. Driver `node:sqlite` incorporado en Node 24.19.0;
motor observado SQLite 3.53.3. No se instalaron dependencias. La API síncrona mantiene
el puerto existente; el módulo tiene estabilidad *release candidate* en esta versión.
[Documentación de Node 24.19.0](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html).

```powershell
npm.cmd run example:sqlite
# Equivale a dos procesos separados:
node src/app/sqlite-expense-example.ts write
node src/app/sqlite-expense-example.ts read
# Pruebas de persistencia, concurrencia y respaldo:
node --test tests/sqlite-store.test.ts
```

El ejemplo usa exclusivamente `.cache/sqlite-example/synthetic.sqlite`, con fixture
fija de gasolina. Ambos procesos muestran el mismo movimiento y `4500000` centavos.
Reejecutarlo conserva IDs y total por las mismas claves. El modo `read` abre solo
lectura. Las pruebas generan bases aisladas en `.cache/sqlite-tests/store-*`; se
conservan, sin limpieza automática. `.cache/` y archivos SQLite están ignorados por Git.
El ejemplo no toma rutas ni credenciales de `.env`; `npm start` conserva el bootstrap.

`SqliteExpenseStore` aplica migración versionada al crear una base vacía; rechaza
bases ajenas, versiones desconocidas o esquema alterado. Comprueba checksum, SQL
del esquema, integridad, claves foráneas, huellas y correspondencia del resultado.
`facts` conserva categorías/gastos y `intents` su respuesta original; las relaciones
circulares diferidas impiden hechos sin intención. `BEGIN IMMEDIATE` hace commit
conjunto, con rollback ante fallo. `journal_mode=DELETE`, `synchronous=FULL` y claves
foráneas activas; triggers impiden actualización/borrado financiero.

Los importes permanecen como `TEXT` canónico; no hay sumas SQL ni conversión monetaria
a `number`. `Money`, `ExpenseService` y el adaptador en memoria no se modificaron.
`backupTo(destinoNuevo)` y `SqliteExpenseStore.restoreBackup(origen, destinoNuevo)`
usan `VACUUM INTO` y verifican el snapshot; nunca sobrescriben un destino existente.
La restauración abre el origen solo lectura. Si falla, el archivo parcial se conserva
y no se declara válido. No hay restauración ni copia de información real.

| Límite operativo | Comportamiento |
|---|---|
| Importe: 4096 dígitos de centavos; resultado: 32768 bytes | Exceso → `STORAGE_LIMIT`, sin truncar ni consumir intención |
| Archivo principal: 64 MiB | Límite al abrir y `max_page_count`; journal/copias/temporales requieren espacio adicional |
| Consulta: 10000 gastos por ámbito | Exceso → `STORAGE_LIMIT`; el puerto actual lista antes de filtrar por mes |
| Bloqueo: 1000 ms por defecto, configurable 0–5000 ms | `STORAGE_BUSY`; consultar misma intención y reintentar conservando clave |
| Corrupción / esquema incompatible | `STORAGE_CORRUPT` / `STORAGE_SCHEMA`, sin reparar ni regenerar hechos |

Otros errores explícitos: `STORAGE_IO`, `STORAGE_CLOSED`, `STORAGE_READ_ONLY` y
`STORAGE_DESTINATION_EXISTS`. Los errores no incluyen SQL, rutas o valores financieros.
La ruta de composición debe ser confiable y local; el adaptador no es una frontera
para recibir rutas de usuarios. Archivos nuevos usan modo `0600` donde el SO lo
aplica; ACL Windows, cifrado y protección ante administración privilegiada no están
certificados. La política de identidad sigue siendo una fixture, sin autenticación real.

[Informe SQLite, pruebas y limitaciones](docs/reviews/PHASE1_SQLITE_INCREMENT.md).

## Correcciones auditables: anular o reemplazar

`ExpenseCorrectionsService` usa el puerto extendido `ExpenseCorrectionStore`, implementado
por SQLite. Requiere política explícita `expense:correct`; la lectura usa `expense:read`.
`voidExpense(context, key, { expenseId, reason })` retira el gasto de los totales sin
borrarlo. `replaceExpense(context, key, { expenseId, reason, replacement })` exige
reemplazo completo con `amount`, `currency`, `categoryId`, `occurredOn` y lo registra
atómicamente junto con la anulación y la intención. No se usan gastos negativos.

`getExpenseHistory(context, expenseId)` devuelve el gasto original, estado
`active|voided|replaced`, el evento `correctedBy` y el vínculo `replaces` cuando el
gasto proviene de otro reemplazo. El evento incluye motivo, actor, timestamp UTC e
IDs. Solo el gasto vigente de una cadena contribuye a `monthlyTotals`. Una fecha
corregida mueve su contribución entre meses, sin borrar la fecha anterior del historial.

Misma clave y contenido devuelve el evento original. Mismo gasto corregido con otra
clave falla con `EXPENSE_ALREADY_CORRECTED`; misma clave con contenido distinto produce
`IDEMPOTENCY_CONFLICT`. Gasto inexistente/ajeno: `EXPENSE_NOT_FOUND`. Motivo o reloj
inválido: `INVALID_CORRECTION`. `findIntent` mantiene las respuestas antiguas y devuelve
también correcciones nuevas, sin reactivar gastos históricos.

La apertura con escritura migra v1–v5→v6 transaccionalmente; preserva datos y huellas
anteriores. La apertura solo lectura de v1 no migra. Mantener el binario actualizado
para bases v6: no hay downgrade. El adaptador en memoria conserva sus funcionalidades
previas y no implementa el puerto de correcciones.

```powershell
node --test tests/expense-corrections.test.ts
npm.cmd run check
```

Las fixtures se conservan en `.cache/correction-tests/`, con bases nuevas por ejecución.
No se migran archivos externos ni datos reales. [Informe completo](docs/reviews/PHASE1_EXPENSE_CORRECTIONS.md).

## Fase 1D: presupuestos mensuales y eventos internos

`MonthlyBudgetService` recibe el adaptador SQLite y la política de acceso. Las
fechas del gasto y el mes explícito determinan el periodo, sin usar el reloj para
inferirlo. Ejemplo dentro de una composición local con contexto sintético autorizado:

```typescript
const budgets = new MonthlyBudgetService(store, policy);
budgets.setBudget(context, 'budget-fuel-2026-11', {
  categoryId: fuel.id,
  month: '2026-11',
  amount: '100000.00',
  currency: 'COP',
});
const status = budgets.getBudgetStatus(context, {
  categoryId: fuel.id,
  month: '2026-11',
});
// status.budget, status.consumed, status.percentage, status.alerts
```

Importación: `src/application/monthly-budget-service.ts`. Se exige `budget:write`
para establecer/revisar y `budget:read` para consultar. El porcentaje es una fracción
exacta `{numerator: bigint, denominator: bigint}`; requiere serialización explícita
si en el futuro se transporta como JSON. No existe capa de transporte implementada.

Sin presupuesto: `budget=null`. Límite cero: presupuesto presente y porcentaje
`null`; no alerta con consumo cero y genera solo 100 % al existir consumo positivo.
No se arrastra saldo ni se crean límites del siguiente mes automáticamente.

Gastos, correcciones y ajustes evalúan consumo vigente en su misma transacción.
Los eventos de 80/100 se persisten como máximo una vez por categoría/mes; salto
directo genera solo 100 y suprime un 80 posterior. Se conservan aunque una corrección
reduzca el consumo. Cada evento vincula presupuesto evaluado, consumo e intención.
No son mensajes enviados ni crean gastos nuevos.

Una nueva clave añade una revisión del límite; un retry devuelve su revisión
original sin reactivarla. `findIntent` de presupuestos consulta solo presupuestos;
los servicios de gastos consultan gastos/categorías/correcciones. Comparten claves,
por lo que `undefined` en una consulta restringida no significa clave reutilizable.

Pendiente: definir orquestación de la revisión mensual (un mensaje al comenzar el
mes, últimos importes confirmados si no hay respuesta y ajustes conversacionales).
No hay scheduler, entrega de eventos ni integración con Jarvis.
[Informe completo y pruebas](docs/reviews/PHASE1_MONTHLY_BUDGETS.md).

## Fase 1E: consulta y reconocimiento de eventos

`EventDeliveryService` recibe el adaptador SQLite y la política de acceso; requiere
`event:read` y `event:ack` respectivamente. Su contrato local v1 reutiliza los IDs de
alertas existentes, mostrando solo tipo, ID, categoría, mes y umbral. No expone
importes ni nombres. No se ha cotejado con el protocolo de Jarvis.

```typescript
import { EventDeliveryService } from './src/application/event-delivery-service.ts';

const delivery = new EventDeliveryService(store, policy);
const page = delivery.listPending(context, { limit: 50 });
// Procesar y deduplicar duraderamente cada evento en el consumidor ANTES del ack.
// Tras confirmar ese procesamiento:
const receipt = delivery.acknowledge(context, { eventId: processedEvent.id });
// Repetir el mismo eventId devuelve el recibo original.
```

Ejemplo de llamadas, no un worker ejecutable. Cursor opcional `page.nextCursor`,
opaco y vinculado al ámbito; `null` termina el recorrido, no reconoce sus eventos.
Nuevos eventos posteriores al inicio aparecen en otro recorrido. Ante interrupción,
comenzar sin cursor recupera todo lo que siga pendiente. La consulta no reserva ni
marca eventos como procesados; no hay vencimientos de reservas que gestionar.

La entrega es **al menos una vez**: varios procesos pueden recibir lo mismo, y el
consumidor debe deduplicar por ámbito/ID. Solo su confirmación explícita crea el
reconocimiento durable. Este estado no prueba envío a Telegram ni lectura del usuario.
Una respuesta perdida después del commit se resuelve reintentando el mismo ID.

La migración v4 añade índice, metadatos de cursor y reconocimientos; conserva intactos
eventos y movimientos anteriores. El adaptador en memoria no incorpora este puerto.
No hay servidor, API, scheduler, cola externa, consumidor permanente ni canal.
[Contrato v1](docs/EVENT_DELIVERY_CONTRACT_V1.md) · [Informe](docs/reviews/PHASE1_EVENT_DELIVERY.md).

## Fase 1F: deuda financiada y pagos de cuotas

`FinancedDebtService` recibe SQLite, política de acceso y reloj opcional. Exige
`debt:write`, `debt:pay` o `debt:read`. Ejemplo con cifras exclusivamente ficticias
en una composición local autorizada:

```typescript
import { FinancedDebtService } from './src/application/financed-debt-service.ts';

const debts = new FinancedDebtService(store, policy);
const debt = debts.registerDebt(context, 'synthetic-iphone-opening', {
  description: 'iPhone ficticio',
  financedAmount: '4800000',
  installmentCount: 24,
  installmentAmount: '250000',
  referenceOn: '2026-11-01',
  referenceBalance: '4000000',
  historicalPaidInstallments: 8,
  historicalPaidAmount: '2000000',
}); // Tasa desconocida: no se inventa ni se trata como cero.

const payment = debts.confirmPayment(context, 'synthetic-iphone-payment-9', {
  debtId: debt.id,
  installmentNumber: 9,
  amount: '250000',
  paidOn: '2026-11-15',
  reference: 'synthetic-installment-9',
});
const status = debts.getDebt(context, debt.id);
const cash = debts.monthlyCashOutflow(context, { month: '2026-11' });
```

Resultado: 8 cuotas históricas sin caja actual; cuota 9 confirmada, 15 cuotas nominales
pendientes, saldo **estimado** de `3750000` COP y una sola salida de caja de `250000`
COP. Repetir la misma intención devuelve el mismo pago. No aumenta el consumo mensual,
no afecta presupuestos ni genera alertas. El dinero histórico no se resta otra vez
del saldo de apertura. No se inventa capital amortizado ni intereses pagados.

Los pagos parciales se vinculan a una cuota explícita. Excesos sobre saldo estimado
o remanente nominal de la cuota quedan `review_required`, persistidos sin descontar
saldo, generar caja ni repartir excedentes. `getDebt` incluye estos intentos con su
estado; `monthlyCashOutflow` incluye únicamente pagos confirmados de deuda, no es
un informe global de caja. Las fechas son civiles explícitas.

No hay borradores de pago: `confirmPayment` registra una confirmación ya obtenida por
la frontera autorizada. No ejecuta transferencias. Tasa E.A. y condiciones opcionales
se conservan sin amortización automática; la referencia textual no sustituye la clave
estable de idempotencia. Faltan conciliación y resolución asistida de revisiones.
Las correcciones auditables se describen abajo. No hay recordatorios.
[Informe completo](docs/reviews/PHASE1_FINANCED_DEBTS.md).

## Fase 1G: corregir un pago registrado por error

`DebtPaymentCorrectionsService` exige `debt:correct` para mutar y `debt:read` para
consultar. Con el pago sintético anterior de 250.000 COP:

```typescript
import { DebtPaymentCorrectionsService } from './src/application/debt-payment-corrections-service.ts';

const corrections = new DebtPaymentCorrectionsService(store, policy);
const correction = corrections.replacePayment(context, 'synthetic-correction-9', {
  paymentId: payment.id,
  reason: 'El importe registrado era incorrecto',
  replacement: {
    installmentNumber: 9,
    amount: '200000',
    currency: 'COP',
    paidOn: '2026-11-15',
    reference: 'synthetic-corrected-payment-9',
  },
});
const history = corrections.getPaymentHistory(context, payment.id);
```

Con saldo de referencia de 4.000.000 COP, queda **3.800.000 COP estimado** y caja
vigente de **200.000 COP**. El original permanece en auditoría con estado `replaced`;
el nuevo pago enlaza hacia él. La cuota 9 queda parcial con 50.000 COP nominales
pendientes. `voidPayment(context, key, {paymentId, reason})` retira un registro
equivocado sin crear reembolso ni movimiento negativo: no sirve para representar
una devolución bancaria real.

Los reemplazos se validan contra todos los otros pagos vigentes, incluidos los
posteriores. Si no caben en saldo/cuota, el evento queda `review_required` y el
original continúa vigente. Reintentos conservan el resultado original; solo una
corrección aplicada puede retirar cada pago. Se puede corregir su reemplazo vigente.

`getDebt.payments` conserva todos los registros históricos; `effectivePayments`
identifica los confirmados que contribuyen a saldo/cuotas/caja. Los recibos antiguos
conservan su `estimatedBalanceAfter` original, que no representa necesariamente el
saldo actual. Las consultas mensuales muestran caja vigente; no ofrecen consultas
«como se veía entonces». No se modifican consumo ni alertas de presupuesto.
[Informe completo](docs/reviews/PHASE1_DEBT_PAYMENT_CORRECTIONS.md).

## Estructura implementada y responsables

| Ruta | Contenido / propietario |
|---|---|
| `src/app/config.ts`, `src/app/main.ts` | Validación y composición local / coordinador |
| `src/domain/`, `src/application/`, `src/infrastructure/in-memory-expense-store.ts`, `src/app/expense-example.ts` | Dinero, gastos, servicio, puertos y simulador / coordinador |
| `tests/money.test.ts`, `tests/expenses.test.ts`, `tests/fixtures/expense-context.ts` | Pruebas del primer incremento / test_engineer |
| `src/infrastructure/sqlite-expense-store.ts`, `sqlite-errors.ts`, `migrations/001-expenses.ts`, `src/app/sqlite-expense-example.ts` | Persistencia, migración y ejemplo / coordinador |
| `tests/sqlite-store.test.ts`, `tests/fixtures/sqlite-worker.ts` | Pruebas SQLite y procesos independientes / test_engineer |
| `tests/*.test.ts`, `tests/fixtures/` | Configuración, proceso y ejemplo financiero sintético / coordinador |
| `package.json`, `package-lock.json`, `tsconfig*.json` | Scripts, versiones exactas y TypeScript estricto / coordinador |
| `eslint.config.js`, `.prettierrc.json`, `.npmrc`, `.env.example`, `.gitignore` | Herramientas y configuración segura / coordinador |
| `.github/workflows/local-checks.yml` | CI preparado, sin despliegue / coordinador |
| `docs/adr/` | SQLite aprobado; contrato Jarvis pendiente / coordinador |
| `docs/reviews/FINANCE_DOMAIN_REVIEW.md` | Invariantes y trazabilidad / finance_domain |
| `docs/reviews/TEST_MATRIX.md` | Matriz sintética y casos futuros / test_engineer |
| `docs/reviews/SECURITY_REVIEW.md` | Informe del revisor de solo lectura, documentado por coordinador |

En Fase 1 se delegaron revisión de dominio, pruebas y revisión de seguridad, sin propiedad compartida de archivos. El rol de seguridad declara sandbox de solo lectura y no realizó escrituras; su aplicación efectiva por el runtime no fue verificada. No se modificó la configuración de agentes.

No se crearon carpetas vacías para capas futuras. Las interfaces de red siguen pendientes.

## Evidencia ejecutada

Correcciones de pagos, 2026-11-15: `npm.cmd run format` y `npm.cmd run check`, salida
0: formato, lint sin warnings, typecheck, **170/170 pruebas aprobadas** (145 previas
+ 25 nuevas) y build. Caso 250.000→200.000, anulación, cadenas, cambios de fecha/cuota,
revisión por pagos posteriores, concurrencia, rollback, reinicio, restauración e
historia v5 conservada. Registro local: `.cache/debt-payment-corrections-check.log`.

Deudas financiadas, 2026-11-15: `npm.cmd run format` y `npm.cmd run check`, salida 0:
formato, lint sin warnings, typecheck, **145/145 pruebas aprobadas** (115 previas +
30 nuevas) y build. Caso iPhone 24/8, abonos, excesos en revisión, no duplicación
caja/consumo, concurrencia, rollback, respuesta perdida, reinicio, restauración,
migración v4→v5 e integridad semántica verificados. Registro en
`.cache/financed-debts-check.log`; fixtures sintéticas retenidas bajo `.cache/`.

Eventos, 2026-11-14: formato aplicado y `npm.cmd run check`, salida 0: formato,
lint sin warnings, typecheck, **115/115 pruebas aprobadas** (91 previas + 24 nuevas)
y build. Incluye paginación de 52 eventos, cursor inválido/ajeno, ACK idempotente,
procesos concurrentes, fallos pre/postcommit, recuperación, migración v3→v4 y copias
restauradas. Evidencia local en `.cache/event-delivery-check.log`.

Presupuestos, 2026-11-14: `npm.cmd run format` y `npm.cmd run check`, salida 0:
formato, lint sin warnings, typecheck, **91/91 pruebas aprobadas** (64 previas + 27
nuevas) y build. Se verificaron límites/consumos mayores de 64 bits, umbrales exactos,
correcciones, concurrencia entre procesos, rollback, reinicio, copias restauradas,
integridad y migración v2→v3. Evidencia local en `.cache/monthly-budgets-check.log`.

Correcciones, 2026-11-14: `npm.cmd run check`, salida 0: formato, lint, typecheck,
**64/64 pruebas aprobadas** (46 anteriores + 18 de correcciones) y build. Se probaron
anulación/reemplazo, periodos y categorías, cadenas, conflictos concurrentes entre
procesos, fallos transaccionales y de migración, reapertura, respaldo/restauración
de auditoría y conservación de filas/huellas v1. Evidencia anterior conservada debajo.

Incremento SQLite, 2026-11-08: `npm.cmd run check` terminó con código 0: formato,
lint, typecheck, **46/46 pruebas aprobadas** (26 previas + 20 SQLite) y build.
`npm.cmd run example:sqlite` terminó con código 0: dos procesos recuperaron el mismo
ID, importe y total. Prueba de respaldo/restauración: snapshot en archivo separado,
un evento posterior excluido, intervalo observado de 2.508 ms y recuperación completa
en 5.546 ms en esta ejecución local. Son mediciones sintéticas, no objetivos de servicio.

Primer incremento de Fase 1, 2026-11-08: `npm.cmd run check` terminó con código 0
(formato, lint, typecheck, **26 tests aprobados**, build); `npm.cmd run example:expense`
terminó con código 0 y total exacto `4500000` centavos, sin duplicación al reintentar.
Son 22 tests nuevos más los 4 existentes. No se instalaron ni actualizaron dependencias.

La siguiente evidencia corresponde al bootstrap anterior de Fase 0:

Scripts revisados antes de ejecución. Todos los comandos siguientes terminaron con código 0:

| Comando | Resultado |
|---|---|
| `npm.cmd install --ignore-scripts` | 98 paquetes de desarrollo instalados; lockfile generado |
| `npm.cmd run format` | Formato aplicado solo a código/configuración del bootstrap |
| `npm.cmd ci --ignore-scripts` | Reinstalación reproducible desde lockfile: 98 paquetes |
| `npm.cmd run check` | Formato, lint sin warnings, typecheck, 4 tests aprobados y build |
| `npm.cmd start` | Arranque del JavaScript compilado, mensaje local sintético, salida 0 |

`check` se ejecutó tanto tras instalar como tras reinstalar desde lockfile. CI remoto y ejecución en Linux **no verificados**. No se ejecutó auditoría de vulnerabilidades de dependencias; la revisión del lockfile no sustituye esa auditoría.

Test individual reproducible:

```powershell
node --test tests/domain-example.test.ts
```

Los cuatro tests cubren defaults/configuración explícita, rechazo de valores inválidos sin exponerlos, proceso real con salida exitosa/fallida y un ejemplo de suscripción compartida. Este último usa `bigint` por encima del límite exacto de `number`, unidades menores de COP (centavos) y división exacta: caja total = consumo propio + cuenta por cobrar, vinculados al mismo identificador sintético. No demuestra deduplicación transaccional ni implementa un ledger. No hay redondeo en este ejemplo; la política de residuos y redondeo del dominio sigue pendiente.

Versiones consultadas en npm antes de fijarlas: TypeScript 6.0.3, ESLint 10.14.0, typescript-eslint 8.72.1, Prettier 3.9.10 y @types/node 24.19.2. TypeScript 7.0.2 estaba publicado, pero fuera del rango soportado por typescript-eslint (<6.1.0); se eligió la versión compatible. La primera consulta falló por permisos de la caché global y se resolvió usando `.cache/npm`, sin elevar permisos.

## Salarios — Fase 1H

`SalaryService` permite `configureSalary`, `importPendingPeriod`, `closePeriod` y
`receivePayment`, con contexto autorizado y clave de intención por mutación.
`getReceivables({asOf})`, `getPayment(id)` y `monthlyCashInflow({month})` son consultas
explícitas. No se crea ingreso disponible al cerrar un mes ni al cargar pendientes.

Fixture reproducible en `tests/salary-receivables.test.ts`: salario neto
`"3000000"`, septiembre y octubre pendientes por `"3000000"` cada uno y abono
`"800000"` el `2026-11-15`. Resultado: una entrada de caja de $800.000 COP,
septiembre $2.200.000, octubre $3.000.000 y total pendiente $5.200.000. La respuesta
al registrar el abono no anuncia ese saldo; se obtiene por consulta posterior.
Reintentar conserva recibo y asignaciones originales.

Vigencias desde el día 1, sin prorrateo; vencimiento habitual día 5 siguiente,
vencido desde el 6 usando fecha de consulta explícita. Abonos excedentes quedan
registrados para revisión sin asignaciones/caja. Importar periodos antiguos después
de pagos o registrar abonos retroactivos tiene límites conservadores documentados.
No hay correcciones salariales, varios empleadores, scheduler ni recordatorios.

SQLite v7 añade tablas salariales sin reescribir el historial v1–v6; importes
textuales canónicos y cálculos `bigint`. Commit conjunto de recibo/asignaciones/
intención, snapshot de lectura y verificación de FIFO al reabrir. Sin dependencias
nuevas ni integraciones externas. [Informe](docs/reviews/PHASE1_SALARY_RECEIVABLES.md)
y [reglas](docs/PRODUCT_RULES.md).

Verificado el 2026-11-15: `npm.cmd run format` y `npm.cmd run check`, salida 0:
formato, lint, typecheck, **208/208 pruebas** (170 previas + 38 nuevas) y build.
Logs locales ignorados: `.cache/salary-receivables-format.log` y
`.cache/salary-receivables-check.log`. Las pruebas cubren FIFO, exceso, fechas,
importes mayores de 64 bits, reinicio, restauración, concurrencia, rollback,
migración e integridad.

## Gastos fijos y facturas — Fase 1I

`RecurringBillService` ofrece `createConcept`, `generateObligation`,
`adjustObligation` y `confirmPayment`, siempre con contexto autorizado y clave de
intención. Consultas: `getObligation`, `listObligations({asOf, conceptId?})`,
`monthlyCashOutflow({month})` y `findIntent`.

Cada concepto/mes tiene una obligación independiente. Sin importe conocido queda
desconocida; para conceptos variables se estima desde el último pago efectivo,
conservando la fuente. El importe real se confirma mediante una revisión auditable.
Solo se admiten pagos completos de una revisión confirmada y explícita.

**Decisión aprobada:** el consumo y presupuesto corresponden al mes del pago.
La factura conserva su mes facturado. Pago y gasto comparten ID: una sola salida
de caja, reutilizada en las proyecciones existentes y las alertas presupuestarias.
Obligaciones pendientes no crean gastos ni caja. No hay scheduler ni recordatorios.

Fixture verificada: internet de octubre pagado por $95.000 COP; noviembre por
$98.000 pendiente; diciembre estima $95.000 desde octubre. Confirmar y pagar
noviembre no modifica la estimación ni el estado de diciembre. Reintentos no
duplican obligaciones, pagos o alertas.

SQLite v8 añade tablas sin reescribir las versiones 1–7. La transacción reúne
pago, gasto, intenciones y alertas. Se bloquean ajustes después del pago y
correcciones aisladas del gasto vinculado hasta definir su corrección conjunta.
[Reglas](docs/PRODUCT_RULES.md) e [informe completo](docs/reviews/PHASE1_RECURRING_BILLS.md).

Verificado el 2026-11-16: `npm.cmd run format` y `npm.cmd run check`, salida 0;
formato, lint, typecheck, **246/246 pruebas** (208 previas + 38 nuevas) y build.
Logs locales: `.cache/recurring-bills-format.log` y `.cache/recurring-bills-check.log`.
Sin dependencias nuevas, integración externa ni habilitación de datos reales.

## Préstamos entre personas — Fase 1J

`PersonalLoanService` permite `createCounterparty`, `recordDisbursement` y
`recordRepayment`, con contexto autorizado y clave estable. Consultas:
`getPosition({counterpartyId,direction,asOf})`, `listPositions({asOf})`,
`monthlyCashFlow({month})` y `findIntent`.

`receivable` significa «me deben» y `payable`, «le debo». Se exige persona por ID
y dirección explícita; nombres iguales pueden pertenecer a personas diferentes.
No se compensan las dos posiciones. Desembolsos y abonos confirmados son hechos
únicos de capital/caja; no crean gastos, salario devengado ni alertas presupuestarias.

Fixtures verificadas: recibir $80.000 y devolver $30.000 deja $50.000 por pagar;
prestar $200.000, recibir $70.000 y prestar otros $50.000 deja $180.000 por cobrar.
Excesos quedan en revisión sin efecto parcial. Fechas retroactivas se comprueban
contra todo el historial para impedir saldos negativos intermedios.

SQLite v9 aditiva preserva el historial anterior. Movimiento, huella y resultado
original comparten transacción; replay no duplica caja. Los reportes son específicos
de préstamos: no se implementó un consolidado global. Sin intereses, recordatorios,
mensajes a terceros ni correcciones de capital en este incremento.
[Reglas](docs/PRODUCT_RULES.md) e [informe completo](docs/reviews/PHASE1_PERSONAL_LOANS.md).

Verificado el 2026-11-16: `npm.cmd run format` y `npm.cmd run check`, salida 0;
formato, lint, typecheck, **280/280 pruebas** (246 previas + 34 nuevas) y build.
Logs locales: `.cache/personal-loans-format.log` y `.cache/personal-loans-check.log`.
Sin dependencias nuevas, acceso externo ni datos reales.

## Pendientes y siguiente fase

- [ADR-001](docs/adr/001-persistence.md) aprobado e implementado para categorías/gastos sintéticos. Antes de un piloto faltan objetivos operativos de respaldo/retención, permisos y recuperación ante fallos físicos.
- [ADR-002](docs/adr/002-jarvis-contract.md): cotejo contractual y aprobación futura; el borrador no garantiza compatibilidad.
- El núcleo presupuestario usa fracciones exactas y meses civiles explícitos. Redondeo de presentación y orquestación del ciclo mensual siguen pendientes; no se habilita copia automática de límites.
- Fase 1 incluye préstamos entre personas; su cierre completo sigue pendiente. Siguiente incremento recomendado: correcciones auditables de movimientos de capital y resolución explícita de revisiones, validando movimientos posteriores. También siguen pendientes correcciones conjuntas de facturas/pagos y correcciones salariales, sin integrar bancos.
- Autenticación/autorización operativa, recibos privados, respaldo/restauración de información real, datos reales y despliegue siguen pendientes. La idempotencia y recuperación verificadas aquí son locales con fixtures; no certifican producción.
- CI usa tags de acciones y la línea Node 24: posible deriva de versiones; no fue ejecutado remotamente. `.gitignore` no es un control de acceso ni garantiza ausencia de secretos.

## Fuentes de verdad

[Reglas](docs/PRODUCT_RULES.md) · [Referencia histórica](docs/REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md) · [Arquitectura](docs/ARCHITECTURE.md) · [Seguridad](docs/SECURITY.md) · [Roadmap](docs/ROADMAP.md) · [Workflow](docs/CODEX_WORKFLOW.md).

Licencia pendiente. No es un producto oficial relacionado con Los Simpson ni usa marcas gráficas ajenas.
