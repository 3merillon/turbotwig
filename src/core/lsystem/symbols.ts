/**
 * L-system symbol vocabulary.
 *
 * Standard turtle interpretation symbols:
 * - F(len)    Move forward, drawing a branch segment
 * - f(len)    Move forward without drawing
 * - +         Turn right (yaw +)
 * - -         Turn left (yaw -)
 * - ^         Pitch up
 * - v / &     Pitch down
 * - \\        Roll clockwise
 * - /         Roll counter-clockwise
 * - |         Turn around (180° yaw)
 * - [         Push state onto stack
 * - ]         Pop state from stack
 * - !         Decrease radius by radiusScale
 * - '         Increment segment index
 * - A-Z       Non-drawing symbols (used as production rule targets)
 */

export const SYM = {
  FORWARD: 'F',
  FORWARD_NO_DRAW: 'f',
  YAW_POS: '+',
  YAW_NEG: '-',
  PITCH_UP: '^',
  PITCH_DOWN: '&',
  ROLL_CW: '\\',
  ROLL_CCW: '/',
  TURN_AROUND: '|',
  PUSH: '[',
  POP: ']',
  RADIUS_SHRINK: '!',
  SEG_INC: "'",
} as const;

/** Union type of all recognized turtle symbol characters. */
export type SymbolChar = typeof SYM[keyof typeof SYM];

/** A single symbol extracted from an L-system string, with its numeric parameters. */
export interface ParsedSymbol {
  char: string;
  params: number[];
}

/**
 * Parse an L-system string into symbol + parameter pairs.
 * Supports syntax: F(10) +(30) [F(5)A]
 * Symbols without params get empty param array.
 */
export function parseSymbolString(input: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    i++;

    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') continue;

    const params: number[] = [];

    if (i < input.length && input[i] === '(') {
      i++; // skip '('
      let paramStr = '';
      while (i < input.length && input[i] !== ')') {
        paramStr += input[i];
        i++;
      }
      i++; // skip ')'
      params.push(...paramStr.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n)));
    }

    symbols.push({ char, params });
  }

  return symbols;
}
