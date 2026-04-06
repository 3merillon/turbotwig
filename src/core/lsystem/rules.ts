import type { ProductionRule } from '../../types/lsystem';
import type { SeededRandom } from '../../utils/random';

/**
 * Select a matching production rule for a given symbol, considering
 * stochastic probabilities and conditions.
 */
export function selectRule(
  char: string,
  params: number[],
  rules: ProductionRule[],
  rng: SeededRandom,
): ProductionRule | null {
  const matching = rules.filter(
    r => r.predecessor === char && (!r.condition || r.condition(params))
  );

  if (matching.length === 0) return null;

  // If any rules have probabilities, use weighted random selection
  const hasProbs = matching.some(r => r.probability !== undefined);
  if (hasProbs) {
    const totalProb = matching.reduce((sum, r) => sum + (r.probability ?? 1), 0);
    let roll = rng.next() * totalProb;
    for (const rule of matching) {
      roll -= rule.probability ?? 1;
      if (roll <= 0) return rule;
    }
    return matching[matching.length - 1];
  }

  // If multiple rules match without probabilities, pick randomly
  if (matching.length > 1) {
    return matching[Math.floor(rng.next() * matching.length)];
  }

  return matching[0];
}

/**
 * Expand a rule's successor, which can be a static string or a function.
 */
export function expandRule(rule: ProductionRule, params: number[], rng: SeededRandom): string {
  if (typeof rule.successor === 'function') {
    return rule.successor(params, rng);
  }
  return rule.successor;
}
