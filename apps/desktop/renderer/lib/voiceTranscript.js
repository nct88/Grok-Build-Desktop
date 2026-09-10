(() => {
  /**
   * Replace the active composer selection with one speech-recognition update.
   * Keeping the original text and range makes interim recognition updates
   * idempotent and preserves text after the caret.
   *
   * @param {string} value
   * @param {number} selectionStart
   * @param {number} selectionEnd
   * @param {string} transcript
   */
  function insertAtSelection(value, selectionStart, selectionEnd, transcript) {
    const source = String(value ?? "");
    const start = Math.max(0, Math.min(Number(selectionStart) || 0, source.length));
    const end = Math.max(start, Math.min(Number(selectionEnd) || start, source.length));
    const spoken = String(transcript ?? "");
    const cursor = start + spoken.length;
    return {
      value: source.slice(0, start) + spoken + source.slice(end),
      selectionStart: cursor,
      selectionEnd: cursor,
    };
  }

  const api = { insertAtSelection };
  globalThis.GrokVoiceTranscript = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
