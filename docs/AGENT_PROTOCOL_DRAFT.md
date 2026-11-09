# Contrato propuesto Don Gastón ↔ Sir Jarvis (BORRADOR, no implementado)

**Importante:** Sir Jarvis ya tiene una especificación/implementación de protocolo de agentes. Este texto es **material de trabajo**, NO es prueba de compatibilidad ni autorización de modificar Jarvis. Antes de programar transporte, el coordinador debe contrastarlo con `docs/agents/AGENT_PROTOCOL.md` y `FINANCE_AGENT_SPEC.md` **reales y vigentes** del repositorio Jarvis. No inventar endpoints.

## Frontera

- Jarvis autenticará al usuario del canal y decidirá capacidad; Don Gastón revalidará actor, origen, sujeto e instancia mediante contexto autenticado.
- El texto introducido por el usuario jamás controla `subject_ref`, destinatario de almacenamiento o permisos.
- No se comparten secretos del bot, credenciales de Docker ni acceso a bases entre proyectos.
- Transporte futuro: HTTPS+JSON, versión explícita, autenticación de servicio, tamaño máximo de payload y respuestas, timeout y límites; eventos posteriores opcionales y autenticados.

## Envelope conceptual (NO API real)

```json
{
  "protocol_version": "1.0-draft",
  "request_id": "synthetic-request-id",
  "intent_id": "stable-synthetic-intent-id",
  "capability": "finance.expense.record",
  "payload": {"amount": "45000", "currency": "COP", "category": "transport"}
}
```

La identidad de sujeto/instancia **NO figura en el payload editable**: se recibe como contexto vinculado a la autenticación del servicio y se valida en Don Gastón. `amount` es una cadena decimal exacta en unidades de la moneda indicada, no un flotante. El contrato final se adaptará al protocolo vigente de Jarvis, no al revés.

## Reglas de negocio para escrituras

- Idempotencia por `(instancia, sujeto, capacidad, intent_id)` o clave final aprobada y restricciones transaccionales. Guardar huella de payload.
- Idempotencia posterior a fallo incierto: mismo `intent_id`; consultar estado; prohibido regenerar id en cada retry.
- Mismo `intent_id` + datos distintos: error de conflicto.
- Confirmación contextual firmemente vinculada a importe, moneda, sujeto y operación, no `approved=true` libre.
- Respuestas sin secretos y errores tipados: `unauthorized`, `invalid_request`, `conflict`, `pending_confirmation`, `unavailable`, `unknown_outcome`.

## Casos de contrato imprescindibles

- Petición repetida igual → una única operación.
- Petición repetida con datos cambiados → conflicto.
- Respuesta perdida después del commit → recuperar mismo resultado mediante consulta.
- Revocación/cambio de sujeto → negar.
- Sujeto A intenta consultar sujeto B → negar.
- Fallo de agente/timeout/caída parcial → Jarvis no asume éxito y no duplica.
- Concurrencia con dos workers → unicidad y conciliación.

## Estado pendiente de aprobación

1. Ubicar y leer contrato vigente del repo Jarvis (sin tocar Lightsail).
2. Hacer una tabla de compatibilidad campo por campo.
3. Elegir transportes, URLs, auth y capacidad declarada; separar test y producción.
4. Concluir contrato versionado y suites de pruebas en ambos repos.
5. Aprobar explícitamente antes de habilitar la primera mutación real.
