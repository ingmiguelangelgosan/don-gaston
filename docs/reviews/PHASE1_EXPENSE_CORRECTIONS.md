# Fase 1 — Correcciones auditables de gastos

Fecha: 2026-11-14. Alcance aprobado expresamente: anulación y reemplazo de gastos
con SQLite y datos sintéticos. La Fase 1 completa permanece abierta.

## Resultado implementado

- Anular un gasto vigente mediante intención explícita, con motivo obligatorio.
- Reemplazar importe, categoría o fecha mediante un evento y un nuevo gasto positivo.
- Conservar originales, eventos, actor, motivo, instante UTC y vínculos en ambos sentidos.
- Actualizar totales mensuales/categoría para contar únicamente gastos vigentes.
- Idempotencia durable en el mismo namespace de categorías/gastos; conflictos entre
  operaciones o contenido distinto y exclusión de dos correcciones sobre el mismo gasto.
- Migración v1→v2 compatible con filas, claves, IDs, huellas y respuestas históricas.
- Recuperación tras reapertura y respaldo/restauración con vínculos de auditoría intactos.

Ejemplo: un gasto de gasolina de `45000.00` COP en noviembre puede sustituirse por
`40000.00` COP en octubre. El original sigue consultable; el total vigente de noviembre
deja de incluir sus `4500000` centavos y octubre incluye `4000000`. El evento registra
cuándo y por qué se corrigió, independientemente de la fecha financiera de ambos gastos.
No se registran importes negativos, reembolsos ni nuevos flujos de caja por anular.

Las consultas mensuales muestran el estado vigente incluso para meses anteriores;
no implementan consultas temporales «como se veía entonces». Una cadena permite
corregir el reemplazo vigente; no permite corregir nuevamente un original ya retirado.

## API y reglas

`ExpenseCorrectionsService` recibe `ExpenseCorrectionStore`, política de acceso y un
reloj UTC opcional inyectado (por defecto `new Date().toISOString()`). La aplicación
exige `expense:correct` para mutaciones y `expense:read` para historial/intenciones.
Actor, sujeto e instancia se validan desde un snapshot externo al payload; el reloj
tampoco se recibe como campo editable de la intención financiera.

| Operación | Entrada / resultado |
|---|---|
| `voidExpense(context, key, {expenseId, reason})` | Evento sin reemplazo; original queda `voided` |
| `replaceExpense(context, key, {expenseId, reason, replacement})` | Reemplazo completo: importe, moneda COP explícita, categoría y fecha civil; original queda `replaced` |
| `getExpenseHistory(context, expenseId)` | Gasto, estado vigente, `correctedBy` y `replaces` |
| `findIntent(context, key)` | Resultado original de categoría, gasto o corrección |

El motivo normalizado con trim debe tener 1–500 caracteres y no contener controles
internos. El instante debe ser UTC ISO canónico con milisegundos. La fecha financiera
del reemplazo se valida con las reglas civiles existentes. El dinero sigue en `Money`
con `bigint`; centavos canónicos en SQLite, sin sumas monetarias SQL ni conversiones
monetarias a `number`. Los límites operativos de persistencia anteriores se mantienen.

La huella nueva incluye operación versionada (`expense:void:v1` o `expense:replace:v1`),
target, motivo y campos canónicos del reemplazo. Excluye IDs generados, reloj y actor:
un reintento autorizado devuelve los valores originales, sin reescribir su auditoría.
Las huellas históricas `category:v1` y `expense:v1` y sus JSON permanecen iguales.

Se resuelve replay antes de exigir que el target siga vigente. Reintentar el alta
original devuelve el gasto histórico, pero no lo reactiva. Otra intención sobre un
target ya corregido produce `EXPENSE_ALREADY_CORRECTED`; misma clave con otro contenido
produce `IDEMPOTENCY_CONFLICT`. Target inexistente o de otro ámbito produce
`EXPENSE_NOT_FOUND`, sin revelar existencia ajena.

## Persistencia, migración y atomicidad

