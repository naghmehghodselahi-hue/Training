// Clicking the toolbar icon on the video tab does two things:
// 1. Opens the side panel.
// 2. Grants "activeTab" for that tab, which tab audio capture requires.
// We remember which tab was clicked so the panel knows what to record.

chrome.action.onClicked.addListener((tab) => {
  // sidePanel.open must run synchronously inside the click gesture.
  chrome.sidePanel.open({ tabId: tab.id });
  chrome.storage.session.set({
    targetTabId: tab.id,
    targetTitle: tab.title || "this tab",
  });
});
