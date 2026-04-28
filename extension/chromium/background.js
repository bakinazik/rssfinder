const scanningTabs = new Map();

function getSiteKey(url) {
    try {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.hostname.replace(/^www\./, '')}`;
    } catch (e) {
        return url;
    }
}

async function verifyFeed(url) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) return false;
        const contentType = response.headers.get('Content-Type');
        if (contentType) {
            if (contentType.includes('application/rss+xml') ||
                contentType.includes('application/atom+xml') ||
                contentType.includes('application/xml') ||
                contentType.includes('text/xml')) {
                return true;
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

function collectPotentialRSSFeeds(currentUrl) {
    const feeds = [];
    const foundUrls = new Set();

    function addFeed(url, title, source = 'html') {
        if (!url || foundUrls.has(url)) return;
        try {
            const absoluteUrl = new URL(url, currentUrl).href;
            feeds.push({ url: absoluteUrl, title: title || absoluteUrl, source, discoveredAt: Date.now() });
            foundUrls.add(absoluteUrl);
        } catch (e) {}
    }

    document.querySelectorAll('link[rel="alternate"]').forEach(link => {
        const type = link.getAttribute('type');
        if (type && (type.includes('rss+xml') || type.includes('atom+xml'))) {
            addFeed(link.href, link.title || 'RSS', 'link');
        }
    });

    const commonPaths = ['/feed', '/rss', '/atom', '/rss.xml', '/atom.xml', '/index.xml', '/feed.xml'];
    const urlObj = new URL(currentUrl);
    commonPaths.forEach(path => {
        try { addFeed(new URL(path, urlObj).href, 'Probable RSS', 'guess'); } catch (e) {}
    });

    if (urlObj.hostname.includes('youtube.com')) {
        const metaChannelId = document.querySelector('meta[itemprop="identifier"]')?.getAttribute('content');
        if (metaChannelId) addFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${metaChannelId}`, 'YouTube', 'platform');
        let match = currentUrl.match(/youtube\.com\/channel\/([^\/\?&]+)/) ||
                    currentUrl.match(/youtube\.com\/c\/([^\/\?&]+)/) ||
                    currentUrl.match(/youtube\.com\/user\/([^\/\?&]+)/) ||
                    currentUrl.match(/youtube\.com\/@([^\/\?&]+)/);
        if (match) {
            const channelId = match[1];
            if (currentUrl.includes('/@')) {
                addFeed(`https://www.youtube.com/feeds/videos.xml?handle=${channelId}`, 'YouTube', 'platform');
            } else {
                addFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, 'YouTube', 'platform');
            }
        }
    }

    if (urlObj.hostname.includes('reddit.com')) {
        const match = currentUrl.match(/reddit\.com\/r\/([^\/\?&]+)/);
        if (match) addFeed(`https://www.reddit.com/r/${match[1]}.rss`, 'Reddit', 'platform');
    }

    return feeds;
}

async function tabExists(tabId) {
    try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}

async function restoreFromStorage(tabId, siteKey, url) {
    try {
        const stored = await chrome.storage.session.get([`rssFeeds_${tabId}`]);
        const data = stored[`rssFeeds_${tabId}`];
        if (data && data.siteKey === siteKey && data.feeds?.length > 0) {
            if (data.url !== url) {
                await chrome.storage.session.set({
                    [`rssFeeds_${tabId}`]: { siteKey, url, feeds: data.feeds }
                });
            }
            scanningTabs.set(tabId, {
                isScanning: false,
                siteKey,
                url,
                discoveredUrls: new Set(data.feeds.map(f => f.url)),
                verifiedFeeds: [...data.feeds],
                startTime: Date.now(),
                totalChecked: data.feeds.length,
                totalToCheck: data.feeds.length
            });
            setBadge(tabId, data.feeds.length);
            return true;
        }
    } catch (e) {}
    return false;
}

function setBadge(tabId, count) {
    try {
        if (count > 0) {
            chrome.action.setBadgeText({ text: String(count), tabId });
            chrome.action.setBadgeBackgroundColor({ color: '#faa501', tabId });
        } else {
            chrome.action.setBadgeText({ text: '', tabId });
        }
    } catch (e) {}
}

