# AGENTS.md — Instrucciones permanentes de Don Gastón

## Identidad y límites

Estás trabajando **únicamente en el repositorio independiente Don Gastón**, agente financiero que será consumido por Sir Jarvis. NO trabajas dentro del repositorio Jarvis. NO asumas que Jarvis está disponible ni que existe una integración funcional. Las reglas financieras son propiedad de Don Gastón; Jarvis conserva canales, identidad conversacional, orquestación, confirmaciones y política global de agentes.

**Fuentes de verdad:**
1. `docs/PRODUCT_RULES.md` (reglas funcionales propias, sin cambiarlas silenciosamente).
2. `docs/REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md` (levantamiento original: mantener trazabilidad; si hay diferencia, documentarla y solicitar decisión).
3. `docs/ARCHITECTURE.md` y `docs/SECURITY.md` (frontera y amenazas).
4. `docs/AGENT_PROTOCOL_DRAFT.md` (borrador NO compatible hasta cotejar con contrato Jarvis actual).
5. `docs/ROADMAP.md` (alcance, etapas, criterios de aceptación).
6. `docs/CODEX_WORKFLOW.md`, `.codex/config.toml` y roles de subagentes (delegación).

## Reglas innegociables

- **Sin escrituras financieras reales** ni datos personales reales en Fase 0; usar fixtures sintéticas. No conectar al Jarvis desplegado ni Lightsail sin permiso específico.
- **No ejecutar pagos**, transferencias, movimientos bancarios, compras, apuestas ni APIs de producción.
- **Idempotencia obligatoria** para toda mutación futura: clave de intención estable entre reintentos; huella de payload; restricción única transaccional; misma clave+distinto payload → conflicto; incertidumbre → consultar estado, NO regenerar clave. No dar por resuelto solo porque el transporte sea idempotente.
- **Dinero exacto**: decimal seguro/unidades menores + ISO 4217, nunca JS `number` float para operaciones monetarias; redondeo documentado.
- **No doble contabilización**: separar dinero ganado de recibido, consumo de flujo de caja, deuda de pago, reembolso de ingreso. Un hecho financiero tiene una identidad estable y múltiples proyecciones.
- **Autenticación/autorización**: actor y `subject_ref` vinculados fuera del payload editable; permisos por acción/sujeto/instancia; la aplicación financiera revalida la identidad; no confiar solo en Jarvis.
- **Comprobantes privados**: acceso restringido, URLs firmadas temporales, sin nombres/valores en logs; jamás borrar automáticamente; confirmación explícita para limpieza semestral.
- **Privacidad y costo IA**: sin envío de información real a proveedores/modelos no aprobados, ni IA obligatoria en cálculos; la IA interpreta intención y el dominio decide. No activar gastos de API sin permiso.
- **Notificaciones**: ninguna de vencimiento de cuota, factura o salario sin autorización; alertas de 80/100 % y revisión mensual, máximo una por evento/periodo; revisión semestral de almacenamiento.
- **Historial y correcciones**: append-only o eventos de compensación auditables, sin alterar periodos anteriores sin rastro; solo pagos confirmados reducen obligaciones.
- **No acceso privilegiado** a Docker socket, firewall, SSH, archivos de secrets Jarvis, credenciales de Telegram, logs de producción o AWS. No instalar servicios, hacer cambios en la nube ni desplegar sin aprobación.
- **Claridad:** distinguir `implementado`, `simulado`, `pendiente` y `no verificado`. No afirmar que pasaron pruebas sin ejecutarlas.

## Stack recomendado, sujeto a decisión de Fase 0

Node.js LTS + TypeScript estricto, monolito modular **dentro de su repositorio**. Almacenamiento aislado (PostgreSQL/Supabase o SQLite según ADR y criterios de respaldo), contratos HTTP/JSON versionados a futuro; tests locales sin llamadas externas. No introducir brokers, Kubernetes, MCP, colas de pago ni frontend en Fase 0. No convertir una suposición de stack en una decisión implementada; valida la versión concreta cuando corresponda.

## Trabajo multiagente

Coordinador principal + **hasta 3 subagentes activos**: `finance_domain`, `security_reviewer` y `test_engineer`. Delegar solo tareas realmente independientes. El coordinador asigna dueño exclusivo por archivo, integra resultados y revisa fallos. No deben escribir simultáneamente en el mismo archivo ni editar Jarvis. El revisor de seguridad opera solo lectura (también debe reforzarse con permisos reales, no solo por instrucciones). Si el runtime no soporta subagentes, ejecutar los roles secuencialmente y declararlo; NO fingir ejecución en paralelo.

**Fase 0: partición recomendada:** coordinador = bootstrap y configuración; dominio = revisión de reglas/trazabilidad en un informe; seguridad = lectura/revisión de riesgos; test engineer = matriz de pruebas/documentación, sin tocar archivos comunes.

## Proceso de cada cambio

1. Inspecciona primero el estado real del repo y la fase aprobada.
2. Propón un plan corto con archivos, responsables, dependencias, riesgos y criterios de aceptación.
3. Nunca cambies reglas financieras por conveniencia técnica. Si hay contradicción entre docs, pregunta.
4. Implementa el incremento mínimo vertical; usa pruebas unitarias, integración con adaptadores falsos y fixtures sintéticas.
5. No utilices `git push`, cambios de ramas remotas, despliegues, instalaciones con costo ni migraciones sobre datos reales sin autorización.
6. Entrega resultados: archivos cambiados, commits/PR si autorizados, pruebas realmente ejecutadas, limitaciones y riesgos residuales.

## Detención obligatoria

Detente y solicita aprobación antes de: elegir proveedor de IA con datos reales, integrar con Jarvis operativo, usar tokens/credenciales, ejecutar migraciones productivas, publicar endpoints de red, activar Telegram/WhatsApp, eliminar datos o recibos, restaurar respaldos reales o iniciar la fase financiera con información personal.
