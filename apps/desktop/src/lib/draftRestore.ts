/**
 * The composer text after a failed send: the message that was sent comes back, but never over
 * something typed since. An empty draft takes it as is; otherwise it goes in front of the new text.
 */
export function restoreDraft(current: string, sent: string): string {
  if (!current.trim()) return sent;
  if (current.includes(sent)) return current;
  return `${sent}\n\n${current}`;
}
