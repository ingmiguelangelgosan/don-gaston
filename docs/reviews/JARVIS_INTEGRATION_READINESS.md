# Preparación de integración local — Sir Jarvis y Don Gastón

**Actualización 2026-11-17:** el usuario aprobó el perfil descrito abajo y se
implementó la demostración con consumidor sintético. Ver
[evidencia posterior](JARVIS_SYNTHETIC_INTEGRATION.md). Se conserva esta evaluación
como antecedente; sus pendientes de aprobación quedaron resueltos para ese alcance.
La interoperabilidad con el runtime real Jarvis continúa pendiente.

Fecha: 2026-11-16. Estado: **contrato real inspeccionado; adaptación pendiente de
aprobación e implementación; compatibilidad extremo a extremo no demostrada**.
Evaluación focal, sin auditoría integral. FIN-01 no se habilita en producción.

## Dictamen y procedencia

El repositorio local de Sir Jarvis estuvo disponible en
`D:/Documentos/sir-jarvis`. El usuario autorizó examinar su contrato únicamente en
lectura. El coordinador inspeccionó documentación y código de registro, validación,
ejecución, transporte, red y recuperación. No se ejecutó Jarvis, no se modificaron
sus archivos y no se accedió a `.env`, configuración privada, credenciales,
bases de datos, logs operativos ni infraestructura.

| Fuente local | Referencia observada |
|---|---|
| Don Gastón | HEAD `04734ea0d338bfb845116ae69e73337e08a2fcb9`, SQLite v10 |
| Sir Jarvis | HEAD `c015c4e02908676fa8f87fc7bf524580169bb578` |
| Cambios locales de Jarvis en rutas contractuales inspeccionadas | `git diff HEAD --name-only` no devolvió cambios en esas rutas; no es una certificación del árbol completo ni del despliegue |
| Pruebas financieras previas | Log local e informe 1K: 321/321; no reejecutadas aquí |

La ruta real del protocolo Jarvis es `docs/AGENT_PROTOCOL.md`, no
`docs/agents/AGENT_PROTOCOL.md` citada en el borrador de Don Gastón.
`docs/agents/FINANCE_AGENT_SPEC.md` preserva requisitos financieros; **no define un
schema ejecutable de gastos ni un agente financiero conectado**.

Jarvis tiene una infraestructura genérica de agentes que permite registrar
capacidades versionadas y validadores locales. El borrador de Don Gastón no coincide
con su envelope. El núcleo financiero puede atender la operación, pero falta una
frontera que autentique, vincule identidades y traduzca el contrato. No hace falta
otro módulo financiero para resolverlo.

**No se implementó la demostración integrada:** el usuario exige documentar las
diferencias y aprobar los cambios de contrato antes de modificarlos. Se conserva
intacto `AGENT_PROTOCOL_DRAFT.md`; el perfil siguiente es una propuesta revisable,
no una interfaz aprobada ni un anuncio de compatibilidad.

## Comparación con código real

Las rutas Jarvis de esta tabla son relativas a su repositorio independiente.

