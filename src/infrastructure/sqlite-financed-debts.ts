import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntentResult, Scope } from '../application/expense-store.ts';
import {
  debtFingerprint,
  paymentFingerprint,
} from '../application/financed-debt-service.ts';
import { DomainError } from '../domain/errors.ts';
import { calendarMonth, identifier } from '../domain/expenses.ts';
import { Money } from '../domain/money.ts';
import {
  buildDebtStatus,
  decidePayment,
  validateDebtDraft,
  validatePaymentDraft,
} from '../domain/financed-debts.ts';
import type {
  FinancedDebt,
  DebtPaymentDraft,
  DebtPaymentResult,
  DebtStatus,
  DebtMonthlyCashOutflow,
} from '../domain/financed-debts.ts';
import { StorageError } from './sqlite-errors.ts';
import { paymentCorrectionFingerprint } from '../application/debt-payment-corrections-service.ts';
import {
  decidePaymentCorrection,
  validateCorrectionDraft,
} from '../domain/debt-payment-corrections.ts';
import type {
  DebtPaymentCorrection,
  DebtPaymentCorrectionDraft,
  DebtPaymentHistory,
} from '../domain/debt-payment-corrections.ts';

type Row = Record<string, unknown>;
type DebtResult = FinancedDebt | DebtPaymentResult | DebtPaymentCorrection;
type Lookup = (scope: Scope, key: string) => IntentResult | undefined;
export interface DebtFaults {
  readonly afterDebtInsert?: () => void;
  readonly afterDebtPaymentInsert?: () => void;
  readonly afterDebtCommit?: () => void;
  readonly afterDebtCorrectionInsert?: () => void;
}
const maxRows = 10000;
const debtJoin = `SELECT d.*, i.fingerprint,i.result_json FROM financed_debts d JOIN debt_intents i
  ON i.instance_ref=d.instance_ref AND i.subject_ref=d.subject_ref AND i.intent_key=d.intent_key AND i.debt_id=d.id`;
const paymentJoin = `SELECT p.*, i.fingerprint,i.result_json FROM debt_payment_results p JOIN debt_intents i
  ON i.instance_ref=p.instance_ref AND i.subject_ref=p.subject_ref AND i.intent_key=p.intent_key AND i.payment_id=p.id`;
const paymentJoin006 = `SELECT p.*,COALESCE(c.replacement_fingerprint,i.fingerprint) AS fingerprint,
  COALESCE(c.replacement_json,i.result_json) AS result_json FROM debt_payment_results p JOIN debt_intents i
  ON i.instance_ref=p.instance_ref AND i.subject_ref=p.subject_ref AND i.intent_key=p.intent_key AND i.payment_id=p.id
  LEFT JOIN debt_payment_corrections c ON c.instance_ref=i.instance_ref AND c.subject_ref=i.subject_ref AND c.id=i.correction_id`;
