# Perfil Don Gastón ↔ Sir Jarvis — demostración sintética aprobada

Actualización: 2026-11-17. El usuario aprobó formalmente el perfil mínimo de
[preparación de integración](reviews/JARVIS_INTEGRATION_READINESS.md).
Se implementó un adaptador para el envelope genérico **1.0 inspeccionado en Jarvis**.
El nombre de este archivo es histórico. El alcance aprobado es la demostración
local; se probaron componentes reales en un harness aislado. No se arrancó el
runtime operativo de Jarvis ni se autorizó uso productivo.

Fuente cotejada: `D:/Documentos/sir-jarvis/docs/AGENT_PROTOCOL.md` y código
`src/agents/`, HEAD `c015c4e02908676fa8f87fc7bf524580169bb578`.
No se modificó Jarvis. El harness optativo `tests/interop/` importa clases reales
desde un checkout local confiable; el código de aplicación/build de Don Gastón
sigue independiente. [Demostración inicial](reviews/JARVIS_SYNTHETIC_INTEGRATION.md)
y [evidencia de componentes reales y limitación de Node](reviews/JARVIS_REAL_GATEWAY_INTEROP.md).

## Capacidades y schemas

Ambas tienen versión `1.0` y soportan idempotencia. Validadores deterministas
locales; no se descargan schemas ni se registra automáticamente un agente en Jarvis.

| Capacidad | Efecto | Schema de entrada/salida |
|---|---|---|
| `finance.expense.record` | write | `finance.expense.record.input.v1` / `finance.expense.record.output.v1` |
| `finance.expense.lookup` | read | `finance.expense.lookup.input.v1` / `finance.expense.lookup.output.v1` |

Record exige exactamente `{amount,currency,categoryId,occurredOn}`: importe decimal
positivo como string, COP explícito, categoría existente y fecha civil válida.
Salida: `{expense:{id,amount:{minor,currency},categoryId,occurredOn}}`.
`minor` es texto canónico de centavos: 45.000 COP → `"4500000"`.

Lookup exige `{write_intent_id}`, la clave externa original de record v1.0.
Devuelve `{found:false}` o `{found:true,expense:{id,amount:{minor,currency},categoryId,occurredOn}}`.
Filtra exclusivamente gastos. Recupera la respuesta original, no una proyección
de correcciones posteriores. Ausencia no prueba que una ejecución concurrente o
incierta no pueda confirmar después.

## Envelope y respuesta

Campos obligatorios y sin extras. Ejemplo ficticio:

```json
{
  "protocol_version": "1.0",
  "kind": "execute",
  "instance_id": "synthetic-instance",
  "agent_id": "don-gaston.synthetic",
  "subject_ref": "synthetic-subject",
  "request_id": "request-expense-001",
  "correlation_id": "flow-expense-001",
  "idempotency_key": "expense-001",
  "capability": {"name":"finance.expense.record","version":"1.0"},
  "deadline_at": "2026-11-16T12:00:20.000Z",
  "cost_policy": "no-paid-services",
  "input": {"amount":"45000","currency":"COP","categoryId":"fixture-category-id","occurredOn":"2026-11-16"}
}
```

El deadline del ejemplo pertenece al reloj fijo del test. Una ejecución nueva
requiere plazo UTC futuro, máximo 30 segundos desde el reloj de frontera. Se
revalida después de reservar, antes del servicio; no se promete cancelar una
transacción financiera ya iniciada.

Respuesta HTTP 200: mismo protocolo, instancia, agente, sujeto, request y
correlación; `kind:"execution-result"`, `status:"completed"` y `output` según
capacidad. No transmite actor interno, clave traducida ni credenciales.
No se implementan pending, polling de operaciones ni eventos.

## Identidad y permisos

Configuración controlada de fixture vincula credencial sintética, instancia,
agente, sujeto, actor interno y acciones mínimas. Bearer va en Authorization/TLS,
nunca en input. Se comparan hashes de tokens en tiempo constante y se verifica
scope antes de construir el contexto congelado del servicio.

Record requiere `expense:record`; lookup, `expense:read`. Autorización y revocación
se verifican antes de replay. El actor acredita delegación sintética, no identidad
personal Telegram. La revocación en memoria no sustituye gestión operativa persistente.

