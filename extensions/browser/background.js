chrome.action.onClicked.addListener(tab => {
  chrome.windows.create({ url: chrome.runtime.getURL(`panel.html?tab=${Number.isInteger(tab.id) ? tab.id : ''}`), type: 'popup', width: 480, height: 700 });
});