const correctionJoin = `SELECT c.*,i.fingerprint,i.result_json,i.payment_id AS intent_payment_id FROM debt_payment_corrections c
  JOIN debt_intents i ON i.instance_ref=c.instance_ref AND i.subject_ref=c.subject_ref AND i.intent_key=c.intent_key AND i.correction_id=c.id`;
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_CORRUPT');
  return value;
}
function minor(value: unknown, currency: unknown): Money {
  const string = text(value);
  if (string.length > 4096 || !/^(0|[1-9][0-9]*)$/.test(string))
    throw new StorageError('STORAGE_CORRUPT');
  return Money.fromMinor(BigInt(string), text(currency));
}
function debtJson(result: FinancedDebt): string {
  return JSON.stringify({
    kind: result.kind,
    id: result.id,
    description: result.description,
    financedAmount: result.financedAmount,
    installmentCount: result.installmentCount,
    installmentAmount: result.installmentAmount,
    referenceOn: result.referenceOn,
    referenceBalance: result.referenceBalance,
    historicalPaidInstallments: result.historicalPaidInstallments,
    historicalPaidAmount: result.historicalPaidAmount,
    annualEffectiveRate: result.annualEffectiveRate,
    terms: result.terms,
    actorRef: result.actorRef,
    recordedAt: result.recordedAt,
  });
}
function paymentJson(result: DebtPaymentResult): string {
  return JSON.stringify({
    kind: result.kind,
    id: result.id,
    debtId: result.debtId,
    installmentNumber: result.installmentNumber,
    amount: result.amount,
    paidOn: result.paidOn,
    reference: result.reference,
    actorRef: result.actorRef,
    recordedAt: result.recordedAt,
    status: result.status,
    reviewReason: result.reviewReason,
    estimatedBalanceAfter: result.estimatedBalanceAfter,
  });
}
function correctionJson(result: DebtPaymentCorrection): string {
  return JSON.stringify({
    kind: result.kind,
    id: result.id,
    debtId: result.debtId,
    originalPaymentId: result.originalPaymentId,
    proposedReplacement: result.proposedReplacement,
    replacement: result.replacement
      ? (JSON.parse(paymentJson(result.replacement)) as unknown)
      : null,
    status: result.status,
    reviewReason: result.reviewReason,
    estimatedBalanceAfter: result.estimatedBalanceAfter,
    reason: result.reason,
    actorRef: result.actorRef,
    recordedAt: result.recordedAt,
  });
}
function correctionDraft(
  result: DebtPaymentCorrection,
): DebtPaymentCorrectionDraft {
  return {
    originalPaymentId: result.originalPaymentId,
    reason: result.reason,
    actorRef: result.actorRef,
    recordedAt: result.recordedAt,
    replacement: result.proposedReplacement,
  };
}
function rehydrateDebt(row: Row): FinancedDebt {
  try {
    identifier(text(row.instance_ref));
    identifier(text(row.subject_ref));
    identifier(text(row.intent_key));
    const raw: Omit<FinancedDebt, 'id'> = {
      kind: 'financed-debt',
      description: text(row.description),
      financedAmount: minor(row.financed_minor, row.currency),
      installmentCount: row.installment_count as number,
      installmentAmount: minor(row.installment_minor, row.currency),
      referenceOn: text(row.reference_on),
      referenceBalance: minor(row.reference_balance_minor, row.currency),
      historicalPaidInstallments: row.historical_paid_installments as number,
      historicalPaidAmount:
        row.historical_paid_minor === null
          ? null
          : minor(row.historical_paid_minor, row.currency),
      annualEffectiveRate:
        row.annual_effective_rate === null
          ? null
          : text(row.annual_effective_rate),
      terms: row.terms === null ? null : text(row.terms),
      actorRef: text(row.actor_ref),
      recordedAt: text(row.recorded_at),
    };
    const draft = validateDebtDraft(raw);
    if (JSON.stringify(draft) !== JSON.stringify(raw)) throw new Error();
    const result = Object.freeze({ ...draft, id: identifier(text(row.id)) });
    if (
      debtFingerprint(result) !== row.fingerprint ||
      debtJson(result) !== row.result_json
    )
      throw new Error();
    return result;
  } catch {
    throw new StorageError('STORAGE_CORRUPT');
  }
}
function rehydratePayment(row: Row): DebtPaymentResult {
  try {
    identifier(text(row.instance_ref));
    identifier(text(row.subject_ref));
    identifier(text(row.intent_key));
    const raw: DebtPaymentDraft = {
      debtId: text(row.debt_id),
      installmentNumber: row.installment_number as number,
      amount: minor(row.amount_minor, row.currency),
      paidOn: text(row.paid_on),
      reference: text(row.reference),
      actorRef: text(row.actor_ref),
      recordedAt: text(row.recorded_at),
    };
    const draft = validatePaymentDraft(raw);
    if (JSON.stringify(draft) !== JSON.stringify(raw)) throw new Error();
    if (row.status !== 'confirmed' && row.status !== 'review_required')
      throw new Error();
    if (
      row.review_reason !== null &&
      row.review_reason !== 'EXCEEDS_ESTIMATED_BALANCE' &&
      row.review_reason !== 'EXCEEDS_INSTALLMENT_REMAINDER'
    )
      throw new Error();
    if ((row.status === 'confirmed') !== (row.review_reason === null))
      throw new Error();
    const result: DebtPaymentResult = Object.freeze({
      ...draft,
      kind: 'debt-payment',
      id: identifier(text(row.id)),
      status: row.status,
      reviewReason: row.review_reason,
      estimatedBalanceAfter: minor(row.estimated_balance_after, row.currency),
    });
    if (
      paymentFingerprint(result) !== row.fingerprint ||
      paymentJson(result) !== row.result_json
    )
      throw new Error();
    return result;
  } catch {
    throw new StorageError('STORAGE_CORRUPT');
  }
}
function bounded(json: string, monies: readonly (Money | null)[]): void {
  if (
    Buffer.byteLength(json) > 32768 ||
    monies.some(
      (value) => value !== null && value.minor.toString().length > 4096,
    )
  )
    throw new StorageError('STORAGE_LIMIT');
}

