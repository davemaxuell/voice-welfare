// The Python trace records finditer spans even for regexes invoked with match or fullmatch.
// Remove only the anchors the native caller adds for its invocation mode.
export function fullMatchExpression(expression: RegExp | undefined): RegExp {
  const pattern = requiredPattern(expression);
  if (!pattern.source.startsWith("^") || !pattern.source.endsWith("$")) throw new Error("expected a full-match pattern");
  return new RegExp(pattern.source.slice(1, -1), pattern.flags);
}

export function prefixMatchExpression(pattern: RegExp): RegExp {
  if (!pattern.source.startsWith("^")) throw new Error("expected a prefix-match pattern");
  return new RegExp(pattern.source.slice(1), pattern.flags);
}

export function requiredPattern(pattern: RegExp | undefined): RegExp {
  if (pattern === undefined) throw new Error("missing product regex");
  return pattern;
}
