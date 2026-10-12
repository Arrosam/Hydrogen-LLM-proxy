/**
 * Copy text to the clipboard, returning whether it actually succeeded.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost),
 * so on plain-HTTP / bare-IP deployments it is undefined and a naive
 * `navigator.clipboard?.writeText()` silently no-ops (leaving stale clipboard
 * content). This falls back to the legacy execCommand path in that case.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to legacy path */
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    // The text may be an API key: it must not outlive the attempt, whatever happened.
    ta.remove();
  }
}
