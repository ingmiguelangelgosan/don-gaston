# Roadmap de Don Gastón (autónomo respecto a Jarvis)

**Regla de alcance:** el kit no habilita operación real. Los pasos se aprueban uno por uno. No abrir nuevas auditorías infinitas: criterios de salida definidos y hallazgos residuales documentados.

## Fase 0 — Fundación local (primera tarea de Codex)

- Bootstrap Node.js LTS + TypeScript estricto con herramientas de versiones verificadas.
- Estructura modular mínima, config validada, `.env.example`, `.gitignore`, README actualizado con comandos ejecutados, lint/typecheck/tests de ejemplo.
- Pruebas con datos sintéticos, sin proveedor de IA, Telegram, Docker remoto, AWS ni secretos.
- ADR inicial sobre persistencia y contrato pendiente con Jarvis (sin implementarlos).
- **Salida:** CI/linters y tests locales reproducibles; riesgos listados; sin conexión externa. Si hay incertidumbre, documentar como pendiente.

## Fase 1 — Dominio puro y libro de movimientos simulado

- Value objects monetarios; moneda ISO; validación de cantidades; identificadores estables; eventos de caja vs consumo.
- Categorías y transacción simple con prueba de no duplicación de reintentos.
- Diseño del ledger y migraciones para DB aislada *solo después de ADR*.
- **Salida:** tests exactitud, redondeo, idempotencia, no doble conteo, autorización de sujeto; sin datos reales ni Jarvis conectado.

## Fase 2 — Casos financieros MVP

- Presupuestos, gastos fijos, deudas, pagos confirmados, salario FIFO, préstamos y suscripciones; incrementos pequeños separados.
- **Salida:** pruebas de concurrencia, transacción, reversos, auditoría, permisos, informes de caja/consumo.

## Fase 3 — Comprobantes, respaldo y privacidad

- Almacenamiento privado, referencias, índices, revisión semestral, copias y restauración verificable con fixtures.
- **Salida:** RPO/RTO medidos bajo prueba controlada, revocación y acceso denegado entre sujetos; nunca borrar sin confirmación.

## Fase 4 — Contrato con Jarvis (diseño → pruebas → aprobación)

- Comparar `AGENT_PROTOCOL_DRAFT.md` con protocolo vigente Jarvis. Resolver diferencias, versionar OpenAPI/esquemas.
- Pruebas de contrato, auth, binding de `subject_ref`, tiempo de espera, reintentos, consulta por intención y revocación.
- **Salida:** aprobación de seguridad e integración por ambos repos; solo pruebas con dobles/stubs, sin Lightsail.

## Fase 5 — Piloto privado con consentimiento separado

- Requiere respaldo + recuperación demostrados, imagen/procedencia, límites y permisos, evidencia de controles críticos, responsable de incidentes y aprobación explícita.
- No incluir datos financieros reales hasta superar la puerta de despliegue.

## Controles que NO bloquean Fase 0 documental/local

- Auditoría final de Jarvis, hosting, proveedor IA y validación dinámica del egreso: son puertas de operaciones reales, no impedimentos para generar scaffold local sintético.