| Aspecto | Jarvis inspeccionado | Don Gastón actual y consecuencia |
|---|---|---|
| Registro/descubrimiento | `src/agents/registry.ts:39`: `InMemoryAgentRegistry`, alta administrada, orígenes permitidos, descriptores, schemas conocidos, permisos por sujeto; `get/list`. `docs/AGENT_PROTOCOL.md:16`: manifest futuro informativo, no permiso automático | No tiene descriptor/registro de capacidades remotas. La demo puede registrar explícitamente un fixture; no necesita autodiscovery |
| Versión/capacidades | `protocol.ts:2`, `:7`: protocolo `1.0`, capacidad `{name,version}`, efecto read/write y supports_idempotency; `validation.ts:70` valida estructura estricta | Borrador `1.0-draft` y capacidad string incompatibles. Nombres/esquemas financieros aún no registrados ni aprobados |
| Solicitud | `protocol.ts:47`, `validation.ts:70`: envelope con instance_id, agent_id, subject_ref, correlation_id, kind, request_id, idempotency_key, capability, deadline_at, cost_policy e input | Borrador usa intent_id/payload y omite contexto/campos requeridos. No basta renombrar un campo; falta adaptador completo |
| Respuesta | `protocol.ts:88`, `validation.ts:226`: execution-result, correlación exacta, completed/output, pending/operation_id o failed/error | Los servicios devuelven objetos de dominio, no envelopes. Dinero requiere serialización explícita, no pasar instancias Money al validador JSON de Jarvis |
| Identidad confiable | `src/app/agent-execution.ts:18` define actor local como instancia/sujeto; `:48` exige coincidencia con request. El wire no contiene actor de auditoría | AccessContext exige actorRef, subjectRef e instanceRef fuera del input. Hace falta binding administrado en el receptor; Bearer válido no vuelve confiable cualquier subject_ref enviado |
| Autorización | `registry.ts:113` valida habilitación, disponibilidad, sujeto, capacidad y versión; servicio vuelve a comprobar origen | ExpenseService revalida policy por acción antes de replay. El adaptador debe conceder exclusivamente expense:record/expense:read al contexto autenticado, sin permisos tomados del mensaje |
| Idempotencia | `src/agents/json.ts:101`: scope instancia/sujeto/agente/capacidad/versión/clave. `:92`: hash de todo request salvo deadline, incluyendo request_id y correlation_id | Dominio: unicidad global instancia/sujeto/clave, compartida entre mutaciones; huella financiera normalizada. Debe aprobarse una traducción estable, sin modificar reglas o claves históricas |
| Respuesta incierta | `durable-gateway.ts:209`: completed recuperado sin output → RESULT_EXPIRED/completed, estado incierto no se reejecuta ciegamente. `https-transport.ts:209`: consulta de operación necesita pending conocido | `findIntent` local recupera resultado durable; no existe capacidad remota para ello. GET operations no resuelve una respuesta completed perdida sin operation_id. Se propone consulta de gasto por intención |
| Autenticación | `https-transport.ts:321`, `:372`: resolver de credencial y Authorization Bearer fuera del JSON; contrato §6 exige credencial por agente/instancia | No existe receptor autenticado. Para demo, solo material ficticio efímero y binding por fixture; identidad humana real queda fuera |
| Límites/errores | `json.ts:11`: 64 KiB, profundidad 32 y 8192 nodos; `https-transport.ts:74`: rechaza claves JSON duplicadas; `validation.ts:31` errores enumerados; status HTTP correlacionado | SQLite limita importes/resultados, pero no valida HTTP/envelope. DomainError/STORAGE_* no son errores wire; se debe mapear sin filtrar SQL/datos ni declarar seguro un resultado incierto |
| Transporte/red | `https-transport.ts:198`: POST /v1/execute; `:362`: TLS verificado; `:393`: sin compresión/redirect. `network-policy.ts:48`, `:111`: bloquea loopback/localhost en política normal y controla DNS/IP | No hay servidor. Una futura prueba HTTPS local necesita excepción de red exclusivamente en tests, CA temporal y proceso efímero. No cambiar la política productiva ni desactivar TLS |
| Canal operativo | `src/app/agent-read.ts:42`: camino actual limitado a echo.reply 1.0 read | Registrar una capacidad genérica no habilita finanzas en Telegram. La demo será consumidor simulado fuera del bot; habilitación del canal es posterior |
| Eventos | `protocol.ts:119` modela notification/completion; contrato §5–7 describe POST /v1/agent-events, HMAC y dedup durable. §8 identifica eventos públicos como pendientes | Feed local presupuesto con cursor/ACK es otro contrato. No existe puente ni dedup externa demostrada; un ACK local no prueba entrega a usuario. Excluir eventos de la primera demo |
| Identificadores | Jarvis `validation.ts:15` acepta alfanumérico inicial y `._-`, máximo 128 | Don Gastón admite además `:` (`domain/expenses.ts:21`). Usar subconjunto wire para nuevos IDs externos, sin reescribir los históricos |

El catálogo Jarvis (`validation.ts:133–177`) recibe validadores confiables locales y
rechaza coerciones, defaults o transformaciones. No descarga schemas arbitrarios
ni interpreta un manifiesto como código. El adaptador debe convertir explícitamente
los objetos del dominio a JSON ordinario antes de validarlos.

## Perfil mínimo propuesto para aprobación

Esta propuesta adapta Don Gastón al envelope genérico **1.0** observado; no propone
alterar Jarvis ni crear un protocolo incompatible. Definir las capacidades
financieras y la delegación local sigue siendo una decisión de contrato pendiente.

### 1. Dos capacidades, una categoría preparada por fixture

