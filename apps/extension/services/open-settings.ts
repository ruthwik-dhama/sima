/**
 * Settings get their own tab, not a view in the dropdown: Chrome closes a dropdown when a
 * permission prompt appears, which would end Test connection halfway through.
 */
export function openSettings(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
}
