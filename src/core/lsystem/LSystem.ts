import type { LSystemConfig, ProductionRule } from '../../types/lsystem';
import { SeededRandom } from '../../utils/random';
import { parseSymbolString, type ParsedSymbol } from './symbols';
import { selectRule, expandRule } from './rules';

/** Parametric L-system that iteratively rewrites a symbol string using production rules. */
export class LSystem {
  private config: LSystemConfig;
  private rng: SeededRandom;

  constructor(config: LSystemConfig, seed: number = 12345) {
    this.config = config;
    this.rng = new SeededRandom(seed);
  }

  /**
   * Run the L-system for the configured number of iterations.
   * Returns the final symbol string.
   */
  generate(): string {
    let current = this.config.axiom;

    for (let iter = 0; iter < this.config.iterations; iter++) {
      current = this.iterate(current, this.config.rules);
    }

    return current;
  }

  /**
   * Single iteration: parse current string, apply rules, produce new string.
   */
  private iterate(input: string, rules: ProductionRule[]): string {
    const symbols = parseSymbolString(input);
    const parts: string[] = [];

    for (const sym of symbols) {
      const rule = selectRule(sym.char, sym.params, rules, this.rng);

      if (rule) {
        // Pass [defaultAngle, defaultLength] as params for rule functions
        // so they can use the current UI-controlled values
        const ruleParams = sym.params.length > 0
          ? sym.params
          : [this.config.defaultAngle, this.config.defaultLength, this.config.defaultSubAngle,
             this.config.whorlTaper ?? 1, this.config.whorlMaxBranches ?? 5, this.config.whorlBranchReduction ?? 0.4];
        parts.push(expandRule(rule, ruleParams, this.rng));
      } else {
        // No matching rule — copy symbol through unchanged
        parts.push(this.symbolToString(sym));
      }
    }

    return parts.join('');
  }

  private symbolToString(sym: ParsedSymbol): string {
    if (sym.params.length === 0) return sym.char;
    return `${sym.char}(${sym.params.join(',')})`;
  }

  /** Replace the internal PRNG with a new seed. */
  setSeed(seed: number): void {
    this.rng = new SeededRandom(seed);
  }

  /** Replace the L-system configuration (axiom, rules, iterations, defaults). */
  setConfig(config: LSystemConfig): void {
    this.config = config;
  }
}