/** Internal module on the existing connection. Parent owns lifecycle/read snapshots. */
export class SqliteFinancedDebts {
  readonly #db: DatabaseSync;
  readonly #version: number;
  constructor(db: DatabaseSync, version = 5) {
    this.#db = db;
    this.#version = version;
  }
  get #paymentJoin(): string {
    return this.#version >= 6 ? paymentJoin006 : paymentJoin;
  }
  findIntent(scope: Scope, key: string): DebtResult | undefined {
    if (this.#version >= 6) {
      const row = this.#db
        .prepare(
          `${correctionJoin} WHERE c.instance_ref=? AND c.subject_ref=? AND c.intent_key=?`,
        )
        .get(scope.instanceRef, scope.subjectRef, key);
      if (row) return this.#rehydrateCorrection(row);
    }
    const opening = this.#db
      .prepare(
        `${debtJoin} WHERE d.instance_ref=? AND d.subject_ref=? AND d.intent_key=?`,
      )
      .get(scope.instanceRef, scope.subjectRef, key);
    if (opening) return rehydrateDebt(opening);
    const payment = this.#db
      .prepare(
        `${this.#paymentJoin} WHERE p.instance_ref=? AND p.subject_ref=? AND p.intent_key=?`,
      )
      .get(scope.instanceRef, scope.subjectRef, key);
    return payment ? rehydratePayment(payment) : undefined;
  }
  #debt(scope: Scope, id: string): FinancedDebt {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(id);
    const row = this.#db
      .prepare(
        `${debtJoin} WHERE d.instance_ref=? AND d.subject_ref=? AND d.id=?`,
      )
      .get(scope.instanceRef, scope.subjectRef, id);
    if (!row) throw new DomainError('DEBT_NOT_FOUND');
    return rehydrateDebt(row);
  }
  #payments(scope: Scope, id: string): readonly DebtPaymentResult[] {
    const rows = this.#db
      .prepare(
        `${this.#paymentJoin} WHERE p.instance_ref=? AND p.subject_ref=? AND p.debt_id=? ORDER BY p.sequence LIMIT ?`,
      )
      .all(scope.instanceRef, scope.subjectRef, id, maxRows + 1);
    if (rows.length > maxRows) throw new StorageError('STORAGE_LIMIT');
    return Object.freeze(rows.map(rehydratePayment));
  }
  getDebt(scope: Scope, id: string): DebtStatus {
    const payments = this.#payments(scope, id);
    const effective = this.#effective(scope, payments);
    return Object.freeze({
      ...buildDebtStatus(this.#debt(scope, id), effective),
      payments,
      effectivePayments: effective,
    });
  }
  monthlyCashOutflow(scope: Scope, month: string): DebtMonthlyCashOutflow {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    calendarMonth(month);
    const rows = this.#db
      .prepare(
        `${this.#paymentJoin} WHERE p.instance_ref=? AND p.subject_ref=? AND p.status='confirmed'
      AND substr(p.paid_on,1,7)=? ${this.#version >= 6 ? `AND NOT EXISTS(SELECT 1 FROM debt_payment_corrections c WHERE c.instance_ref=p.instance_ref AND c.subject_ref=p.subject_ref AND c.original_payment_id=p.id AND c.status='applied')` : ''} ORDER BY p.paid_on,p.sequence LIMIT ?`,
      )
      .all(scope.instanceRef, scope.subjectRef, month, maxRows + 1);
    if (rows.length > maxRows) throw new StorageError('STORAGE_LIMIT');
    const payments = Object.freeze(rows.map(rehydratePayment));
    const total = Money.fromMinor(
      payments.reduce((sum, payment) => sum + payment.amount.minor, 0n),
    );
    return Object.freeze({ month, currency: 'COP', payments, total });
  }
  #intent(
    scope: Scope,
    key: string,
    fp: string,
    result: DebtResult,
    json: string,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO debt_intents(instance_ref,subject_ref,intent_key,debt_id,payment_id,fingerprint,result_json)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        scope.instanceRef,
        scope.subjectRef,
        key,
        result.kind === 'financed-debt' ? result.id : null,
        result.kind === 'debt-payment' ? result.id : null,
        fp,
        json,
      );
  }
  registerDebt(
    scope: Scope,
    key: string,
    fp: string,
    input: Omit<FinancedDebt, 'id'>,
    lookup: Lookup,
    faults: DebtFaults,
  ): FinancedDebt {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const draft = validateDebtDraft(input);
    const result = Object.freeze({ ...draft, id: randomUUID() });
    const json = debtJson(result);
    bounded(json, [
      result.financedAmount,
      result.installmentAmount,
      result.referenceBalance,
      result.historicalPaidAmount,
    ]);
    if (debtFingerprint(result) !== fp)
      throw new StorageError('STORAGE_CORRUPT');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = lookup(scope, key);
      if (prior) {
        if (prior.kind !== 'financed-debt' || debtFingerprint(prior) !== fp)
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return prior;
      }
      this.#db
        .prepare(
          `INSERT INTO financed_debts(instance_ref,subject_ref,id,intent_key,description,financed_minor,installment_count,
        installment_minor,reference_on,reference_balance_minor,historical_paid_installments,historical_paid_minor,
        annual_effective_rate,terms,currency,actor_ref,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          result.description,
          result.financedAmount.minor.toString(),
          result.installmentCount,
          result.installmentAmount.minor.toString(),
          result.referenceOn,
          result.referenceBalance.minor.toString(),
          result.historicalPaidInstallments,
          result.historicalPaidAmount?.minor.toString() ?? null,
          result.annualEffectiveRate,
          result.terms,
          'COP',
          result.actorRef,
          result.recordedAt,
        );
      faults.afterDebtInsert?.();
      this.#intent(scope, key, fp, result, json);
      this.#db.exec('COMMIT');
      faults.afterDebtCommit?.();
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  confirmPayment(
    scope: Scope,
    key: string,
    fp: string,
    input: DebtPaymentDraft,
    lookup: Lookup,
    faults: DebtFaults,
  ): DebtPaymentResult {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const draft = validatePaymentDraft(input);
    bounded(JSON.stringify(draft), [draft.amount]);
    if (paymentFingerprint(draft) !== fp)
      throw new StorageError('STORAGE_CORRUPT');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = lookup(scope, key);
      if (prior) {
        if (prior.kind !== 'debt-payment' || paymentFingerprint(prior) !== fp)
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return prior;
      }
      const status = this.getDebt(scope, draft.debtId);
      if (status.payments.length >= maxRows)
        throw new StorageError('STORAGE_LIMIT');
      if (this.#version >= 6) this.#checkActionCapacity(scope, draft.debtId);
      const decision = decidePayment(status.debt, status, draft);
      const result: DebtPaymentResult = Object.freeze({
        kind: 'debt-payment',
        id: randomUUID(),
        ...draft,
        ...decision,
      });
      const json = paymentJson(result);
      bounded(json, [result.amount, result.estimatedBalanceAfter]);
      this.#db
        .prepare(
          `INSERT INTO debt_payment_results(instance_ref,subject_ref,id,intent_key,debt_id,installment_number,amount_minor,currency,
        paid_on,reference,actor_ref,recorded_at,status,review_reason,estimated_balance_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          result.debtId,
          result.installmentNumber,
          result.amount.minor.toString(),
          'COP',
          result.paidOn,
          result.reference,
          result.actorRef,
          result.recordedAt,
          result.status,
          result.reviewReason,
          result.estimatedBalanceAfter.minor.toString(),
        );
      faults.afterDebtPaymentInsert?.();
      this.#intent(scope, key, fp, result, json);
      this.#db.exec('COMMIT');
      faults.afterDebtCommit?.();
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #payment(scope: Scope, id: string): DebtPaymentResult {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(id);
    const row = this.#db
      .prepare(
        `${this.#paymentJoin} WHERE p.instance_ref=? AND p.subject_ref=? AND p.id=?`,
      )
      .get(scope.instanceRef, scope.subjectRef, id);
    if (!row) throw new DomainError('PAYMENT_NOT_FOUND');
    return rehydratePayment(row);
  }
  #effective(
    scope: Scope,
    payments: readonly DebtPaymentResult[],
  ): readonly DebtPaymentResult[] {
    const withdrawn = new Set<string>();
    if (this.#version >= 6)
      for (const row of this.#db
        .prepare(
          "SELECT original_payment_id FROM debt_payment_corrections WHERE instance_ref=? AND subject_ref=? AND status='applied'",
        )
        .iterate(scope.instanceRef, scope.subjectRef))
        withdrawn.add(text(row.original_payment_id));
    return Object.freeze(
      payments.filter(
        (payment) =>
          payment.status === 'confirmed' && !withdrawn.has(payment.id),
      ),
    );
  }
  #rehydrateCorrection(row: Row): DebtPaymentCorrection {
    try {
      const scope = {
        instanceRef: identifier(text(row.instance_ref)),
        subjectRef: identifier(text(row.subject_ref)),
      };
      identifier(text(row.intent_key));
      let proposed: DebtPaymentCorrectionDraft['replacement'] = null;
      if (row.proposed_json !== null) {
        const raw = JSON.parse(text(row.proposed_json)) as {
          installmentNumber: number;
          amount: { minor: unknown; currency: unknown };
          paidOn: string;
          reference: string;
        };
        proposed = {
          installmentNumber: raw.installmentNumber,
          amount: minor(raw.amount.minor, raw.amount.currency),
          paidOn: raw.paidOn,
          reference: raw.reference,
        };
      }
      const draft = validateCorrectionDraft({
        originalPaymentId: text(row.original_payment_id),
        reason: text(row.reason),
        actorRef: text(row.actor_ref),
        recordedAt: text(row.recorded_at),
        replacement: proposed,
      });
      if (
        draft.reason !== row.reason ||
        (draft.replacement ? JSON.stringify(draft.replacement) : null) !==
          row.proposed_json
      )
        throw new Error();
      const original = this.#payment(scope, draft.originalPaymentId);
      if (original.status !== 'confirmed' || original.debtId !== row.debt_id)
        throw new Error();
      const replacement =
        row.replacement_payment_id === null
          ? null
          : this.#payment(scope, text(row.replacement_payment_id));
      if (row.intent_payment_id !== row.replacement_payment_id)
        throw new Error();
      if (replacement) {
        if (
          !draft.replacement ||
          replacement.status !== 'confirmed' ||
          replacement.debtId !== original.debtId ||
          replacement.actorRef !== draft.actorRef ||
          replacement.recordedAt !== draft.recordedAt ||
          paymentJson(replacement) !== row.replacement_json ||
          paymentFingerprint(replacement) !== row.replacement_fingerprint ||
          replacement.installmentNumber !==
            draft.replacement.installmentNumber ||
          replacement.amount.minor !== draft.replacement.amount.minor ||
          replacement.paidOn !== draft.replacement.paidOn ||
          replacement.reference !== draft.replacement.reference
        )
          throw new Error();
      } else if (
        row.replacement_json !== null ||
        row.replacement_fingerprint !== null
      )
        throw new Error();
      if (row.status !== 'applied' && row.status !== 'review_required')
        throw new Error();
      if (
        row.review_reason !== null &&
        row.review_reason !== 'EXCEEDS_ESTIMATED_BALANCE' &&
        row.review_reason !== 'EXCEEDS_INSTALLMENT_REMAINDER'
      )
        throw new Error();
      const result: DebtPaymentCorrection = Object.freeze({
        kind: 'debt-payment-correction',
        id: identifier(text(row.id)),
        debtId: original.debtId,
        originalPaymentId: original.id,
        proposedReplacement: draft.replacement,
        replacement,
        status: row.status,
        reviewReason: row.review_reason,
        estimatedBalanceAfter: minor(row.estimated_balance_after, 'COP'),
        reason: draft.reason,
        actorRef: draft.actorRef,
        recordedAt: draft.recordedAt,
      });
      if (
        paymentCorrectionFingerprint(draft) !== row.fingerprint ||
        correctionJson(result) !== row.result_json
      )
        throw new Error();
      return result;
    } catch {
      throw new StorageError('STORAGE_CORRUPT');
    }
  }
  getPaymentHistory(scope: Scope, id: string): DebtPaymentHistory {
    const payment = this.#payment(scope, id);
    const outgoing = this.#db
      .prepare(
        `${correctionJoin} WHERE c.instance_ref=? AND c.subject_ref=? AND c.original_payment_id=? AND c.status='applied'`,
      )
      .get(scope.instanceRef, scope.subjectRef, id);
    const incoming = this.#db
      .prepare(
        `${correctionJoin} WHERE c.instance_ref=? AND c.subject_ref=? AND c.replacement_payment_id=?`,
      )
      .get(scope.instanceRef, scope.subjectRef, id);
    const correctedBy = outgoing ? this.#rehydrateCorrection(outgoing) : null,
      replaces = incoming ? this.#rehydrateCorrection(incoming) : null;
    return Object.freeze({
      payment,
      status: correctedBy
        ? correctedBy.replacement
          ? 'replaced'
          : 'voided'
        : payment.status === 'confirmed'
          ? 'active'
          : 'review_required',
      correctedBy,
      replaces,
    });
  }
  correctPayment(
    scope: Scope,
    key: string,
    fp: string,
    input: DebtPaymentCorrectionDraft,
    lookup: Lookup,
    faults: DebtFaults,
  ): DebtPaymentCorrection {
    identifier(scope.instanceRef);
    identifier(scope.subjectRef);
    identifier(key);
    const draft = validateCorrectionDraft(input);
    bounded(JSON.stringify(draft), [draft.replacement?.amount ?? null]);
    if (paymentCorrectionFingerprint(draft) !== fp)
      throw new StorageError('STORAGE_CORRUPT');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = lookup(scope, key);
      if (prior) {
        if (
          prior.kind !== 'debt-payment-correction' ||
          paymentCorrectionFingerprint(correctionDraft(prior)) !== fp
        )
          throw new DomainError('IDEMPOTENCY_CONFLICT');
        this.#db.exec('COMMIT');
        return prior;
      }
      const original = this.#payment(scope, draft.originalPaymentId);
      const status = this.getDebt(scope, original.debtId);
      if (status.payments.length >= maxRows)
        throw new StorageError('STORAGE_LIMIT');
      this.#checkActionCapacity(scope, original.debtId);
      const decision = decidePaymentCorrection(
        status.debt,
        status.effectivePayments,
        original,
        draft,
      );
      const replacement: DebtPaymentResult | null =
        draft.replacement && decision.replacementDecision
          ? Object.freeze({
              kind: 'debt-payment',
              id: randomUUID(),
              debtId: original.debtId,
              ...draft.replacement,
              actorRef: draft.actorRef,
              recordedAt: draft.recordedAt,
              ...decision.replacementDecision,
            })
          : null;
      const result: DebtPaymentCorrection = Object.freeze({
        kind: 'debt-payment-correction',
        id: randomUUID(),
        debtId: original.debtId,
        originalPaymentId: original.id,
        proposedReplacement: draft.replacement,
        replacement,
        status: decision.status,
        reviewReason: decision.reviewReason,
        estimatedBalanceAfter: decision.estimatedBalanceAfter,
        reason: draft.reason,
        actorRef: draft.actorRef,
        recordedAt: draft.recordedAt,
      });
      const json = correctionJson(result);
      bounded(json, [
        result.estimatedBalanceAfter,
        replacement?.amount ?? null,
      ]);
      this.#db
        .prepare(
          `INSERT INTO debt_payment_corrections(instance_ref,subject_ref,id,intent_key,debt_id,original_payment_id,proposed_json,
        replacement_payment_id,replacement_json,replacement_fingerprint,status,review_reason,estimated_balance_after,reason,actor_ref,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          result.id,
          key,
          result.debtId,
          original.id,
          draft.replacement ? JSON.stringify(draft.replacement) : null,
          replacement?.id ?? null,
          replacement ? paymentJson(replacement) : null,
          replacement ? paymentFingerprint(replacement) : null,
          result.status,
          result.reviewReason,
          result.estimatedBalanceAfter.minor.toString(),
          result.reason,
          result.actorRef,
          result.recordedAt,
        );
      faults.afterDebtCorrectionInsert?.();
      if (replacement) {
        this.#db
          .prepare(
            `INSERT INTO debt_payment_results(instance_ref,subject_ref,id,intent_key,debt_id,installment_number,amount_minor,currency,
          paid_on,reference,actor_ref,recorded_at,status,review_reason,estimated_balance_after) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            scope.instanceRef,
            scope.subjectRef,
            replacement.id,
            key,
            replacement.debtId,
            replacement.installmentNumber,
            replacement.amount.minor.toString(),
            'COP',
            replacement.paidOn,
            replacement.reference,
            replacement.actorRef,
            replacement.recordedAt,
            'confirmed',
            null,
            replacement.estimatedBalanceAfter.minor.toString(),
          );
        faults.afterDebtPaymentInsert?.();
      }
      this.#db
        .prepare(
          'INSERT INTO debt_intents(instance_ref,subject_ref,intent_key,payment_id,correction_id,fingerprint,result_json) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          scope.instanceRef,
          scope.subjectRef,
          key,
          replacement?.id ?? null,
          result.id,
          fp,
          json,
        );
      this.#db.exec('COMMIT');
      faults.afterDebtCommit?.();
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #checkActionCapacity(scope: Scope, debtId: string): void {
    const count = this.#db
      .prepare(
        'SELECT count(*) AS count FROM debt_payment_actions WHERE instance_ref=? AND subject_ref=? AND debt_id=?',
      )
      .get(scope.instanceRef, scope.subjectRef, debtId)?.count;
    if (typeof count !== 'number' || count >= maxRows)
      throw new StorageError('STORAGE_LIMIT');
  }
  #verifyTimeline(
    scope: Scope,
    debt: FinancedDebt,
    payments: readonly DebtPaymentResult[],
  ): void {
    const rows = this.#db
      .prepare(
        `${correctionJoin} WHERE c.instance_ref=? AND c.subject_ref=? AND c.debt_id=?`,
      )
      .all(scope.instanceRef, scope.subjectRef, debt.id);
    if (rows.length > maxRows) throw new StorageError('STORAGE_LIMIT');
    const corrections = new Map(
      rows.map((row) => {
        const result = this.#rehydrateCorrection(row);
        return [result.id, result] as const;
      }),
    );
    const allPayments = new Map(
      payments.map((payment) => [payment.id, payment]),
    );
    const active = new Map<string, DebtPaymentResult>();
    const seenPayments = new Set<string>(),
      seenCorrections = new Set<string>();
    const actions = this.#db
      .prepare(
        'SELECT payment_id,correction_id FROM debt_payment_actions WHERE instance_ref=? AND subject_ref=? AND debt_id=? ORDER BY sequence LIMIT ?',
      )
      .all(scope.instanceRef, scope.subjectRef, debt.id, maxRows + 1);
    if (actions.length > maxRows) throw new StorageError('STORAGE_LIMIT');
    for (const action of actions) {
      if (action.payment_id !== null) {
        const payment = allPayments.get(text(action.payment_id));
        if (!payment || seenPayments.has(payment.id)) throw new Error();
        const decision = decidePayment(
          debt,
          buildDebtStatus(debt, [...active.values()]),
          payment,
        );
        if (
          decision.status !== payment.status ||
          decision.reviewReason !== payment.reviewReason ||
          decision.estimatedBalanceAfter.minor !==
            payment.estimatedBalanceAfter.minor
        )
          throw new Error();
        seenPayments.add(payment.id);
        if (payment.status === 'confirmed') active.set(payment.id, payment);
      } else {
        const correction = corrections.get(text(action.correction_id));
        if (
          !correction ||
          seenCorrections.has(correction.id) ||
          !seenPayments.has(correction.originalPaymentId)
        )
          throw new Error();
        const original = allPayments.get(correction.originalPaymentId);
        if (!original) throw new Error();
        const decision = decidePaymentCorrection(
          debt,
          [...active.values()],
          original,
          correctionDraft(correction),
        );
        if (
          decision.status !== correction.status ||
          decision.reviewReason !== correction.reviewReason ||
          decision.estimatedBalanceAfter.minor !==
            correction.estimatedBalanceAfter.minor
        )
          throw new Error();
        if (correction.status === 'applied') {
          active.delete(original.id);
          if (correction.replacement) {
            const replacement = correction.replacement;
            if (
              !decision.replacementDecision ||
              seenPayments.has(replacement.id) ||
              replacement.estimatedBalanceAfter.minor !==
                decision.estimatedBalanceAfter.minor
            )
              throw new Error();
            active.set(replacement.id, replacement);
            seenPayments.add(replacement.id);
          } else if (correction.proposedReplacement !== null) throw new Error();
        } else if (correction.replacement !== null) throw new Error();
        seenCorrections.add(correction.id);
      }
    }
    if (
      seenPayments.size !== allPayments.size ||
      seenCorrections.size !== corrections.size
    )
      throw new Error();
  }
  verify(): void {
    if (
      this.#db
        .prepare(
          `SELECT 1 FROM debt_intents d JOIN intents i ON i.instance_ref=d.instance_ref AND i.subject_ref=d.subject_ref AND i.intent_key=d.intent_key LIMIT 1`,
        )
        .get()
    )
      throw new StorageError('STORAGE_CORRUPT');
    for (const row of this.#db.prepare(debtJoin).iterate()) {
      try {
        const debt = rehydrateDebt(row);
        const scope = {
          instanceRef: text(row.instance_ref),
          subjectRef: text(row.subject_ref),
        };
        const payments = this.#payments(scope, debt.id);
        if (this.#version >= 6) {
          this.#verifyTimeline(scope, debt, payments);
          continue;
        }
        const accepted: DebtPaymentResult[] = [];
        // Commit sequence, not paid_on: explicit dates can be retroactive.
        for (const payment of payments) {
          const decision = decidePayment(
            debt,
            buildDebtStatus(debt, accepted),
            payment,
          );
          if (
            decision.status !== payment.status ||
            decision.reviewReason !== payment.reviewReason ||
            decision.estimatedBalanceAfter.minor !==
              payment.estimatedBalanceAfter.minor
          )
            throw new StorageError('STORAGE_CORRUPT');
          accepted.push(payment);
        }
      } catch (error) {
        if (error instanceof StorageError && error.code === 'STORAGE_LIMIT')
          throw error;
        throw new StorageError('STORAGE_CORRUPT');
      }
    }
  }
}
