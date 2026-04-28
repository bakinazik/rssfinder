let currentTabId = null;
let currentSiteKey = null;
let updateInterval = null;
let processedUrls = new Set();

function i18n(key, substitutions) {
    return browser.i18n.getMessage(key, substitutions);
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const msg = i18n(key);
        if (msg) el.textContent = msg;
    });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function createIcon(type) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');

    if (type === 'dot') {
        svg.classList.add('dot-icon');
        svg.setAttribute('xmlns', SVG_NS);
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '6');
        circle.setAttribute('fill', 'currentColor');
        svg.appendChild(circle);
    } else if (type === 'copy') {
        svg.classList.add('copy-icon');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const blank = document.createElementNS(SVG_NS, 'path');
        blank.setAttribute('stroke', 'none');
        blank.setAttribute('d', 'M0 0h24v24H0z');
        blank.setAttribute('fill', 'none');
        const p1 = document.createElementNS(SVG_NS, 'path');
        p1.setAttribute('d', 'M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666');
        const p2 = document.createElementNS(SVG_NS, 'path');
        p2.setAttribute('d', 'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1');
        svg.appendChild(blank);
        svg.appendChild(p1);
        svg.appendChild(p2);
    } else if (type === 'check') {
        svg.classList.add('copy-icon');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2.5');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        const blank = document.createElementNS(SVG_NS, 'path');
        blank.setAttribute('stroke', 'none');
        blank.setAttribute('d', 'M0 0h24v24H0z');
        blank.setAttribute('fill', 'none');
        const p1 = document.createElementNS(SVG_NS, 'path');
        p1.setAttribute('d', 'M5 12l5 5l9 -9');
        svg.appendChild(blank);
        svg.appendChild(p1);
    }

    return svg;
}


document.addEventListener('DOMContentLoaded', async () => {
    applyI18n();

    const statusElement = document.getElementById('status');
    const rssLinksElement = document.getElementById('rssLinks');
    const progressBar = document.getElementById('progressBar');
    const refreshButton = document.getElementById('refreshButton');
    const emptyState = document.getElementById('emptyState');
    const spinnerIcon = document.getElementById('spinnerIcon');
    const rssIcon = document.getElementById('rssIcon');

    if (emptyState && rssLinksElement && emptyState.parentNode !== rssLinksElement) {
        rssLinksElement.appendChild(emptyState);
    }

    processedUrls.clear();

    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        showEmptyState(i18n('statusTabNotFound'));
        return;
    }

    currentTabId = tab.id;

    await checkForNewFeeds();

    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(checkForNewFeeds, 500);

    refreshButton.addEventListener('click', async () => {
        refreshButton.disabled = true;

        rssLinksElement.replaceChildren(emptyState || document.createDocumentFragment());
        processedUrls.clear();
        progressBar.style.width = '0%';
        statusElement.textContent = i18n('statusScanning');
        spinnerIcon.style.display = 'block';
        rssIcon.style.display = 'none';

        await browser.runtime.sendMessage({
            action: 'refreshScan',
            tabId: currentTabId
        });
    });

    browser.runtime.onMessage.addListener((message) => {
        if (message.tabId !== currentTabId) return;
        if (message.siteKey && message.siteKey !== currentSiteKey) return;

        if (message.action === 'feedFound') {
            addFeedToList(message.feed);
            updateUI(processedUrls.size, true);
        }

        if (message.action === 'scanProgress') {
            const percent = (message.current / message.total) * 100;
            progressBar.style.width = `${percent}%`;
        }

        if (message.action === 'scanComplete') {
            if (message.total > 0) {
                statusElement.textContent = i18n('statusFound', [String(message.total)]);
            } else {
                statusElement.textContent = i18n('statusNotFound');
            }
            progressBar.style.width = '100%';
            refreshButton.disabled = false;
            refreshButton.textContent = i18n('buttonRefresh');
        }
    });
});

