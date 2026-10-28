/**
 * Copy text. The async Clipboard API only exists in secure contexts, and the
 * remote is usually opened over plain http on the LAN, so fall back to the
 * legacy selection-based copy.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.top = "0";
  el.style.left = "0";
  el.style.opacity = "0";
  el.style.fontSize = "16px"; // prevents iOS zoom
  document.body.appendChild(el);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  el.select();
  el.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  el.remove();
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}
