# Fase 1E — Consulta y reconocimiento durable de eventos

Fecha: 2026-11-14. Alcance: núcleo local de consulta paginada y seguimiento de
procesamiento, exclusivamente con fixtures sintéticas. **La Fase 1 completa sigue
abierta.** No se conectó Sir Jarvis, Telegram ni ningún servicio externo.

## Resultado implementado

- Consulta de alertas pendientes de presupuesto con orden determinista, páginas
  limitadas y cursor opaco autenticado/cifrado, aislada por instancia/sujeto.
- Contrato local v1 y permisos específicos `event:read` / `event:ack`.
- Reutilización de los IDs persistentes de las alertas existentes, sin regenerarlos.
- Reconocimiento durable, transaccional e idempotente por ámbito/evento; conserva
  el recibo original y auditoría del primer actor e instante aceptados.
- Recuperación tras interrupción, reinicio o respuesta perdida después del commit.
- Migración v4 aditiva que conserva hechos, intenciones, presupuestos, correcciones
  y eventos históricos sin modificarlos.

`EventDeliveryService.listPending(context, {limit?, cursor?})` devuelve versión,
eventos y `nextCursor`. `acknowledge(context, {eventId})` devuelve versión, ID,
estado `processed` y `processedAt`. El contexto se vincula fuera del payload y se
revalida en cada operación, incluso antes del replay. Una consulta no reserva ni
reconoce ningún evento.

La respuesta mínima de evento contiene solo `version`, `type`, `id`, `categoryId`,
`month` y `threshold`. No contiene importes, nombres, actor financiero, ID de
presupuesto ni clave de intención. Categoría, mes y umbral siguen siendo privados;
esta minimización no convierte el feed en información pública.

Especificación completa: [contrato local v1](../EVENT_DELIVERY_CONTRACT_V1.md).
Es un contrato de Don Gastón, **no compatibilidad comprobada con Jarvis**.

## Paginación y recuperación

El tamaño predeterminado es 50, con límite entero entre 1 y 100. La primera página
fija el límite superior de secuencia en un snapshot. Las siguientes avanzan por
clave, sin offsets. Nuevos eventos posteriores a ese límite aparecen al iniciar
otro recorrido. Los reconocimientos se filtran en cada lectura: si otro consumidor
reconoce un evento, desaparece de pendientes sin desplazar posiciones posteriores.

El índice persistido ordena las alertas históricas por instancia, sujeto, categoría,
mes, umbral e ID; este orden no afirma una hora de creación histórica. Las alertas
nuevas reciben secuencia `AUTOINCREMENT` al insertarse. Las secuencias se trasladan
como texto/`bigint` internamente, sin convertirlas a números inseguros de JavaScript.

El cursor v1 usa AES-256-GCM con clave de 32 bytes generada con `node:crypto`,
persistida en la base durante la migración. Vincula ámbito, posición, límite e IDs
de anclaje. Se validan formato canónico, tamaño máximo de 2048 caracteres,
autenticidad, ámbito y existencia de ambas anclas. No contiene datos financieros
en claro ni concede autorización. No hay rotación o expiración de cursor en este
incremento; base y copias necesitan protección operativa antes de datos reales.

Repetir un cursor puede devolver eventos repetidos si siguen pendientes. Un
recorrido que avanza normalmente no repite IDs; **el cursor no es un checkpoint
de procesamiento**. `nextCursor=null` solo significa fin del recorrido. Un evento
consultado y no reconocido permanece pendiente y vuelve a aparecer en un nuevo
recorrido sin cursor. Ese es el procedimiento de recuperación recomendado después
de interrupciones o restauraciones.

Las copias conservan clave, índices y reconocimientos. Se rechaza un cursor cuya
posición se haya reutilizado con otro ID en una historia divergente tras restaurar.
Un respaldo anterior a un reconocimiento puede hacer reaparecer el pendiente:
el consumidor debe conservar su propia deduplicación.

## Semántica de reconocimiento

Hay un consumidor lógico por instancia/sujeto y pueden existir varios procesos
autorizados actuando por él. No se añadieron suscriptores independientes ni reservas
temporales, por lo que no hay leases que vencer o recuperar.

La clave natural de idempotencia es `(event:ack:v1, instancia, sujeto, eventId)`.
El único payload variable es el ID; no se permite una clave arbitraria distinta
en cada reintento. Una PK por ámbito/evento y `BEGIN IMMEDIATE` hacen que dos
procesos obtengan un solo recibo original, incluso con actores/relojes distintos.
Un ID ajeno o inexistente produce `EVENT_NOT_FOUND` sin revelar existencia externa.

