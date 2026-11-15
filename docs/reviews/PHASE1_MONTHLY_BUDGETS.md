# Fase 1D — Núcleo de presupuestos mensuales

Fecha: 2026-11-14. Alcance aprobado: presupuestos por categoría/mes, consumo vigente
y eventos internos de alerta persistidos en SQLite, exclusivamente con datos
sintéticos. **La Fase 1 completa permanece abierta.**

## Implementado

- Establecer límites COP por instancia, sujeto, categoría y mes civil explícito.
- Conservar revisiones append-only y recuperar la última confirmada como vigente.
- Consultar presupuesto, consumo, porcentaje exacto y eventos en un mismo snapshot.
- Proyectar consumo desde gastos vigentes; anulación y reemplazo afectan las
  categorías/meses indicados por las fechas civiles, sin doble contabilización.
- Persistir eventos únicos de 80/100 % con presupuesto evaluado, consumo, ID e
  intención que los originó. No se envían notificaciones.
- Reintentar con la misma clave/payload devuelve el presupuesto original; una
  clave con contenido u operación distintos genera `IDEMPOTENCY_CONFLICT`.
- Migrar v1/v2 a v3 preservando hechos, correcciones, claves, huellas y respuestas.
- Conservar presupuestos y eventos tras reinicio y restauración en otro archivo.

No hay saldo trasladado ni presupuesto implícito para el siguiente mes. Establecer
un límite no crea movimientos financieros. Los cálculos representan consumo; no
crean proyecciones nuevas de caja ni obligaciones pendientes.

## Reglas y decisiones concretas

`MonthlyBudgetService.setBudget(context, key, {categoryId, month, amount, currency?})`
valida COP (predeterminada), importe decimal canónico, categoría existente y mes
`YYYY-MM`. `getBudgetStatus(context, {categoryId, month})` devuelve `budget`,
`consumed`, `percentage` y `alerts`. `findIntent(context, key)` permite recuperar
la revisión original de presupuesto. Se exige `budget:write` o `budget:read` según
la operación, vinculando identidad fuera del payload y revalidando antes del replay.

Una nueva intención del mismo periodo añade una revisión, sin destruir anteriores.
Prevalece la última escritura confirmada bajo el bloqueo SQLite; no se ofrece CAS
ni control de edición basado en una versión esperada. Reintentar una revisión antigua
no la reactiva. Ajustar un límite evalúa el consumo que ya existe: puede generar
una alerta inmediatamente. No modifica otros periodos.

El usuario confirmó expresamente: presupuesto cero y consumo cero no alertan;
consumo positivo sobre presupuesto cero genera solo 100 %. Sin presupuesto se
devuelve `budget=null`, mientras que cero conserva un presupuesto identificado.
En ambos casos el porcentaje es `null`. Para límites positivos, el porcentaje es
la fracción exacta `{numerator: consumo * 100n, denominator: límite}`. No hay
conversiones monetarias a `number`, sumas SQL ni redondeo para decidir umbrales.
La futura presentación deberá serializar los `bigint` y definir su formato visual.

Los umbrales se comparan con enteros: igualdad al 80/100 cuenta. Si una operación
alcanza ambos, solo se crea 100 %. Un 100 % ya persistido suprime un posterior 80 %
para la misma categoría/mes. El descenso de consumo por correcciones o el aumento
del límite no retira eventos; tampoco permite repetirlos al volver a cruzar.
Cada mes tiene su propio conjunto de eventos. Una corrección se evalúa después de
aplicar todos sus efectos, sin contabilizar transitoriamente original y reemplazo.

## Persistencia y aislamiento

La migración 003 añade `budgets` (revisiones) y `budget_alerts`. Reconstruye `intents`
copiando las columnas anteriores sin modificar sus valores y añade `budget_id`.
Este campo es exclusivo de `fact_id`/`correction_id`; FK compuestas recíprocas ligan
presupuesto e intención. Se mantienen los triggers históricos de correcciones y
correspondencia hecho/intención. Las migraciones 001 y 002 no cambian.

