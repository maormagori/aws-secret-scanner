const QUOTE = '"';
const BACKSLASH_BYTE = 0x5c;
const OCTAL_ESCAPE_LENGTH = 3;
const OCTAL_ESCAPE_PATTERN = /^[0-7]{3}$/;
// The escapes git's quote_c_style writes; every other byte it quotes becomes an octal escape.
const SIMPLE_ESCAPES: Record<string, number> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
};

// git C-quotes a path that contains `"`, `\`, a tab, a newline or a control character, even with
// core.quotePath=false. Octal escapes are single bytes of a UTF-8 sequence, so we work on bytes and decode once.
export function unquoteGitPath(raw: string): string {
  const isQuoted = raw.length >= 2 && raw.startsWith(QUOTE) && raw.endsWith(QUOTE);
  if (!isQuoted) {
    return raw;
  }
  // A backslash byte never occurs inside a multi-byte UTF-8 character, so scanning bytes is safe.
  const quotedBytes = Buffer.from(raw.slice(1, -1), 'utf8');
  const pathBytes: number[] = [];
  let index = 0;
  while (index < quotedBytes.length) {
    const currentByte = quotedBytes[index] ?? 0;
    if (currentByte !== BACKSLASH_BYTE) {
      pathBytes.push(currentByte);
      index += 1;
      continue;
    }
    const escape = decodeEscape(quotedBytes.toString('latin1', index + 1, index + 1 + OCTAL_ESCAPE_LENGTH));
    pathBytes.push(escape.byte);
    index += 1 + escape.length;
  }
  return Buffer.from(pathBytes).toString('utf8');
}

// `afterBackslash` holds up to three characters following the backslash.
function decodeEscape(afterBackslash: string): { byte: number; length: number } {
  if (OCTAL_ESCAPE_PATTERN.test(afterBackslash)) {
    return { byte: parseInt(afterBackslash, 8), length: OCTAL_ESCAPE_LENGTH };
  }
  const escapedCharacter = afterBackslash.charAt(0);
  const simpleEscapeByte = SIMPLE_ESCAPES[escapedCharacter];
  if (simpleEscapeByte === undefined) {
    throw new Error(`Unknown escape \\${escapedCharacter} in git path`);
  }
  return { byte: simpleEscapeByte, length: 1 };
}