La inserción conserva el primer actor autorizado y timestamp UTC de la aplicación;
el recibo público no expone actor. El timestamp significa instante del reconocimiento
aceptado, no instante verificable de procesamiento externo. Los recibos son
append-only. No se modifica el evento financiero ni se altera el consumo.

La entrega puede ser **al menos una vez**. El consumidor deberá procesar y deduplicar
duraderamente por ámbito/ID antes de reconocer. Si falla antes del reconocimiento,
el evento sigue pendiente; si falla dentro de la transacción, hay rollback. Si se
confirma pero se pierde la respuesta, repetir el mismo ID devuelve el recibo
original. No se promete exactamente una vez ni se demuestra entrega al usuario.
El núcleo acepta la declaración explícita del consumidor autorizado; `processed`
no significa mensaje enviado, leído ni entregado a Telegram.

## Persistencia y migración

`004-event-delivery.ts` añade tres tablas:

| Tabla | Función |
|---|---|
| `event_delivery_config` | Clave local durable del cursor, inicializada por el runner con aleatoriedad criptográfica |
| `event_delivery_index` | Secuencia estable y FK por ámbito al ID original de alerta |
| `event_acknowledgements` | Recibo único por ámbito/evento, actor e instante |

Un trigger AFTER INSERT de `budget_alerts` incorpora su índice en la misma
transacción del gasto, corrección o presupuesto original. Fallar tras insertar la
alerta revierte también el índice. Los reconocimientos son una transacción posterior
independiente. Se conservan todos los triggers previos y las migraciones 001–003.

El runner verifica cada versión antes de migrar y v4 antes del commit. Un fallo
revierte esquema, clave e índice. Apertura con escritura migra hasta v4; solo lectura
de versiones previas permite las consultas financieras que ya existían, pero el
nuevo puerto de entrega responde `STORAGE_SCHEMA` hasta disponer del índice v4.
No se simula un feed vacío para una base anterior. No hay downgrade.

Se verifican FK, esquema, checksums, clave y recibos canónicos; además se comprueba
que ninguna alerta haya quedado sin entrada en el índice. Triggers impiden cambios
o eliminaciones de metadatos, índices y reconocimientos. No son una protección
antifraude frente a quien tenga control administrativo del archivo completo.

No se incorporaron dependencias. Se reutilizan `node:sqlite`, errores de almacenamiento,
límites de base y política de respaldo anteriores. El adaptador en memoria no se
amplió; el componente interno `SqliteEventDelivery` comparte conexión, límites y
ciclo de vida del adaptador existente, sin otro servidor ni base.

## Verificaciones realmente ejecutadas

La última ejecución del coordinador terminó con **código 0**:

- `npm.cmd run format`: formato aplicado.
- `npm.cmd run check`: formato correcto, ESLint sin warnings, typecheck,
  **115/115 pruebas aprobadas** y build TypeScript.
- `git diff --check`: sin errores de whitespace.

Son **91 pruebas anteriores + 19 de entrega + 5 de migración/integridad**.
Registro local reproducible de la suite: `.cache/event-delivery-check.log`;
formato: `.cache/event-delivery-format.log`. Las fixtures permanecen bajo `.cache/`
y no se borran automáticamente. Comandos dirigidos:

```powershell
node --test tests/event-delivery.test.ts tests/event-delivery-migration.test.ts
npm.cmd run check
```

| Área | Evidencia sintética |
|---|---|
| Paginación | 52 eventos, límite predeterminado 50, páginas parciales/completas, ausencia de pérdidas/duplicados al avanzar |
| Concurrencia de lectura | Nuevos eventos fuera del límite del recorrido, ACK entre páginas, cursor agotado y nuevo recorrido de recuperación |
| Validación | Límites inválidos, campos extra, cursores alterados/malformados, otra base, otra instancia/sujeto |
| Autorización | Permisos específicos, revocación antes de replay y aislamiento en lectura/reconocimiento |
| Reconocimiento | Recibo estable con otro actor/reloj autorizado, reinicio, lectura sin cambios de estado, readonly |
| Fallos | Rollback tras insertar ACK, error simulado después de COMMIT, reintento con mismo ID |
| Procesos | Dos procesos leen lo mismo; ACK concurrentes producen un recibo durable y recuperable tras salir |
| Historia y copias | Reconocimiento/corrección no reescriben alertas; restauración conserva recibos y pendientes |
| Migración | Base v3 con historia/alertas, solo lectura, rollback y conservación exacta de filas al migrar a v4 |
| Índice e integridad | Rollback junto a alerta; secuencias superiores a 2^53; unicidad/FK/append-only; ausencia de índice y timestamp alterado rechazados |
| Restauración divergente | Misma secuencia con nuevos IDs rechaza cursor de otra rama; nuevo recorrido recupera pendientes |