## Idempotencia y recuperación

Mapping v1 aprobado:

```text
domain_key = "jg1-" + SHA256(UTF8(JSON.stringify([
  instance_id, subject_ref, agent_id, capability.name,
  capability.version, idempotency_key
]))).hex_lowercase
```

El ledger mantiene unicidad global instancia/sujeto/clave sin modificar intenciones
históricas. Lookup calcula la clave de **record 1.0** usando ámbito autorizado y
write_intent_id; no usa la clave de lectura como clave de gasto.

Para escrituras se conserva SHA-256 del JSON canónico de toda la solicitud, excluido
solo deadline_at; objetos ordenados por clave, sin coerción/defaults.
Cambiar request_id, correlation_id o input con igual intención genera 409 incluso
tras reiniciar. La normalización financiera no sustituye esta huella del envelope.

Un journal SQLite **separado, versión 1 del adaptador**, guarda únicamente clave
traducida y huella. La reserva durable precede a ExpenseService. Gasto/huella/
resultado/alertas conservan su transacción financiera existente en SQLite v10.
No hay transacción distribuida: un fallo financiero puede dejar reserva sin gasto.
Un reintento explícito debe conservar todos los IDs y el mismo comando.

Crear el journal es explícito y exclusivo; reabrir exige archivo existente/esquema
válido, sin fallback a memoria. Un gasto existente sin reserva rechaza replay/lookup
en lugar de aceptar metadatos nuevos. Recuperar una pareja coherente de archivos;
no se implementa backup coordinado de ambos ni se cambia el respaldo financiero previo.

Ante respuesta perdida, consultar lookup con IDs de lectura propios y la intención
financiera original. El consumidor nunca reintenta automáticamente ni genera otra
clave de escritura. Esto no concilia el journal incierto del runtime Jarvis.

## Transporte y límites

Solo POST /v1/execute. Receptor HTTPS efímero **exclusivamente en tests**, bind
127.0.0.1 y puerto del sistema. CA/leaf nuevos mediante OpenSSL local, TLS y hostname
verificados, sin cambiar truststore. Cliente solo loopback, sin redirects/retries.
No se relaja la política productiva Jarvis. El bootstrap/build no incluye listener.

- JSON UTF-8 hasta 65536 bytes, profundidad 32/nodos 8192; sin compresión,
  duplicados, extras, getters, toJSON ni prototipos especiales.
- IDs wire: alfanumérico inicial, luego alfanumérico o `._-`, máximo 128.
- Importes: hasta 4096 dígitos de centavos; sin floats/redondeo/otras monedas.
- HTTPS de prueba: headers 8192 bytes, timeouts 3 segundos; cliente 5 segundos.
- Journal: hasta 10000 reservas y 8 MiB; sin purga automática. Límites financieros
  existentes permanecen independientes.

## Errores

Envelope válido: `status:"failed"`, `error:{code,message,retryable:false}` y
correlación original; mensajes estáticos, sin datos internos.

| Código | HTTP |
|---|---|
| UNSUPPORTED_PROTOCOL | 400 |
| UNAUTHORIZED / FORBIDDEN | 401 / 403 |
| UNKNOWN_CAPABILITY | 404 |
| VALIDATION_FAILED | 422 |
| IDEMPOTENCY_CONFLICT | 409 |
| TIMEOUT | 504 |
| UNAVAILABLE (bloqueo SQLite) | 503 |
| INTERNAL_ERROR | 500 |

Sin autenticación o envelope utilizable: rechazo genérico sin inventar correlación;
el cliente estricto no lo acepta como resultado financiero. Errores de transporte:
404 ruta/método, 413 tamaño, 415 media type/compresión. Un 500, desconexión o timeout
no demuestra ausencia de commit: consultar la intención.

## Fuera de alcance

Arranque del Jarvis operativo, Telegram, FIN-01 productivo, datos reales, gestión operativa
de credenciales, servicios permanentes, despliegue, eventos/HMAC/deduplicación
externa y otras capacidades. El contrato local de eventos no cambia.
La Fase 1 completa permanece abierta.