| Capacidad propuesta | Efecto/schema propuesto | Entrada y salida |
|---|---|---|
| `finance.expense.record`, versión `1.0` | write, supports_idempotency=true; IDs `finance.expense.record.input.v1` y `finance.expense.record.output.v1` | input exacto `{amount,currency,categoryId,occurredOn}`; output `{expense:{id,amount:{minor,currency},categoryId,occurredOn}}` |
| `finance.expense.lookup`, versión `1.0` | read, supports_idempotency=true; IDs `finance.expense.lookup.input.v1` y `finance.expense.lookup.output.v1` | input exacto `{write_intent_id}` referido a la clave externa de record v1.0; output `{found:false}` o `{found:true,expense:{id,amount:{minor,currency},categoryId,occurredOn}}` |

Importe de entrada decimal positivo como string, COP explícito y fecha civil real;
sin separadores de miles ni decimales adicionales a centavos. Ejemplo: `"45000"`;
salida exacta `minor:"4500000"`. Categoría Gasolina presembrada con ID de fixture
estable en SQLite propia. No se expone creación/edición de categorías ni totales
remotos para este flujo: comprobar una fila y el total puede hacerse en el test.

`lookup` filtra exclusivamente gastos. No devuelve categorías, correcciones ni
resultados de otras capacidades, aunque el servicio local findIntent pueda verlos.
Un gasto no encontrado no significa que una ejecución incierta nunca vaya a hacer
commit; se conserva la intención original y no se crea otra para la escritura.

### 2. Binding de identidad sin campos nuevos en wire

Proponer configuración privada **solo de fixture** que vincule credencial ficticia,
instance_id, agent_id y subject_ref a un actorRef sintético de servicio y una lista
cerrada de acciones. Verificar credencial y coincidencia de scope antes de construir
AccessContext. Rechazar cambios de sujeto/instancia y campos de identidad en input.

Este actor acredita la **delegación sintética del consumidor**, no la identidad
personal del usuario de un canal. No inferir actor a partir del texto ni añadir un
actor wire no admitido por Jarvis. Si se exige atribución individual multi-actor,
se necesita otra decisión contractual; no queda resuelta por este perfil.

### 3. Traducción estable de claves sin cambiar el ledger

Proponer una clave interna del adaptador, por ejemplo prefijo `jg1-` más SHA-256
de la serialización JSON de la tupla ordenada
`[instance_id,subject_ref,agent_id,capability.name,capability.version,idempotency_key]`.
La unicidad global del dominio permanece intacta; el adaptador traduce el ámbito
wire completo a una clave opaca determinista. El mapping es versionado y debe
permanecer estable después de reinicios. No afecta intenciones locales históricas.

El cliente conserva request_id, correlation_id e idempotency_key en reintentos;
Jarvis incluye los dos primeros en su hash. No utilizar correlación como clave de
efecto. La consulta lookup calcula la clave **de record v1.0** a partir del ámbito
autorizado y write_intent_id, nunca la clave de lectura. Una consulta nueva puede
usar nuevos IDs propios sin cambiar la intención financiera que consulta.

La lectura de recuperación no altera por sí misma el journal incierto de Jarvis:
conciliar ese estado en el orquestador sigue siendo un paso posterior. No se debe
eludir el bloqueo durable ni reenviar automáticamente una escritura con otra clave.

### 4. Transporte de prueba y resultados

Proponer fixture HTTPS efímera en loopback, puerto asignado por el sistema, CA y
credencial ficticias temporales, verificación TLS activa y cierre al terminar.
Todos los artefactos y SQLite quedarían bajo un directorio sintético de Don Gastón;
sin listeners públicos, servicios permanentes, configuración de Jarvis o datos reales.
La excepción de loopback pertenece únicamente al cliente de tests; el contrato de
producción y su política DNS/IP no se relajan. Implementar solo POST /v1/execute
para ambas capacidades sin inventar endpoint por intención ni trabajo pending.

La primera ejecución sería **consumidor simulado que reproduce el contrato
inspeccionado**, no prueba del bot ni del runtime Jarvis operativo. Don Gastón no
importaría módulos privados de Jarvis ni compartiría su base. Para afirmar después
interop con el cliente Jarvis real habrá que ejecutar una suite con su Gateway y
transporte bajo alcance de pruebas aprobado; esta evaluación no lo ha hecho.

Respuestas completed repiten exactamente el contexto wire y se generan a partir
del resultado durable; no exponen actor interno, SQL o claves técnicas. Propuesta
de errores: identidad 401/403, entrada inválida 422, capacidad desconocida 404,
conflicto 409, bloqueo sin inicio 503 con retryable=false. Una excepción posterior
a commit o pérdida de respuesta conserva incertidumbre; nunca anunciar rollback
ni reintento seguro solo por observar 500/timeout. Recuperar mediante lookup.
Se definirán exhaustivamente validación, límites y mapping de errores en el
incremento aprobado antes de afirmar conformidad.

