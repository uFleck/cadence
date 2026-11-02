// A version the user is still writing survives leaving the card, switching views and closing the app.
// It is only UI state, so it lives in the webview's storage and not in the database.

const key = (messageId: string) => `cadence.draft.${messageId}`;

export function loadDraft(messageId: string): string {
  try {
    return localStorage.getItem(key(messageId)) ?? "";
  } catch {
    return "";
  }
}

/** An empty draft removes the entry. Storage that is full or blocked is ignored: the draft just does not persist. */
export function storeDraft(messageId: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(key(messageId), text);
    else localStorage.removeItem(key(messageId));
  } catch {
    /* nothing to do */
  }
}
