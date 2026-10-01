/**
 * Effort chip selection. globalThis.GrokEffortChoice
 *
 * A user click must win over a later ACP echo. Saved layout is restored once,
 * not on every config update. Fallback is the option marked default, then
 * High — never the first row (Extra High is listed first on Grok 4.7).
 */
(() => {
  const PRODUCT_DEFAULT_EFFORT = "high";

  function normalizeEffortId(raw) {
    const compact = String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    if (!compact) return "";
    if (compact === "extrahigh" || compact === "xhigh") return "xhigh";
    if (
      compact === "none" ||
      compact === "minimal" ||
      compact === "low" ||
      compact === "medium" ||
      compact === "high" ||
      compact === "max"
    ) {
      return compact;
    }
    return String(raw ?? "").trim();
  }

  function choiceList(choices) {
    return (Array.isArray(choices) ? choices : [])
      .map((choice) => ({
        value: normalizeEffortId(choice?.value ?? choice),
        default: Boolean(choice?.default),
      }))
      .filter((choice) => choice.value);
  }

  function hasChoice(list, id) {
    return !list.length || list.some((choice) => choice.value === id);
  }

  /**
   * @param {{
   *   choices?: { value?: string, default?: boolean }[],
   *   currentValue?: string,
   *   savedEffort?: string,
   *   selectedValue?: string,
   *   userOwned?: boolean,
   *   productDefault?: string,
   * }} input
   */
  function resolveEffortValue(input) {
    const list = choiceList(input?.choices);
    const productDefault = normalizeEffortId(input?.productDefault) || PRODUCT_DEFAULT_EFFORT;
    const selected = normalizeEffortId(input?.selectedValue);
    const saved = normalizeEffortId(input?.savedEffort);
    const current = normalizeEffortId(input?.currentValue);
    if (input?.userOwned && selected && hasChoice(list, selected)) return selected;
    if (current && hasChoice(list, current)) return current;
    if (saved && hasChoice(list, saved)) return saved;
    if (selected && hasChoice(list, selected)) return selected;
    const marked = list.find((choice) => choice.default);
    if (marked) return marked.value;
    if (hasChoice(list, productDefault)) return productDefault;
    return list[0]?.value || productDefault;
  }

  /**
   * Push a saved effort to the agent only once per connect, and never after
   * the user has picked a level in this connect.
   */
  function shouldRestoreSavedEffort(input) {
    if (input?.userOwned) return false;
    const saved = normalizeEffortId(input?.savedEffort);
    const selected = normalizeEffortId(input?.selectedValue);
    if (!saved || saved === selected) return false;
    const list = choiceList(input?.choices);
    return hasChoice(list, saved);
  }

  globalThis.GrokEffortChoice = {
    PRODUCT_DEFAULT_EFFORT,
    normalizeEffortId,
    resolveEffortValue,
    shouldRestoreSavedEffort,
  };
})();