## Pruebas de aceptación preparadas, no ejecutadas

| Caso | Evidencia exigida en el siguiente incremento |
|---|---|
| Gasto autorizado | Envelope 1.0 válido → una fila SQLite; 45.000 COP, categoría/fecha exactas y salida JSON correlacionada |
| Replay | Mismo scope/clave/input → mismo ID y un solo efecto, incluso tras reinicio |
| Conflicto | Misma intención con importe/categoría/fecha distintos → 409 y estado intacto |
| Consulta | lookup de la clave original devuelve importe/categoría; ausencia tipada; no revela resultados de otro módulo |
| Respuesta perdida | Commit seguido de desconexión; consulta autorizada recupera mismo gasto sin volver a escribir |
| Identidad/permisos | Credencial ficticia inválida, sujeto/instancia ajenos, permiso ausente o revocado → rechazo antes de efecto/lectura |
| Entrada/límites | Versión, campos adicionales, identidad en input, categoría/fecha/dinero inválidos, claves JSON duplicadas y exceso de tamaño rechazados |
| Correlación/transporte | TLS válido y CA inválida; sin redirects/compresión; respuesta cruzada rechazada; deadline agotado sin efecto nuevo |

No hace falta reejecutar 321 pruebas históricas para escribir estos informes.
Al implementar el adaptador se ejecutarían los nuevos casos, controles estáticos
y pruebas del núcleo que realmente toque el cambio. Una respuesta válida de un
doble no sustituye la comprobación posterior con el consumidor Jarvis real.

## Bloqueantes, pendientes y siguiente paso

**Para demo sintética:** aprobar este perfil (capacidades, binding, mapping de clave,
consulta de recuperación y fixture de transporte), modificar el borrador en Don
Gastón y añadir adaptador/tests. Ninguna ampliación financiera es requisito previo.

**Para información real:** además de la frontera probada, aprobación específica,
identidad y permisos operativos, gestión/rotación de credenciales, protección de
archivos/copias, recuperación e incidentes, controles de red y alcance del piloto.
El ADR vigente solo autoriza datos sintéticos. Una demo aprobada no autoriza FIN-01
en producción, Lightsail, Telegram ni conexiones bancarias/IA.

**Puede esperar:** integración de eventos, inbox/outbox externa y entrega al canal;
operaciones pending; más capacidades financieras; IA, automatización, correcciones
de módulos adicionales y caja global. Los eventos actuales se conservan sin cambios.

Siguiente paso concreto: obtener aprobación del perfil anterior y luego construir
el incremento local de gasto/lookup en Don Gastón, manteniendo Jarvis en lectura.
Si no se aprueba, resolver únicamente los puntos discrepantes, sin expandir finanzas.

## Trabajo, verificaciones y límites de esta evaluación

- Coordinador: lectura autorizada del contrato y código Jarvis; comparación con
  Don Gastón; redacción de este documento y consolidación de MVP_READINESS.
- `finance_domain`: propietario inicial exclusivo de `MVP_READINESS.md`; revisión
  semántica del gasto, idempotencia, consumo y evidencia histórica.
- `security_reviewer`: revisión local de Don Gastón y extractos remitidos por el
  coordinador. Su instrucción de rol prohíbe inspeccionar repositorios vecinos;
  no leyó Jarvis directamente. No escribió archivos ni ejecutó pruebas. No se
  certifica el aislamiento efectivo del runtime por su configuración declarada.
- `test_engineer`: inspección de pruebas/contratos y matriz de aceptación; sin
  escrituras ni ejecuciones. No se atribuye a los especialistas una prueba integrada.

Esta entrega cambia únicamente los dos informes. No se cambian contratos, fuentes,
reglas, migraciones, dependencias, configuración o archivos Jarvis. Se ejecutaron
lecturas/búsquedas y comprobaciones Git; la revisión documental incluye diff sin
errores de whitespace y verificación de enlaces relativos. No se ejecutaron tests,
lint, typecheck o build nuevos, al no existir cambios de código. La evidencia
321/321 pertenece a la ejecución anterior conservada; la demo sigue pendiente.

La Fase 1 permanece abierta y el uso real no está autorizado.
