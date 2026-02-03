export function stripAnsi(input: string): string {
  /* eslint-disable no-control-regex */
  const sgr = new RegExp("\\u001b\\[[0-9;]*m", "g");
  const osc8 = new RegExp("\\u001b]8;;.*?\\u001b\\\\|\\u001b]8;;\\u001b\\\\", "g");
  /* eslint-enable no-control-regex */
  return input.replace(osc8, "").replace(sgr, "");
}

export function truncateOutput(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (!text) {
    return { text: "", truncated: false };
  }
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  let tail = text.slice(-maxChars);
  const firstNewline = tail.indexOf("\n");
  if (firstNewline > 0 && firstNewline < tail.length - 1) {
    tail = tail.slice(firstNewline + 1);
  }
  tail = tail.trimStart();
  return { text: `...[truncated]\n${tail}`, truncated: true };
}