La revisión vigente se obtiene por secuencia de inserción dentro de su ámbito,
categoría y mes. Los importes se guardan como texto canónico hasta 4096 dígitos;
la secuencia es un orden de revisiones, nunca una cantidad monetaria. Los eventos
conservan consumo agregado como texto y referencian la revisión histórica evaluada.
Los límites existentes de tamaño de base y filas consultadas siguen vigentes.

Gastos, correcciones y presupuestos se escriben bajo `BEGIN IMMEDIATE`. Su intención
se inserta antes de evaluar alertas y todo se confirma junto. Un error al crear el
evento revierte la mutación financiera y su intención. Unicidad por instancia,
sujeto, categoría, mes y umbral más serialización de escritores evita duplicados
entre conexiones/procesos. Los errores de bloqueo, límites y corrupción siguen
siendo explícitos, con los códigos del adaptador existente.

Los triggers impiden UPDATE/DELETE de revisiones y eventos. FK preservan ámbito y
categoría/mes del presupuesto. Al abrir se verifican esquema, checksums, FK,
respuestas y huellas; cada alerta se valida contra su presupuesto histórico y el
umbral alcanzado. Esto detecta inconsistencias, no constituye firma antifraude
frente a un administrador capaz de alterar coherentemente todo el archivo.

Apertura en escritura migra hasta v3; solo lectura permite v1/v2 sin migrar, con
consumo existente y presupuesto ausente. Los binarios anteriores rechazan v3 y no
hay downgrade. Se conservan driver `node:sqlite`, dependencias, lockfile y adaptador
en memoria anteriores; este último no incorpora capacidades de presupuestos.

## Verificación realmente ejecutada

Coordinador: `npm.cmd run format` y `npm.cmd run check` terminaron con **código 0**.
El último comando ejecutó formato, ESLint sin warnings, TypeScript, **91/91 tests**
y build. Evidencia local: `.cache/monthly-budgets-check.log` (ignorada por Git).

Son **64 pruebas anteriores + 24 de presupuestos + 3 de migración/integridad**.
También se ejecutaron por separado las 18 de correcciones y las 3 de migración.
La primera construcción de la fixture v2 falló por insertar gastos antes de su
categoría; se corrigió el orden de la fixture y los tres casos pasaron. No se
relajaron claves foráneas del adaptador para resolver esa prueba.

| Área | Evidencia sintética aprobada |
|---|---|
| Dominio y límites | Sin presupuesto/cero/positivo, categorías y meses independientes, sin arrastre, validación y exceso de tamaño |
| Precisión | Fracciones periódicas exactas, límites y consumo superiores a 64 bits, bordes inmediatamente antes/en/después del umbral |
| Alertas | Exactamente 80 y 100, salto directo, gastos posteriores, supresión de 80 tardío, meses nuevos |
| Revisiones e idempotencia | Presupuesto tardío, ajustes, replay de revisión anterior, conflicto de payload y entre operaciones |
| Correcciones | Anulación, reemplazo, cambio de categoría/fecha, mismo periodo sin doble conteo, rebotes sin repetir eventos |
| Permisos | Revocación antes de replay, contexto ajeno, aislamiento instancia/sujeto, lectura restringida por dominio |
| Rollback | Fallos tras presupuesto y tras alerta; revierte presupuesto, gasto o corrección/reemplazo e intención; retry válido |
| Procesos | Misma intención devuelve una identidad, intenciones incompatibles conflictúan, dos gastos cruzan umbrales únicos; recuperación al terminar procesos |
| Reinicio/copias | Reapertura y copia restaurada conservan presupuestos, eventos, vínculos de corrección y claves |
| Migración | v2 con reemplazo y anulación, solo lectura, rollback de migración, igualdad de filas y respuestas antiguas tras v3 |
| Integridad | Append-only, unicidad, FK por ámbito, presupuesto o consumo de alerta alterados rechazados al abrir |

