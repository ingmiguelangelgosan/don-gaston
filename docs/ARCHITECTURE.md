# Arquitectura de Don Gastón — decisión inicial

**Estado:** propuesta para revisión. El proyecto es **separado** de Sir Jarvis en código, datos, despliegue y credenciales. La separación física de repositorios NO sustituye autenticación/aislamiento de red.

## Responsabilidades

| Componente | Responsable |
|---|---|
| Telegram, audio, chat, autenticación del remitente, conversación, confirmación | Sir Jarvis |
| Clasificación, cálculos exactos, presupuestos, deudas, obligaciones, salarios, préstamos, recibos, reportes financieros | Don Gastón |
| Registro y permisos de agentes, routing, versionado y trazas entre servicios | Sir Jarvis, con validación independiente en Don Gastón |
| Libro financiero, idempotencia, almacenamiento y migraciones | Don Gastón |
| Docker, firewall, políticas de egreso y host | Operador/infraestructura Jarvis; nunca Don Gastón |

## Modelo de componentes

```text
[Telegram/web/voz] -- canal/actor --> [Sir Jarvis]
                                          |
                          binding sujeto + autorización + intención
                                          |  HTTPS/JSON v1 (borrador)
                                          v
                               [Don Gastón, API privada]
                              /       |         |       \
                          dominio   ledger    recibos   auditoría
                              \       |         |       /
                        [Almacenamiento propio y backups propios]
```

**MVP:** 1 instancia por propietario, sin soporte multiusuario compartido. Cualquier instancia que atienda múltiples sujetos exige análisis de amenazas, índices por sujeto, pruebas de aislamiento, modelo de llaves por sujeto, y aprobación antes de publicarse.

## Capas propuestas (crear en Fase 0 solo lo mínimo)

```text
src/
  app/              # bootstrap, composición, config segura
  domain/           # value objects, invariantes, casos financieros
  application/      # casos de uso y puertos (sin Telegram)
  infrastructure/   # persistencia, transacciones, backups, receipts
  interfaces/       # adaptador de protocolo con Jarvis; todavía NO activo
  shared/           # tipos, errores, auth context
migrations/         # esquema versionado cuando se apruebe almacenamiento
tests/              # fixtures sintéticas, unit, integration, contract
```

No crear carpetas vacías solo por coincidir con el esquema. No crear múltiples servicios internos.

## Flujos de negocio

**Lectura:** Jarvis verifica actor y capacidad de lectura; Don Gastón valida sujeto/instancia; consulta su proyección financiera y responde sin divulgar claves ni datos de otros sujetos.

**Mutación futura:** intención estable creada por Jarvis, solicitud con identificador y huella; Don Gastón valida permiso, precondiciones y monto, registra evento y resultado en **una transacción**, guarda respuesta idempotente. Si Jarvis no recibe respuesta, consulta el estado por el mismo identificador; nunca repite con nueva clave por incertidumbre.

**Confirmación:** operaciones ambiguas o delicadas deben volver al canal original; la confirmación liga actor, sujeto, operación, monto, moneda y vencimiento. No confiar en `confirmed=true` escrito libremente.

## Persistencia local aprobada (ADR-001)

SQLite local aislado está aprobado exclusivamente para datos sintéticos en
[ADR-001](adr/001-persistence.md). El adaptador usa `node:sqlite`, importes como texto
canónico y aritmética `bigint`. **No reutilizar la base SQLite de Jarvis**. Esto no
autoriza despliegue, información real ni un servicio multiusuario.

Fase 1D incorpora un puerto `MonthlyBudgetStore` y servicio determinista, separados
de canales. SQLite implementa revisiones de presupuesto y eventos internos; el
adaptador en memoria conserva su flujo de gastos previo. Consumo se proyecta desde
gastos vigentes, sin duplicar hechos ni materializar saldos que puedan desincronizarse.
Cada mutación evalúa los presupuestos afectados antes del mismo commit que confirma
su intención. Las lecturas de presupuesto, consumo y alertas comparten snapshot.

Las migraciones conservan hechos, intenciones y correcciones anteriores. Fase 1E
añade `EventDeliveryService` y `EventDeliveryStore`; `SqliteExpenseStore` delega las
operaciones a un componente interno sobre la misma conexión. No se crea otro
servicio ni se duplica el contenido financiero del evento.

La migración v4 añade índice secuencial durable, metadatos locales de cursor y
reconocimientos append-only. Un trigger indexa nuevas alertas dentro de su transacción
original. Las consultas usan snapshot y paginación por clave con límite superior;
los reconocimientos usan `BEGIN IMMEDIATE` y unicidad por instancia/sujeto/evento.
No hay reservas: varios lectores pueden recibir el mismo evento. La deduplicación
de efectos en el consumidor es necesaria para una entrega al menos una vez.

El cursor se cifra/autentica con AES-GCM, clave de 32 bytes generada por `node:crypto`
y persistida localmente. Vincula ámbito, posiciones e IDs de anclaje; no sustituye
autorización. Base y copias deben recibir la misma protección operativa, pendiente
para datos reales. No hay rotación de claves ni expiración del cursor implementadas.

El [contrato local v1](EVENT_DELIVERY_CONTRACT_V1.md) minimiza el payload y distingue
reconocimiento de procesamiento de entrega de notificaciones. No hay despachador,
API, scheduler ni integración con Jarvis. Su compatibilidad y deduplicación de
efectos externos siguen pendientes de una decisión y pruebas de integración.

## Integración con Jarvis: propuesta, no hecho

- HTTPS + JSON versionado, autenticado; red privada o endpoint explícitamente autorizado.
- Reutilizar las convenciones **realmente vigentes** de la especificación de agentes de Jarvis, después de cotejar su versión y semántica.
- No asumir rutas ni tokens existentes. No modificar Jarvis automáticamente.
- Idempotencia de negocio, `subject_ref` vinculado, contratos con esquema, timeout y errores tipados.
- No compartir socket Docker, token Telegram, red privilegiada, ni archivos de secretos de Jarvis.

## Decisiones fuera del MVP

MCP, eventos distribuidos, cola externa, pagos reales, multiusuario compartido, sincronización bancaria, app propia y proveedores de IA para datos personales.