async function reportFeedFound(tabId, siteKey, url, tabData, feed) {
    if (!await tabExists(tabId)) return;
    tabData.verifiedFeeds.push(feed);
    tabData.discoveredUrls.add(feed.url);
    setBadge(tabId, tabData.verifiedFeeds.length);
    await chrome.storage.session.set({
        [`rssFeeds_${tabId}`]: { siteKey, url, feeds: [...tabData.verifiedFeeds] }
    });
    chrome.runtime.sendMessage({ action: 'feedFound', tabId, siteKey, feed }).catch(() => {});
}

function isScannableUrl(url) {
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

async function startScanning(tabId, url) {
    if (!isScannableUrl(url)) return;
    if (!await tabExists(tabId)) { scanningTabs.delete(tabId); return; }

    const siteKey = getSiteKey(url);

    if (scanningTabs.has(tabId)) {
        const existing = scanningTabs.get(tabId);

        if (existing.url === url) {
            const stored = await chrome.storage.session.get([`rssFeeds_${tabId}`]);
            const data = stored[`rssFeeds_${tabId}`];
            if (data?.feeds?.length > 0) {
                setBadge(tabId, data.feeds.length);
            }
            if (existing.isScanning) return;
            existing.isScanning = false;
            scanningTabs.delete(tabId);
        }
        else if (existing.siteKey === siteKey) {
            existing.url = url;
            if (existing.verifiedFeeds?.length > 0) {
                setBadge(tabId, existing.verifiedFeeds.length);
                await chrome.storage.session.set({
                    [`rssFeeds_${tabId}`]: { siteKey, url, feeds: [...existing.verifiedFeeds] }
                });
            }
            return;
        }
        else {
            existing.isScanning = false;
        }
    } else {
        const restored = await restoreFromStorage(tabId, siteKey, url);
        if (restored) {
            const existing = scanningTabs.get(tabId);
            if (existing && existing.url === url) {
                scanningTabs.delete(tabId);
            } else if (restored) {
                return;
            }
        }
    }

    const tabData = {
        isScanning: true,
        siteKey,
        url,
        discoveredUrls: new Set(),
        verifiedFeeds: [],
        startTime: Date.now(),
        totalChecked: 0,
        totalToCheck: 0
    };
    scanningTabs.set(tabId, tabData);

    try {
        const stored = await chrome.storage.session.get([`rssFeeds_${tabId}`]);
        const prevData = stored[`rssFeeds_${tabId}`];
        if (prevData?.siteKey === siteKey && prevData?.feeds?.length > 0) {
            setBadge(tabId, prevData.feeds.length);
            tabData.verifiedFeeds = [...prevData.feeds];
            tabData.discoveredUrls = new Set(prevData.feeds.map(f => f.url));
        } else {
            setBadge(tabId, 0);
        }
    } catch (e) {
        setBadge(tabId, 0);
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: collectPotentialRSSFeeds,
            args: [url]
        });

        const potentialFeeds = results[0]?.result || [];
        tabData.totalToCheck = potentialFeeds.length;

        await chrome.storage.session.set({
            [`rssFeeds_${tabId}`]: { siteKey, url, feeds: [...tabData.verifiedFeeds] }
        });

        const linkFeeds = potentialFeeds.filter(f => f.source === 'link');
        const guessFeeds = potentialFeeds.filter(f => f.source !== 'link');

        for (const feed of linkFeeds) {
            if (!await tabExists(tabId) || !tabData.isScanning || tabData.url !== url) return;
            if (tabData.discoveredUrls.has(feed.url)) { tabData.totalChecked++; continue; }
            feed.verified = true;
            feed.verifiedAt = Date.now();
            await reportFeedFound(tabId, siteKey, url, tabData, feed);
            tabData.totalChecked++;
        }

        const verifyPromises = guessFeeds.map(async (feed) => {
            if (!await tabExists(tabId) || !tabData.isScanning || tabData.url !== url) return;
            if (tabData.discoveredUrls.has(feed.url)) { tabData.totalChecked++; return; }

            const isValid = await verifyFeed(feed.url);
            tabData.totalChecked++;

            if (!await tabExists(tabId) || !tabData.isScanning || tabData.url !== url) return;

            if (isValid && !tabData.discoveredUrls.has(feed.url)) {
                feed.verified = true;
                feed.verifiedAt = Date.now();
                await reportFeedFound(tabId, siteKey, url, tabData, feed);
            }

            chrome.runtime.sendMessage({
                action: 'scanProgress',
                tabId, siteKey,
                current: tabData.totalChecked,
                total: potentialFeeds.length,
                found: tabData.verifiedFeeds.length
            }).catch(() => {});
        });

        await Promise.all(verifyPromises);

        if (!await tabExists(tabId) || !tabData.isScanning || tabData.url !== url) return;

        tabData.isScanning = false;
        setBadge(tabId, tabData.verifiedFeeds.length);

        chrome.runtime.sendMessage({
            action: 'scanComplete',
            tabId, siteKey,
            total: tabData.verifiedFeeds.length
        }).catch(() => {});

    } catch (error) {
        const msg = error?.message || '';
        const isSilent =
            msg.includes('No tab with id') ||
            msg.includes('Cannot access a chrome://') ||
            msg.includes('Cannot access a chrome-extension://') ||
            msg.includes('Cannot access contents of url') ||
            msg.includes('Missing host permission');
        if (!isSilent) {
            console.error('Scan error:', error);
        }
        if (await tabExists(tabId) && tabData) {
            tabData.isScanning = false;
        }
        scanningTabs.delete(tabId);
    }
}

