let currentTabId = null;
let currentTabUrl = '';
let currentSiteKey = null;
let updateInterval = null;
let selectMode = false;
const feeds = new Map();
const selected = new Set();

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
    copy: [
        'M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666',
        'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1'
    ],
    check: ['M5 12l5 5l9 -9'],
    close: ['M18 6l-12 12', 'M6 6l12 12'],
    checklist: [
        'M9.615 20h-2.615a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8',
        'M14 19l2 2l4 -4',
        'M9 8h4',
        'M9 12h2'
    ],
    download: [
        'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2',
        'M7 11l5 5l5 -5',
        'M12 4l0 12'
    ]
};

const $ = id => document.getElementById(id);

function i18n(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions);
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const msg = i18n(el.getAttribute('data-i18n'));
        if (msg) el.textContent = msg;
    });
}

function createIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', name === 'check' ? '2.5' : '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'icon');

    ICONS[name].forEach(d => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    });

    return svg;
}

function getHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
        return '';
    }
}

function feedTitle(feed) {
    if (feed.source === 'guess') return i18n('feedGuessTitle') || 'Probable RSS';
    return feed.title || i18n('feedDefaultTitle');
}

function opmlName(feed) {
    if (feed.source !== 'guess' && feed.title && feed.title !== feed.url) return feed.title;
    try {
        const url = new URL(feed.url);
        return url.hostname + url.pathname;
    } catch (e) {
        return feed.url;
    }
}

function escapeXml(value) {
    return String(value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildOpml(list) {
    const title = i18n('opmlTitle', [getHost(currentTabUrl) || 'RSS Finder']);
    const htmlUrl = escapeXml(currentTabUrl);

    const outlines = list.map(feed => {
        const name = escapeXml(opmlName(feed));
        return `        <outline type="rss" text="${name}" title="${name}" xmlUrl="${escapeXml(feed.url)}" htmlUrl="${htmlUrl}"/>`;
    });

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        '    <head>',
        `        <title>${escapeXml(title)}</title>`,
        `        <dateCreated>${new Date().toUTCString()}</dateCreated>`,
        '    </head>',
        '    <body>',
        ...outlines,
        '    </body>',
        '</opml>',
        ''
    ].join('\n');
}

function downloadFile(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function targetFeeds() {
    const all = [...feeds.values()];
    return selectMode ? all.filter(feed => selected.has(feed.url)) : all;
}

function setButton(button, icon, label) {
    button.title = label;
    button.setAttribute('aria-label', label);

    if (button.dataset.icon !== icon) {
        button.dataset.icon = icon;
        button.replaceChildren(createIcon(icon));
    }
}

function flash(button, key) {
    button.dataset.flash = '1';
    setButton(button, 'check', i18n(key));
    clearTimeout(button.flashTimer);
    button.flashTimer = setTimeout(() => {
        delete button.dataset.flash;
        updateSelectionUI();
    }, 1800);
}

function exportOpml() {
    const list = targetFeeds();
    if (list.length === 0) return;

    const host = getHost(currentTabUrl) || 'feeds';
    const date = new Date().toISOString().slice(0, 10);

    downloadFile(buildOpml(list), `rss-${host}-${date}.opml`, 'text/x-opml;charset=utf-8');
    flash($('exportOpml'), 'exportDone');
}

async function copyLinks() {
    const list = targetFeeds();
    if (list.length === 0) return;

    try {
        await navigator.clipboard.writeText(list.map(feed => feed.url).join('\n'));
        flash($('copyAll'), 'copiedLabel');
    } catch (err) {
        console.error(i18n('debugCopyError'), err);
    }
}

function setSelectMode(on) {
    selectMode = on;
    $('card').classList.toggle('select-mode', on);

    if (!on) {
        selected.clear();
        document.querySelectorAll('#rssLinks .feed-check').forEach(box => {
            box.checked = false;
        });
    }

    updateSelectionUI();
}

function updateSelectionUI() {
    const total = feeds.size;
    const count = selected.size;
    const targetCount = selectMode ? count : total;

    $('selectToggle').disabled = total === 0;
    $('selectToggle').classList.toggle('active', selectMode);
    setButton($('selectToggle'), selectMode ? 'close' : 'checklist', i18n(selectMode ? 'buttonCancel' : 'buttonSelect'));
    $('selectAllRow').hidden = !selectMode || total === 0;
    $('selectedCount').textContent = i18n('selectedCount', [String(count), String(total)]);

    const selectAll = $('selectAll');
    selectAll.checked = total > 0 && count === total;
    selectAll.indeterminate = count > 0 && count < total;

    $('exportOpml').disabled = targetCount === 0;
    $('copyAll').disabled = targetCount === 0;

    if (!$('exportOpml').dataset.flash) setButton($('exportOpml'), 'download', i18n('exportOpml', [String(targetCount)]));
    if (!$('copyAll').dataset.flash) setButton($('copyAll'), 'copy', i18n('copyLinks'));
}

function isUnsupportedPage(url) {
    return typeof url !== 'string' || !/^https?:\/\//i.test(url);
}

function updateUI(count, isScanning) {
    $('rssLinks').hidden = count === 0;
    $('emptyState').hidden = count > 0;

    const unsupported = isUnsupportedPage(currentTabUrl);
    $('refreshButton').disabled = isScanning || unsupported;

    if (count === 0) {
        $('status').textContent = isScanning
            ? i18n('statusScanning')
            : unsupported
                ? i18n('statusUnsupportedPage')
                : i18n('statusNotFound');
        $('spinnerIcon').style.display = isScanning ? 'block' : 'none';
        $('rssIcon').style.display = isScanning ? 'none' : 'block';
    } else {
        $('status').textContent = i18n('statusFound', [String(count)]);
    }

    updateSelectionUI();
}

function resetList() {
    $('rssLinks').replaceChildren();
    feeds.clear();
    selected.clear();
    selectMode = false;
    $('card').classList.remove('select-mode');
    $('progressBar').style.width = '0%';
    updateUI(0, true);
}

function showEmptyState(message) {
    $('status').textContent = message;
    $('emptyState').hidden = false;
    $('spinnerIcon').style.display = 'none';
    $('rssIcon').style.display = 'block';
}

function addFeedToList(feed) {
    if (feeds.has(feed.url)) return;

    feeds.set(feed.url, feed);

    const li = document.createElement('li');
    li.setAttribute('data-url', feed.url);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'feed-check';
    checkbox.checked = selected.has(feed.url);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(feed.url);
        else selected.delete(feed.url);
        updateSelectionUI();
    });

    const dot = document.createElement('span');
    dot.className = 'feed-dot';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'feed-content';

    const titleSpan = document.createElement('div');
    titleSpan.className = 'feed-title';
    titleSpan.textContent = feedTitle(feed);

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
    copyButton.appendChild(createIcon('copy'));

    copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        try {
            await navigator.clipboard.writeText(feed.url);
            copyButton.classList.add('copied');
            copyButton.replaceChildren(createIcon('check'));

            setTimeout(() => {
                copyButton.classList.remove('copied');
                copyButton.replaceChildren(createIcon('copy'));
            }, 2000);
        } catch (err) {
            console.error(i18n('debugCopyError'), err);
        }
    });

    li.addEventListener('click', () => {
        if (selectMode) checkbox.click();
    });

    li.appendChild(checkbox);
    li.appendChild(dot);
    li.appendChild(contentDiv);
    li.appendChild(copyButton);

    $('rssLinks').appendChild(li);
}

