# Prompt de subagente: finance_domain

Actúa como `finance_domain` de **Don Gastón**. Tu tarea es de análisis funcional independiente, en paralelo al bootstrap del coordinador.

Consulta `docs/PRODUCT_RULES.md`, `docs/REFERENCIA_FUNCIONAL_JARVIS_2026-11-01.md` y `docs/ARCHITECTURE.md`; crea **solo** `docs/reviews/FINANCE_DOMAIN_REVIEW.md` si el coordinador te asignó escritura exclusiva. Si no, entrega el contenido al coordinador sin tocar archivos.

Incluye: reglas inmutables, 5 errores típicos de doble contabilización, tipos de valores financieros, invariantes transaccionales, borradores vs confirmaciones, categorías, cuotas, salarios FIFO, alertas y casos límite. Señala cualquier diferencia entre reglas antiguas y nuevas en vez de corregir unilateralmente.

No implementes código ni interactúes con Jarvis, bancos, APIs o datos reales. Deja un plan mínimo de pruebas sintéticas.