La prueba de 52 eventos detectó que el límite superior se ordenaba por un alias
de texto y elegía `9` antes que `52`. Se corrigió usando la columna entera calificada
para ORDER BY; las pruebas dirigidas y finales pasaron. La primera suite integrada
también detectó que la fixture de migración insertaba alertas antiguas por UUID,
pudiendo colocar 100 antes de 80 y violar el trigger existente. Se corrigió solo
el orden de construcción de esa fixture, conservando todas las restricciones.
La suite se repitió tras esas correcciones y tras usar aleatoriedad criptográfica
del runtime para la clave local. No se afirmó éxito antes de ejecutar los controles.

## Archivos y coordinación

| Propietario | Archivos / responsabilidad |
|---|---|
| finance_domain | `src/domain/event-delivery.ts`, `src/application/event-delivery-store.ts`, `event-delivery-service.ts`, `docs/EVENT_DELIVERY_CONTRACT_V1.md` |
| Coordinador | `src/application/expense-store.ts` (acciones nuevas) |
| Coordinador | `src/infrastructure/sqlite-expense-store.ts`, `sqlite-event-delivery.ts`, `event-delivery-cursor.ts`, `migrations/004-event-delivery.ts` |
| test_engineer | `tests/event-delivery.test.ts`, `tests/fixtures/event-delivery-worker.ts` |
| Coordinador | `tests/event-delivery-migration.test.ts`; versión actual esperada en `tests/expense-corrections.test.ts` y `tests/monthly-budget-migration.test.ts` |
| Coordinador | `README.md`, `docs/PRODUCT_RULES.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/adr/001-persistence.md`, este informe |
| security_reviewer | Revisión específica del delta en lectura, sin editar archivos ni ejecutar pruebas |

Dominio verificó formato, lint y validaciones focalizadas de sus archivos. Pruebas
ejecutó 19 casos dirigidos y sus verificaciones de formato/lint. El coordinador
integró y ejecutó todos los controles. No hubo edición simultánea de archivos.

Seguridad revisó aislamiento, permisos, cursor, snapshots, ACK transaccionales y
minimización; recomendó vincular IDs a posiciones por restauración divergente, lo
que se incorporó y probó. No identificó bloqueantes en la revisión estática. El rol
declara sandbox `read-only` y no realizó escrituras; su enforcement efectivo por
el runtime no está certificado. No se realizó auditoría general.

## Limitaciones y decisiones pendientes

- **Simulado:** consumidores e identidad/autorización en fixtures. La autenticación
  operativa y el binding de ámbito con Jarvis requieren diseño y aprobación futura.
- **Pendiente:** cotejo de contrato Jarvis, transporte, timeouts, preferencias,
  deduplicación durable del consumidor y tratamiento de efectos externos que no
  compartan transacción con su registro de procesamiento.
- Un consumidor lógico por ámbito. Fan-out a consumidores independientes exige
  otro contrato; no se infiere ni implementa en este incremento.
- No hay API HTTP, worker permanente, scheduler, leases, colas externas, entrega de
  mensajes ni nuevas reglas financieras. La revisión mensual automática permanece
  pendiente de orquestación.
- La clave local se guarda con la base/copias; no es una credencial de Jarvis.
  Rotación, cifrado del archivo, ACL operativas, retención y control administrativo
  requieren decisiones antes de información real. No se verificaron Linux, CI
  remoto, cortes eléctricos, carga masiva ni operación productiva.
- No se tocaron Sir Jarvis, infraestructura, datos reales, dependencias ni lockfile.
  No se crearon commits, PR, servicios o despliegues.

Siguiente incremento recomendado: consumidor sintético con deduplicación durable
de efectos y pruebas de contrato de extremo a extremo local. Esto permitiría definir
la frontera de procesamiento/confirmación antes de autorizar una integración real.
La Fase 1 completa no se declara terminada.