La migración 001 no se modifica. La 002 añade `corrections` y amplía `intents` con
`correction_id`; `fact_id` admite NULL para anular sin crear un gasto. Para reemplazar,
el nuevo gasto usa la clave de esa misma corrección. Original y reemplazo tienen
identidades distintas; `facts` no se actualiza ni se borra.

La reconstrucción de `intents` copia las columnas previas exactamente dentro de una
transacción. Se verifica v1 antes del cambio, v2 antes del commit y se comprueban claves
foráneas, esquema, checksums, importes, huellas y resultados. La aplicación desactiva
enforcement FK solo para esa reconstrucción y lo restablece al salir; un fallo revierte
esquema, datos y versión. No se usa `writable_schema` ni reparación automática.
La técnica sigue el [procedimiento de reconstrucción de SQLite](https://www.sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes).

Abrir con escritura migra una base v1 válida a v2. Solo lectura puede consultar una
base v1 sin migrarla. El binario previo rechaza v2; no hay downgrade implementado.
Solo se ejercitaron archivos sintéticos, sin migración productiva.

Las correcciones se aplican bajo `BEGIN IMMEDIATE`. Evento, reemplazo opcional, huella
y respuesta original se confirman juntos. Una restricción única sobre instancia,
sujeto y gasto original impide dos correcciones aplicadas; FK y triggers aseguran
correspondencia con intención y reemplazo. Triggers append-only protegen los eventos
y las tablas financieras existentes.

Los lectores usan un snapshot para recuperar intención e historial; así no pueden
mezclar una ausencia de evento previa al commit con un reemplazo visible después.
La consulta de totales excluye mediante `NOT EXISTS` los gastos que son target de una
corrección. Los reemplazos posteriormente corregidos también quedan excluidos.

## Revisión específica y hallazgo resuelto

Dominio revisó exactitud, periodo, replay y vigencia. Se incorporó su observación de
exigir moneda explícita en reemplazos; el alta antigua conserva COP por defecto.

Seguridad identificó por inspección un caso SQL que no generaba el servicio: la FK
heredada de `facts` validaba ámbito/clave, pero una intención de anulación con
`fact_id=NULL` podía admitir un hecho asociado no visible en los JOIN. Se cerró con:

- Trigger de INSERT de hecho que comprueba el ID referido por una intención existente.
- Trigger de INSERT de intención que comprueba cualquier hecho previo con esa clave.
- Verificación explícita de hechos sin correspondencia por ámbito, clave e ID al abrir.
- Regresión sintética para ambos órdenes de inserción, con rollback y reapertura.

La prueba pasa y comprueba que no se introduce un gasto oculto. No se presentó ese
caso como acceso remoto o bypass de permisos del servicio. La revisión se limitó al
delta de este incremento; no se realizó una auditoría integral.

## Pruebas ejecutadas

Coordinador: `npm.cmd run check` final terminó con **código 0**:

- Prettier: formato correcto.
- ESLint: sin warnings.
- TypeScript: typecheck correcto.
- **64/64 pruebas aprobadas: 46 previas y 18 de correcciones.**
- Build TypeScript correcto.

Antes de la integración, el especialista reportó 16 pruebas nuevas aprobadas y
typecheck correcto; el coordinador completó su última edición y añadió dos regresiones.
La suite integrada se repitió tras corregir el hallazgo SQL, por existir un cambio de
esquema y una nueva prueba. No se repitió una auditoría general.

Cobertura nueva:

| Área | Evidencia sintética |
|---|---|
| Anulación / historial | Original consultable, motivo/actor/instante, total sin original, replay de alta no reactiva |
| Reemplazo | Monto superior a 64 bits, categoría nueva, fecha de otro mes/año, solo reemplazo contabilizado |
| Cadenas | Corrección del reemplazo vigente y conservación de ambos vínculos |
| Idempotencia | Replay tras cambiar reloj, contenido/operación distinto en misma clave, target ya corregido |
| Validación | Motivo/instante inválidos, monto cero, moneda omitida, categoría ausente y exceso de tamaño no consumen intención |
| Permisos / ámbito | Acción explícita, revocación antes de replay, payload de identidad rechazado, sujeto/instancia ajenos |
| Rollback | Fallo después del evento y después del reemplazo; original vigente, sin intención parcial, retry con misma clave |
| Concurrencia | Dos procesos coordinados: mismo contenido produce un evento/ID; operaciones incompatibles producen ganador y conflicto |
| Reinicio | Proceso escritor termina; otra conexión recupera auditoría, claves y totales; cierre/reapertura de cadenas |
| Copias | Snapshot restaurado en otro archivo conserva original, reemplazo, vínculos, respuesta idempotente y total |
| Integridad | Triggers append-only, auditoría alterada rechazada, anulación no admite hecho oculto |
| Migración v1 | Filas de facts y columnas históricas de intents iguales antes/después; rollback inyectado devuelve versión 1; lectura v1 sin migrar |

Fixtures de la ejecución final: `.cache/correction-tests/corrections-ietq5i`.
Se conservan sin limpieza automática y están ignoradas por Git. Las mediciones de
backup previas siguen siendo sintéticas; no se anuncia un RPO/RTO de producción.

Comandos reproducibles:

```powershell
node --test tests/expense-corrections.test.ts
npm.cmd run check
```

## Archivos y responsables

| Responsable | Archivos / entrega |
|---|---|
| Coordinador | `src/domain/expense-corrections.ts` |
| Coordinador | `src/application/expense-correction-store.ts`, `expense-corrections-service.ts`, `expense-store.ts` |
| Coordinador | `src/infrastructure/sqlite-expense-store.ts`, `migrations/002-expense-corrections.ts` |
| test_engineer, luego coordinador | `tests/expense-corrections.test.ts`, `tests/fixtures/correction-worker.ts` |
| Coordinador | `docs/PRODUCT_RULES.md`, `docs/ROADMAP.md`, `docs/adr/001-persistence.md`, `README.md`, este informe |
| finance_domain | Revisión de invariantes y aplicación, sin escrituras |
| security_reviewer | Revisión del delta, aislamiento/atomicidad/esquema, sin escrituras |

El especialista de pruebas alcanzó su límite de uso después de reportar resultados;
el coordinador asumió los archivos pendientes y ejecutó la verificación final. No
hubo escritura simultánea sobre archivos compartidos. La revisión de seguridad se
retomó con un revisor del mismo rol, únicamente en lectura. La aplicación efectiva
del sandbox de solo lectura no pudo certificarse; no se fingió ese control.

`Money`, reglas de alta, adaptador en memoria, migración 001, dependencias y lockfile
no se modificaron. El puerto base amplía la unión de respuestas y declara que la lista
para totales representa gastos vigentes; el puerto nuevo requiere capacidades de
corrección que solo implementa SQLite. No se crearon commits/PR ni se desplegó.

## Límites y pendientes

- **Simulado:** identidad y política de autorización. La autenticación operativa y
  el binding del contexto siguen pendientes; no se conectó Jarvis.
- Auditoría append-only bajo las restricciones del adaptador/esquema. No protege
  contra un administrador que modifique coherentemente archivo, esquema y huellas.
- El timestamp proviene del reloj de aplicación; no hay firma temporal externa ni
  garantía frente a un reloj del host incorrecto.
- Los totales son vigentes. Consultas temporales, listado paginado de historial y
  recorrido completo de cadenas en una llamada siguen pendientes; pueden recorrerse
  los vínculos mediante consultas por ID.
- Límites de tamaño, bloqueo, permisos de archivos y backup del incremento SQLite
  anterior siguen aplicando. No se verificaron cortes eléctricos, ACL Windows, Linux,
  CI remoto ni operación real. No se realizó auditoría ajena al cambio.
- Solo COP; no se añadieron presupuestos, deudas, salarios, suscripciones, IA,
  Telegram, servicios financieros externos o datos reales.

Siguiente incremento recomendado: consulta paginada del historial y recorrido de
cadenas auditables, con fixtures y permisos existentes. No requiere iniciar nuevos
módulos financieros. La Fase 1 permanece abierta.