chrome.webNavigation.onCompleted.addListener((details) => {
    if (details.frameId === 0 && details.url.startsWith('http')) {
        startScanning(details.tabId, details.url);
    }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0 && details.url.startsWith('http')) {
        setTimeout(() => startScanning(details.tabId, details.url), 500);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url?.startsWith('http')) {
        startScanning(tabId, changeInfo.url);
    }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab?.url?.startsWith('http')) return;
        chrome.storage.session.get([`rssFeeds_${activeInfo.tabId}`], (result) => {
            const data = result[`rssFeeds_${activeInfo.tabId}`];
            const currentSiteKey = getSiteKey(tab.url);
            if (data && data.siteKey === currentSiteKey && data.feeds.length > 0) {
                setBadge(activeInfo.tabId, data.feeds.length);
            } else {
                setBadge(activeInfo.tabId, 0);
                startScanning(activeInfo.tabId, tab.url);
            }
        });
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    scanningTabs.delete(tabId);
    chrome.storage.session.remove(`rssFeeds_${tabId}`);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getScanStatus') {
        chrome.storage.session.get([`rssFeeds_${request.tabId}`], async (result) => {
            const data = result[`rssFeeds_${request.tabId}`];
            try {
                const tab = await chrome.tabs.get(request.tabId);
                if (!tab?.url || !isScannableUrl(tab.url)) { sendResponse({ isScanning: false, feeds: [], isValid: false }); return; }
                const currentSiteKey = getSiteKey(tab.url);
                const tabData = scanningTabs.get(request.tabId) || { isScanning: false, totalChecked: 0, totalToCheck: 0 };
                const isValid = data && data.siteKey === currentSiteKey;
                sendResponse({
                    isScanning: tabData.isScanning,
                    feeds: isValid ? data?.feeds || [] : [],
                    isValid,
                    currentSite: currentSiteKey,
                    storedSite: data?.siteKey,
                    totalChecked: tabData.totalChecked,
                    totalToCheck: tabData.totalToCheck
                });
            } catch { sendResponse({ isScanning: false, feeds: [], isValid: false }); }
        });
        return true;
    }

    if (request.action === 'refreshScan') {
        chrome.tabs.get(request.tabId, (tab) => {
            if (chrome.runtime.lastError || !tab?.url || !isScannableUrl(tab.url)) { sendResponse({ started: false, error: 'Tab not found' }); return; }
            if (scanningTabs.has(request.tabId)) {
                scanningTabs.get(request.tabId).isScanning = false;
                scanningTabs.delete(request.tabId);
            }
            startScanning(request.tabId, tab.url);
            sendResponse({ started: true });
        });
        return true;
    }
});