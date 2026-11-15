# Contrato local v1 — Consulta y reconocimiento de eventos

Fecha: 2026-11-14. Contrato del núcleo local de Fase 1E, con fixtures sintéticas.
**No se ha cotejado con Sir Jarvis ni se declara compatible con su protocolo.**
No define rutas HTTP, autenticación de red, scheduler o entrega a un canal.

## Alcance y permisos

`EventDeliveryService` recibe un puerto de persistencia, política de autorización
y reloj de aplicación opcional. El contexto `{actorRef, instanceRef, subjectRef}`
es vinculado por una frontera confiable, fuera del payload editable. La política
se revalida en cada llamada, incluidos reintentos de reconocimiento. Se requieren
permisos específicos `event:read` para consulta y `event:ack` para reconocimiento.
Los permisos de gastos o presupuestos no conceden estas capacidades implícitamente.

Hay **un consumidor lógico por instancia/sujeto**; varias conexiones o procesos
autorizados pueden actuar por él. Un reconocimiento quita el pendiente para ese
consumidor lógico. No hay suscripciones independientes ni acknowledgements por
consumidor configurable; introducirlos requerirá otro contrato y migración.

## Consulta paginada

```typescript
if (previous.nextCursor !== null) {
  service.listPending(context, { limit: 50, cursor: previous.nextCursor });
}
```

En la primera página se omite `cursor`; no se envía `null`. `limit` es opcional,
predeterminado 50, entero de 1 a 100 inclusive. No se admiten otros campos. Respuesta:

```json
{
  "version": 1,
  "events": [
    {
      "version": 1,
      "type": "budget.threshold-reached",
      "id": "synthetic-event-id",
      "categoryId": "synthetic-category-id",
      "month": "2026-11",
      "threshold": 80
    }
  ],
  "nextCursor": null
}
```

Se reutiliza el ID persistido de la alerta original, sin regenerarlo al consultar,
reintentar, reiniciar o reconocer. El consumidor deduplica por la combinación del
ámbito autorizado y `id`; el ámbito no se acepta desde el cuerpo del evento.

La proyección excluye importe del presupuesto, consumo monetario, nombre de
categoría, actor financiero, ID de presupuesto y clave de intención. Categoría,
mes y umbral siguen siendo información privada: minimización no significa datos
públicos. Para enriquecer un mensaje en el futuro hará falta autorización separada;
la entrega no incorpora lecturas financieras adicionales implícitas.

El orden es determinista por secuencia durable de entrega, no por fecha financiera.
La migración asigna orden determinista a alertas antiguas por instancia, sujeto,
categoría, mes, umbral e ID. Las nuevas se añaden al final con secuencia de inserción
`AUTOINCREMENT`; esta secuencia no afirma la hora real de creación de los eventos
históricos.
La primera página fija un límite superior de secuencia para el recorrido. Las
siguientes usan paginación por clave, sin offsets. Nuevas alertas posteriores al
límite se recuperan comenzando otro recorrido sin cursor.

El cursor es opaco, versionado, autenticado y cifrado con AES-GCM usando una clave
local durable. Vincula instancia, sujeto, límite superior y posición; el consumidor
debe conservarlo sin interpretarlo ni modificarlo. No contiene datos financieros
en claro ni concede permisos. Su longitud máxima admitida es 2048 caracteres.
También vincula los IDs de los eventos que anclan la posición y el límite superior;
así se rechaza una historia divergente que reutilice posiciones después de una
restauración. Usarlo en otro ámbito o alterarlo produce `INVALID_CURSOR`. La
autorización se evalúa antes de descifrarlo. Respaldo/restauración y política futura de rotación de
claves deben tratar el cursor como estado de recorrido, no como confirmación.

El límite superior es estable, pero el estado pendiente se consulta en cada página:
eventos reconocidos concurrentemente pueden desaparecer. Esto no desplaza las
posiciones de eventos posteriores ni hace perder pendientes por offsets. Repetir
un cursor puede devolver los mismos eventos mientras sigan pendientes; si ya fueron
reconocidos, puede devolver menos elementos. Un recorrido que avanza sus cursores
no repite IDs dentro de ese recorrido.

`nextCursor=null` indica fin de ese recorrido, **no** que todos sus eventos hayan
sido procesados. Consultar nunca reserva ni reconoce. No hay leases, vencimientos,
renovaciones ni recuperación de reservas que deban coordinarse.

## Reconocimiento durable

Solo después de confirmar su procesamiento durable, el consumidor llama:

```typescript
service.acknowledge(context, { eventId: event.id });
```

Respuesta original, conservada en reintentos:

