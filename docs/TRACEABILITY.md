# Trazabilidad de reglas críticas

| ID | Regla | Prueba mínima que se deberá implementar |
|---|---|---|
| FIN-M01 | Dinero con precisión exacta | Decimales/monedas/redondeo sin errores float |
| FIN-M02 | Gastos y pagos sin doble conteo | Cuota registrada en caja una vez y deuda una vez |
| FIN-I01 | Idempotencia por intención | Repetición con misma carga → mismo resultado |
| FIN-I02 | Conflicto de intención | Mismo ID, distinta carga → 409/conflicto sin escribir |
| FIN-I03 | Falla después del commit | Reintento/concilia, no duplica |
| FIN-I04 | Concurrentes | Dos solicitudes idénticas, un commit |
| FIN-A01 | Sujeto/instancia autenticado | Cross-subject/instancia negado |
| FIN-C01 | Confirmaciones | Imagen suelta o pago ambiguo → pendiente |
| FIN-D01 | Deudas | Confirmar pago parcial reduce saldo, estimación diferenciada |
| FIN-S01 | Salario | Abono FIFO meses antiguos; excedente pide decisión |
| FIN-B01 | Alertas | 80/100 una vez, salto directo 100 solo una notificación |
| FIN-R01 | Recibos | No borrar sin confirmar; archivo privado original |
| FIN-BK01 | Backup/restore | Integridad restaurada y recuperación con error seguro |
| FIN-P01 | Proveedores IA | Proveedor sin privacidad adecuada → sin envío |

Esto es índice de trabajo, no pruebas implementadas. Mantener correspondencia con las 14 secciones de `docs/PRODUCT_RULES.md` y con la referencia preservada.
