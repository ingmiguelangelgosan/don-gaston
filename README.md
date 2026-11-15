# Don Gastón — agente financiero independiente

**Estado: Fase 1D, núcleo de presupuestos mensuales implementado y verificado localmente el 2026-11-14.** Categorías, gastos, correcciones auditables, presupuestos y eventos internos de alerta con SQLite aislado e idempotencia durable, exclusivamente con datos sintéticos. Se conserva el adaptador en memoria para el flujo previo. La Fase 1 completa sigue abierta; no existe API ni conexión con Sir Jarvis. Sin commits ni PR en este incremento.

Don Gastón es propietario de las reglas financieras; Sir Jarvis conserva canales, identidad conversacional, orquestación y confirmaciones. Solo el alcance descrito aquí está implementado; las demás reglas de producto siguen siendo requisitos. La referencia histórica se conserva sin cambios.

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

La apertura con escritura migra v1/v2→v3 transaccionalmente; preserva datos y huellas
anteriores. La apertura solo lectura de v1 no migra. Mantener el binario actualizado
para bases v3: no hay downgrade. El adaptador en memoria conserva sus funcionalidades
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

## Pendientes y siguiente fase

- [ADR-001](docs/adr/001-persistence.md) aprobado e implementado para categorías/gastos sintéticos. Antes de un piloto faltan objetivos operativos de respaldo/retención, permisos y recuperación ante fallos físicos.
- [ADR-002](docs/adr/002-jarvis-contract.md): cotejo contractual y aprobación futura; el borrador no garantiza compatibilidad.
- El núcleo presupuestario usa fracciones exactas y meses civiles explícitos. Redondeo de presentación y orquestación del ciclo mensual siguen pendientes; no se habilita copia automática de límites.
- Fase 1 tiene gastos, correcciones y núcleo de presupuestos SQLite; su cierre completo sigue pendiente. Siguiente incremento propuesto: consulta paginada de eventos internos con un contrato de entrega/confirmación idempotente, todavía con fixtures y sin conectar canales.
- Autenticación/autorización operativa, recibos privados, respaldo/restauración de información real, datos reales y despliegue siguen pendientes. La idempotencia y recuperación verificadas aquí son locales con fixtures; no certifican producción.
- CI usa tags de acciones y la línea Node 24: posible deriva de versiones; no fue ejecutado remotamente. `.gitignore` no es un control de acceso ni garantiza ausencia de secretos.

## Fuentes de verdad

[Reglas](docs/PRODUCT_RULES.md) · [Referencia histórica](docs/REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md) · [Arquitectura](docs/ARCHITECTURE.md) · [Seguridad](docs/SECURITY.md) · [Roadmap](docs/ROADMAP.md) · [Workflow](docs/CODEX_WORKFLOW.md).

Licencia pendiente. No es un producto oficial relacionado con Los Simpson ni usa marcas gráficas ajenas.