async function checkForNewFeeds() {
    if (!currentTabId) return;

    try {
        const response = await chrome.runtime.sendMessage({
            action: 'getScanStatus',
            tabId: currentTabId
        });

        if (!response) return;

        if (currentSiteKey && response.currentSite !== currentSiteKey) {
            resetList();
            const tab = await chrome.tabs.get(currentTabId);
            currentTabUrl = tab.url || '';
        }

        currentSiteKey = response.currentSite;

        if (response.isValid && response.feeds) {
            response.feeds.forEach(feed => addFeedToList(feed));
        }

        updateUI(feeds.size, response.isScanning);

        if (response.totalToCheck > 0) {
            const percent = (response.totalChecked / response.totalToCheck) * 100;
            $('progressBar').style.width = `${percent}%`;
        }

    } catch (error) {
        console.debug(i18n('debugCheckError'), error);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    applyI18n();
    updateSelectionUI();

    $('selectToggle').addEventListener('click', () => setSelectMode(!selectMode));

    $('selectAll').addEventListener('change', (e) => {
        selected.clear();
        if (e.target.checked) feeds.forEach((_, url) => selected.add(url));
        document.querySelectorAll('#rssLinks .feed-check').forEach(box => {
            box.checked = e.target.checked;
        });
        updateSelectionUI();
    });

    $('exportOpml').addEventListener('click', exportOpml);
    $('copyAll').addEventListener('click', copyLinks);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
        showEmptyState(i18n('statusTabNotFound'));
        return;
    }

    currentTabId = tab.id;
    currentTabUrl = tab.url || '';

    await checkForNewFeeds();

    if (updateInterval) clearInterval(updateInterval);
    updateInterval = setInterval(checkForNewFeeds, 500);

    $('refreshButton').addEventListener('click', async () => {
        $('refreshButton').disabled = true;
        resetList();

        await chrome.runtime.sendMessage({
            action: 'refreshScan',
            tabId: currentTabId
        });
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.tabId !== currentTabId) return;
        if (message.siteKey && message.siteKey !== currentSiteKey) return;

        if (message.action === 'feedFound') {
            addFeedToList(message.feed);
            updateUI(feeds.size, true);
        }

        if (message.action === 'scanProgress') {
            const percent = (message.current / message.total) * 100;
            $('progressBar').style.width = `${percent}%`;
        }

        if (message.action === 'scanComplete') {
            updateUI(feeds.size, false);
            $('progressBar').style.width = '100%';
        }
    });
});

window.addEventListener('beforeunload', () => {
    if (updateInterval) clearInterval(updateInterval);
});
