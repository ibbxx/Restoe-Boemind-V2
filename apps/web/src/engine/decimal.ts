export interface DecimalPolicy {
  readonly scale: number;
  readonly rounding: "DOWN" | "HALF_UP" | "HALF_EVEN";
  readonly roundAt: "EVERY_OPERATION";
}

export function validateDecimalPolicy(policy: DecimalPolicy) {
  if (!policy || !Number.isInteger(policy.scale) || policy.scale < 0 || policy.scale > 36 ||
    !["DOWN", "HALF_UP", "HALF_EVEN"].includes(policy.rounding) || policy.roundAt !== "EVERY_OPERATION") {
    throw new TypeError("Explicit scale (0..36), rounding and EVERY_OPERATION policy required.");
  }
}

// Fixed-scale BigInt; literals and each arithmetic operation use the supplied policy, never UI precision.
export class DecimalArithmetic {
  readonly policy: DecimalPolicy;
  readonly factor: bigint;
  constructor(policy: DecimalPolicy) {
    validateDecimalPolicy(policy);
    this.policy = Object.freeze({ ...policy });
    this.factor = 10n ** BigInt(policy.scale);
  }
  divide(numerator: bigint, denominator: bigint): bigint {
    if (denominator === 0n) throw new RangeError("DIVISION_BY_ZERO");
    const negative = (numerator < 0n) !== (denominator < 0n);
    const n = numerator < 0n ? -numerator : numerator;
    const d = denominator < 0n ? -denominator : denominator;
    let quotient = n / d;
    const twiceRemainder = (n % d) * 2n;
    if (this.policy.rounding !== "DOWN" && (twiceRemainder > d ||
      (twiceRemainder === d && (this.policy.rounding === "HALF_UP" || quotient % 2n !== 0n)))) quotient++;
    const result = negative ? -quotient : quotient;
    if (result.toString().length > 256) throw new RangeError("NUMERIC_LIMIT");
    return result;
  }
  parse(text: string): bigint {
    if (typeof text !== "string" || text.length > 258 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
      throw new TypeError("INVALID_NUMBER");
    }
    const negative = text.startsWith("-");
    const [whole, fraction = ""] = text.replace(/^[+-]/, "").split(".");
    return this.divide(BigInt((whole || "0") + fraction) * this.factor * (negative ? -1n : 1n), 10n ** BigInt(fraction.length));
  }
  apply(operator: "+" | "-" | "*" | "/", a: bigint, b: bigint): bigint {
    switch (operator) {
      case "+": return this.divide(a + b, 1n);
      case "-": return this.divide(a - b, 1n);
      case "*": return this.divide(a * b, this.factor);
      case "/": return this.divide(a * this.factor, b);
    }
  }
  format(value: bigint): string {
    const sign = value < 0n ? "-" : "";
    const digits = (value < 0n ? -value : value).toString().padStart(this.policy.scale + 1, "0");
    if (!this.policy.scale) return sign + digits;
    return sign + (digits.slice(0, -this.policy.scale) + "." + digits.slice(-this.policy.scale)).replace(/\.?0+$/, "");
  }
}
