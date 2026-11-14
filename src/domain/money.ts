import { DomainError } from './errors.ts';

/** COP only in this increment. One peso = 100 minor units (centavos). */
export class Money {
  readonly minor: bigint;
  readonly currency = 'COP' as const;

  private constructor(minor: bigint) {
    this.minor = minor;
    Object.freeze(this);
  }

  static fromMinor(minor: bigint, currency: string = 'COP'): Money {
    if (currency !== 'COP') throw new DomainError('UNSUPPORTED_CURRENCY');
    if (typeof minor !== 'bigint' || minor < 0n)
      throw new DomainError('INVALID_MONEY');
    return new Money(minor);
  }

  static fromDecimal(amount: string, currency: string = 'COP'): Money {
    if (currency !== 'COP') throw new DomainError('UNSUPPORTED_CURRENCY');
    // No locale inference or rounding: excess precision is rejected.
    if (
      typeof amount !== 'string' ||
      amount.trim() !== amount ||
      !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(amount)
    )
      throw new DomainError('INVALID_MONEY');
    const [whole = '0', fraction = ''] = amount.split('.');
    return Money.fromMinor(
      BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')),
      currency,
    );
  }

  add(other: Money): Money {
    return Money.fromMinor(this.minor + other.minor, other.currency);
  }

  toJSON(): { minor: string; currency: 'COP' } {
    return { minor: this.minor.toString(), currency: this.currency };
  }
}
