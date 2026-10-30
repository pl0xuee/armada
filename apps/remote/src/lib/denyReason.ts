/**
 * "Deny with reason", in the desktop's order: deny first, then send the
 * explanation as the next message. A reason is never sent for a deny that
 * didn't go through, and an empty reason is not a reason.
 */
export async function denyThenSend(reason: string, deny: () => Promise<boolean>, send: (text: string) => Promise<void>): Promise<boolean> {
  const text = reason.trim();
  if (!text) return false;
  if (!(await deny())) return false;
  await send(text);
  return true;
}