Fixtures conservadas bajo `.cache/budget-tests/` y `.cache/budget-migration-tests/`;
no se borraron ni restauraron datos reales. Comandos dirigidos reproducibles:

```powershell
node --test tests/monthly-budgets.test.ts tests/monthly-budget-migration.test.ts
npm.cmd run check
```

## Archivos y coordinación

| Propietario | Archivos / responsabilidad |
|---|---|
| finance_domain | `src/domain/monthly-budgets.ts`, `src/application/monthly-budget-store.ts`, `src/application/monthly-budget-service.ts` |
| Coordinador | `src/application/expense-store.ts`, `expense-service.ts`, `expense-corrections-service.ts` |
| Coordinador | `src/infrastructure/sqlite-expense-store.ts`, `migrations/003-monthly-budgets.ts` |
| test_engineer | `tests/monthly-budgets.test.ts`, `tests/fixtures/budget-worker.ts` |
| Coordinador | `tests/monthly-budget-migration.test.ts`, versión esperada en `tests/expense-corrections.test.ts` |
| Coordinador | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/adr/001-persistence.md`, este informe |
| security_reviewer | Revisión específica en lectura de permisos, migración, aislamiento y transacciones |

No hubo escrituras simultáneas en rutas compartidas. El especialista de dominio
entregó su código y verificaciones focalizadas; al recibir la tarea adicional de
migración alcanzó su límite de uso y el coordinador la asumió. El especialista de
pruebas aportó los escenarios independientes y el coordinador ejecutó la suite final.

Seguridad detectó durante el diseño que el namespace compartido podía permitir
leer presupuestos con permiso de gastos o a la inversa. Los servicios filtran ahora
resultados por dominio y existe una regresión bidireccional. `undefined` en estas
consultas restringidas no asegura que una clave esté libre; no se debe regenerar
una intención por incertidumbre. No se identificaron bloqueantes restantes en la
revisión estática. El revisor no ejecutó pruebas ni escrituras; la aplicación
efectiva de su sandbox de solo lectura no está certificada. No fue auditoría general.

## Pendientes y limitaciones

- **Simulado:** identidad/autorización de fixtures. No hay autenticación operativa,
  binding con Jarvis ni aprobación para datos reales.
- **Pendiente:** revisión mensual automática: un mensaje al comenzar el mes,
  reutilización de últimos importes confirmados si no hay respuesta y ajustes
  conversacionales. Hay que definir iniciador, calendario/zona horaria, plazo,
  confirmación y claves de intención/entrega antes de programarla. Copiar límites
  no significa arrastrar saldo; nada de esto se ejecuta automáticamente hoy.
- Los eventos se consultan por categoría/mes. No hay feed paginado, entrega,
  acknowledgements, reintentos de canal, scheduler ni integración con Jarvis.
  Tienen identidad y causa financiera, pero no timestamp propio de entrega.
- No hay eliminación de un presupuesto ya establecido ni consultas temporales
  «como se veía entonces». Las revisiones se recuperan por su clave original;
  listado paginado de revisiones e historial queda pendiente.
- Heredan límites y costos de verificación del adaptador local. No se midió carga
  masiva ni se verificaron cortes eléctricos, ACL de Windows, Linux o CI remoto.
  Los resultados sintéticos no certifican una operación productiva.
- No se añadieron dependencias, deudas, salarios, suscripciones, IA, canales,
  despliegues, infraestructura, commits ni PR.

Siguiente incremento recomendado: consulta paginada de eventos internos y diseño
del contrato de entrega/confirmación idempotente con pruebas sintéticas. Definir
orquestación antes de habilitar revisión mensual o mensajes reales. La Fase 1 no
se declara terminada.
