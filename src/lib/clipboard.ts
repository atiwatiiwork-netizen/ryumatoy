/** Copy text to the clipboard for real. navigator.clipboard needs https (live is), with a
 *  hidden-textarea execCommand fallback for older/in-app browsers (FB/LINE webview). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Bank/PromptPay number → plain digits (banking apps reject dashes/spaces on paste). */
export const digitsOnly = (s: string) => s.replace(/\D/g, '');