```json
{
  "version": 1,
  "eventId": "synthetic-event-id",
  "status": "processed",
  "processedAt": "2026-11-14T12:00:00.000Z"
}
```

`processedAt` es el instante UTC del primer reconocimiento aceptado, proporcionado
por el reloj de aplicación, no la fecha del gasto, del umbral o un timestamp
editable del consumidor. Se conserva auditoría interna del primer actor autorizado;
el recibo público no lo expone. Un reintento autorizado devuelve el recibo original,
sin cambiar actor/instante y sin crear efectos adicionales.

La identidad `(event:ack:v1, instancia, sujeto, eventId)` es la clave natural y
estable de idempotencia. El único payload variable es `eventId`; no hay clave
adicional que el consumidor pueda regenerar por incertidumbre. El reconocimiento
se registra transaccionalmente y por unicidad del evento en ese ámbito. El evento
original y los movimientos financieros permanecen inmutables. No se reconoce una
página completa ni se confirma un evento solamente por haberlo leído.

Un ID inexistente o de otro ámbito devuelve `EVENT_NOT_FOUND`, sin revelar
existencia ajena. El núcleo confía en la afirmación explícita del consumidor
autorizado: no dispone de evidencia de red ni prueba de entrega al usuario final.
`processed` significa procesamiento reconocido, no mensaje leído ni notificación
enviada a Telegram. No deben confundirse esos estados.

## Fallos, recuperación y deduplicación

La entrega puede ser **al menos una vez**, nunca se promete exactamente una vez.
Dos procesos pueden leer el mismo pendiente; cada consumidor deberá deduplicarlo
antes de producir efectos, también cuando otro proceso esté actuando simultáneamente.

1. Consultar desde el comienzo o continuar el recorrido activo.
2. Comprobar la clave de deduplicación persistida en el consumidor.
3. Procesar y registrar esa clave duraderamente junto al efecto, cuando el sistema
   consumidor permita la misma transacción; para canales externos deberá diseñarse
   cómo controlar efectos no transaccionales antes de integrar.
4. Reconocer el evento en Don Gastón. Ante respuesta incierta, reintentar el mismo ID.
5. Al terminar el recorrido, iniciar otro sin cursor para recuperar pendientes.

Un fallo antes del reconocimiento deja el evento pendiente. Un fallo transaccional
durante el reconocimiento revierte la escritura. Si el commit se completó pero la
respuesta se perdió, repetir devuelve el recibo original. Si el consumidor procesó
pero no llegó a reconocer, recibirá nuevamente el evento y deberá deduplicarlo.

Tras interrupción, el procedimiento seguro es comenzar sin cursor. El cursor no es
un checkpoint de procesamiento: avanzar más allá de eventos sin reconocerlos los omite
del resto de ese recorrido, pero siguen pendientes y aparecen en otro recorrido.
Una copia restaurada puede anteceder reconocimientos ya recibidos por el consumidor;
la deduplicación externa sigue siendo necesaria aun con respaldo consistente.

## Errores y decisiones pendientes

| Código | Significado |
|---|---|
| `FORBIDDEN` | Permiso ausente o revocado |
| `INVALID_INPUT` | Campos inesperados o tamaño de página fuera de 1–100/entero |
| `INVALID_IDENTIFIER` | Identidad o ID de evento inválido |
| `INVALID_CURSOR` | Cursor inválido, manipulado, incompatible o de otro ámbito |
| `EVENT_NOT_FOUND` | Evento inexistente en el ámbito autorizado |
| `INVALID_CORRECTION` | Validador UTC compartido rechaza el reloj interno configurado |
| `STORAGE_*` | Límite, bloqueo, solo lectura, cierre, esquema o integridad del almacenamiento |

La consulta requiere el índice de entrega de la migración v4. Abrir una base v1/v2/v3
en solo lectura no crea ese índice: el nuevo puerto responde `STORAGE_SCHEMA` hasta
migrarla con escritura autorizada. No simula una página vacía ni ausencia de eventos.

Estado implementado localmente: contrato tipado, validación y permisos de servicio.
La evidencia de persistencia y pruebas integradas se registra en
[el informe de Fase 1E](reviews/PHASE1_EVENT_DELIVERY.md), sin atribuirle verificación
a este documento por sí solo.

Pendientes antes de integrar: cotejo del contrato real de Jarvis; identidad del
consumidor y binding de ámbito; autorización operacional; transporte y timeouts;
almacenamiento/deduplicación de efectos en consumidor; protocolo de entrega al canal,
preferencias, retención y rotación de claves. Ninguno se activa en este incremento.
No se introducen nuevas reglas de presupuesto, dinero, deudas o notificaciones.