async function checkForNewFeeds() {
    if (!currentTabId) return;

    try {
        const response = await browser.runtime.sendMessage({
            action: 'getScanStatus',
            tabId: currentTabId
        });

        if (!response) return;

        if (currentSiteKey && response.currentSite !== currentSiteKey) {
            const rssLinksElement = document.getElementById('rssLinks');
            const emptyState = document.getElementById('emptyState');

            rssLinksElement.replaceChildren(emptyState || document.createDocumentFragment());
            processedUrls.clear();
            document.getElementById('progressBar').style.width = '0%';
            document.getElementById('status').textContent = i18n('statusScanning');
            document.getElementById('spinnerIcon').style.display = 'block';
            document.getElementById('rssIcon').style.display = 'none';
        }

        currentSiteKey = response.currentSite;

        if (response.isValid && response.feeds) {
            response.feeds.forEach(feed => {
                if (!processedUrls.has(feed.url)) {
                    addFeedToList(feed);
                }
            });
        }

        updateUI(processedUrls.size, response.isScanning);

        if (!response.isScanning) {
            const refreshButton = document.getElementById('refreshButton');
            refreshButton.disabled = false;
            refreshButton.textContent = i18n('buttonRefresh');
        }

        if (response.totalToCheck > 0) {
            const progressBar = document.getElementById('progressBar');
            const percent = (response.totalChecked / response.totalToCheck) * 100;
            progressBar.style.width = `${percent}%`;
        }

    } catch (error) {
        console.debug(i18n('debugCheckError'), error);
    }
}

function addFeedToList(feed) {
    const rssLinksElement = document.getElementById('rssLinks');
    const emptyState = document.getElementById('emptyState');

    if (processedUrls.has(feed.url)) return;

    emptyState.style.display = 'none';

    const li = document.createElement('li');
    li.setAttribute('data-url', feed.url);

    const dotIcon = createIcon('dot');
    dotIcon.classList.add('feed-dot');

    const contentDiv = document.createElement('div');
    contentDiv.className = 'feed-content';

    const titleSpan = document.createElement('div');
    titleSpan.className = 'feed-title';
    titleSpan.textContent = feed.title || i18n('feedDefaultTitle');

    const link = document.createElement('a');
    link.className = 'feed-url';
    link.href = feed.url;
    link.textContent = feed.url;
    link.target = '_blank';

    contentDiv.appendChild(titleSpan);
    contentDiv.appendChild(link);

    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.title = i18n('copyButton');

    const copyIcon = createIcon('copy');
    copyButton.appendChild(copyIcon);

    copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        try {
            await navigator.clipboard.writeText(feed.url);
            copyButton.classList.add('copied');
            copyButton.replaceChildren();
            copyButton.appendChild(createIcon('check'));

            setTimeout(() => {
                copyButton.classList.remove('copied');
                copyButton.replaceChildren();
                copyButton.appendChild(createIcon('copy'));
            }, 2000);
        } catch (err) {
            console.error(i18n('debugCopyError'), err);
        }
    });

    li.appendChild(dotIcon);
    li.appendChild(contentDiv);
    li.appendChild(copyButton);

    rssLinksElement.appendChild(li);
    processedUrls.add(feed.url);
}

function updateUI(count, isScanning) {
    const statusElement = document.getElementById('status');
    const emptyState = document.getElementById('emptyState');
    const spinnerIcon = document.getElementById('spinnerIcon');
    const rssIcon = document.getElementById('rssIcon');

    if (count === 0) {
        statusElement.textContent = isScanning ? i18n('statusScanning') : i18n('statusNotFound');
        emptyState.style.display = 'flex';
        spinnerIcon.style.display = isScanning ? 'block' : 'none';
        rssIcon.style.display = isScanning ? 'none' : 'block';
    } else {
        statusElement.textContent = i18n('statusFound', [String(count)]);
        emptyState.style.display = 'none';
    }
}

function showEmptyState(message) {
    const statusElement = document.getElementById('status');
    const emptyState = document.getElementById('emptyState');

    statusElement.textContent = message;
    emptyState.style.display = 'block';
}

window.addEventListener('beforeunload', () => {
    if (updateInterval) clearInterval(updateInterval);
});