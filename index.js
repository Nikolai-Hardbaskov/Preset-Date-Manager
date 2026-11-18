/* Preset Date Manager — client UI for SillyTavern.
 * IMPORTANT: never edit native <option> labels. SillyTavern reads those labels
 * as actual preset names for importing, renaming, slash commands and deletion.
 */
(() => {
    'use strict';

    const NS = 'preset-date-manager';
    const SELECTOR = 'select[data-preset-manager-for]';
    const ENDPOINT = '/api/plugins/preset-date-manager/dates';
    const PREFS_KEY = 'pdm:prefs:v1';
    const MODES = ['newest', 'oldest', 'az', 'za'];
    const TITLES = {
        openai: 'Chat Completion',
        textgenerationwebui: 'Text Completion',
        kobold: 'Kobold',
        novel: 'NovelAI',
        instruct: 'Instruct',
        context: 'Context',
        sysprompt: 'System Prompt',
        reasoning: 'Reasoning',
    };
    const attached = new WeakSet();
    const replacements = new Map();
    let active = null;
    let modal = null;
    let lastFocus = null;
    let metadata = {};
    let metadataReady = false;
    let lastFetch = 0;
    let fetching = null;
    let scheduled = false;
    let previousOverflow = null;

    function preferences() {
        try {
            const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
            return saved && typeof saved === 'object' ? saved : {};
        } catch {
            return {};
        }
    }

    function getSort(api) {
        const mode = preferences()[api];
        return MODES.includes(mode) ? mode : 'newest';
    }

    function setSort(api, value) {
        if (!MODES.includes(value)) return;
        try {
            const prefs = preferences();
            prefs[api] = value;
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (error) {
            console.warn('[Preset Date Manager] Unable to persist sort preference', error);
        }
    }

    function getApi(select) {
        return (select.dataset.presetManagerFor || '').split(',')[0].trim();
    }

    function nativeItems(select) {
        return Array.from(select.options).map((option, i) => ({
            value: option.value,
            name: option.textContent.trim(),
            index: i,
            disabled: option.disabled,
        }));
    }

    function details(api, name) {
        // Server plugin reads the current user's own preset directory.
        return metadata?.[api]?.[name] ?? null;
    }

    function timestamp(api, name) {
        const record = details(api, name);
        if (!record || !record.createdAt) return null;
        const date = new Date(record.createdAt);
        const ms = date.valueOf();
        return Number.isFinite(ms) ? ms : null;
    }

    function formatDate(ms) {
        return ms === null ? 'Дата неизвестна' : new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
        }).format(new Date(ms));
    }

    function dateNote(api, name) {
        const record = details(api, name);
        if (!record) return 'Историческая дата неизвестна';
        if (record.source === 'modified') return 'Дата изменения файла (не дата импорта)';
        return 'Дата создания файла на сервере (может отличаться от даты импорта)';
    }

    async function refreshMetadata(force = false) {
        if (fetching) return fetching;
        if (!force && metadataReady && Date.now() - lastFetch < 4000) return;
        fetching = (async () => {
            try {
                const response = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const json = await response.json();
                if (!json || typeof json !== 'object' || !json.groups) throw new Error('Bad plugin response');
                metadata = json.groups;
                metadataReady = true;
                lastFetch = Date.now();
            } catch (error) {
                metadataReady = false;
                metadata = {};
                console.debug('[Preset Date Manager] Server metadata not available:', error.message);
            } finally {
                fetching = null;
                updateButtons();
                if (active) renderList();
            }
        })();
        return fetching;
    }

    function updateButtons() {
        for (const [select, button] of replacements) {
            if (!select.isConnected || !button.isConnected) continue;
            const option = select.selectedOptions[0];
            const api = getApi(select);
            button.querySelector('.pdm-current-name').textContent = option?.textContent?.trim() || 'Выбрать пресет';
            button.querySelector('.pdm-current-date').textContent = option
                ? formatDate(timestamp(api, option.textContent.trim()))
                : '';
        }
    }

    function attach(select) {
        if (attached.has(select) || !select.parentElement) return;
        attached.add(select);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pdm-open';
        button.setAttribute('aria-label', 'Выбрать пресет и сортировать по дате');
        button.innerHTML = '<span class="pdm-selected"><span class="pdm-current-name"></span><small class="pdm-current-date"></small></span><span class="pdm-chevron" aria-hidden="true">⌄</span>';
        // Do not remove the native select: SillyTavern references it internally.
        select.classList.add('pdm-original');
        select.parentElement.insertBefore(button, select.nextSibling);
        replacements.set(select, button);
        button.addEventListener('click', () => openModal(select));
        select.addEventListener('change', updateButtons);
        // ST triggers some changes with jQuery, which do not always reach DOM listeners.
        if (typeof window.jQuery === 'function') {
            window.jQuery(select).on('change.presetDateManager', updateButtons);
        }
        const observer = new MutationObserver(() => {
            updateButtons();
            if (active?.select === select) renderList();
        });
        observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['selected', 'value'] });
        updateButtons();
    }

    function scan() {
        document.querySelectorAll(SELECTOR).forEach(attach);
        for (const [select, button] of replacements) {
            if (!select.isConnected) {
                button.remove();
                replacements.delete(select);
            }
        }
    }

    function scheduleScan() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            scan();
        });
    }

    function el(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function buildModal() {
        const backdrop = el('div', 'pdm-overlay');
        const panel = el('section', 'pdm-panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', 'Список пресетов');

        const header = el('div', 'pdm-header');
        const left = el('div', 'pdm-heading');
        left.append(el('span', 'pdm-heading-title', 'Пресеты'), el('small', 'pdm-count', ''));
        const close = el('button', 'pdm-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', 'Закрыть');
        close.addEventListener('click', closeModal);
        header.append(left, close);

        const toolbar = el('div', 'pdm-toolbar');
        const search = el('input', 'pdm-search');
        search.type = 'search';
        search.autocomplete = 'off';
        search.placeholder = 'Поиск пресета…';
        search.setAttribute('aria-label', 'Поиск пресета');
        search.addEventListener('input', renderList);
        const sort = el('select', 'pdm-sort');
        sort.setAttribute('aria-label', 'Сортировка пресетов');
        [
            ['newest', 'Сначала новые'],
            ['oldest', 'Сначала старые'],
            ['az', 'Название: А–Я'],
            ['za', 'Название: Я–А'],
        ].forEach(([value, text]) => {
            const option = el('option', '', text);
            option.value = value;
            sort.append(option);
        });
        sort.addEventListener('change', () => {
            if (!active) return;
            setSort(active.api, sort.value);
            renderList();
        });
        toolbar.append(search, sort);
        const note = el('p', 'pdm-note');
        const list = el('div', 'pdm-list');
        list.setAttribute('role', 'listbox');
        panel.append(header, toolbar, note, list);
        backdrop.append(panel);
        backdrop.addEventListener('pointerdown', (event) => {
            if (event.target === backdrop) closeModal();
        });
        backdrop.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeModal();
            }
            if (event.key === 'Tab') {
                const elements = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])'));
                const first = elements[0];
                const last = elements[elements.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault(); first.focus();
                }
            }
        });
        return backdrop;
    }

    function sortedItems() {
        if (!active) return [];
        const { api, select } = active;
        const search = modal.querySelector('.pdm-search').value.trim().toLocaleLowerCase('ru-RU');
        const mode = getSort(api);
        const items = nativeItems(select).filter(item => item.name.toLocaleLowerCase('ru-RU').includes(search));
        const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
        items.sort((a, b) => {
            const compare = collator.compare(a.name, b.name);
            if (mode === 'az') return compare || a.index - b.index;
            if (mode === 'za') return -compare || a.index - b.index;
            const ad = timestamp(api, a.name);
            const bd = timestamp(api, b.name);
            if (ad === null && bd !== null) return 1;
            if (bd === null && ad !== null) return -1;
            if (ad !== null && bd !== null && ad !== bd) {
                return mode === 'newest' ? bd - ad : ad - bd;
            }
            return compare || a.index - b.index;
        });
        return items;
    }

    function renderList() {
        if (!active || !modal) return;
        const { api, select } = active;
        const count = modal.querySelector('.pdm-count');
        const note = modal.querySelector('.pdm-note');
        const list = modal.querySelector('.pdm-list');
        const items = sortedItems();
        count.textContent = (TITLES[api] || api) + ' · ' + items.length + ' шт.';
        note.textContent = metadataReady
            ? 'Дата = создание файла на сервере; это не всегда точное время первоначального импорта.'
            : 'Для дат уже существующих пресетов установи серверный модуль из архива.';
        const fragment = document.createDocumentFragment();
        for (const item of items) {
            const row = el('button', 'pdm-item');
            row.type = 'button';
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(item.value === select.value));
            row.disabled = item.disabled;
            if (item.value === select.value) row.classList.add('pdm-active');
            const text = el('span', 'pdm-item-content');
            text.append(el('span', 'pdm-item-name', item.name));
            const date = el('small', 'pdm-item-date', formatDate(timestamp(api, item.name)));
            date.title = dateNote(api, item.name);
            text.append(date);
            row.append(text, el('span', 'pdm-item-indicator', item.value === select.value ? '●' : '○'));
            row.addEventListener('click', () => {
                if (select.value !== item.value) {
                    // The original select and option labels remain unmodified.
                    const jquery = window.jQuery || window.$;
                    if (typeof jquery === 'function') {
                        jquery(select).val(item.value).trigger('change');
                    } else {
                        select.value = item.value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                updateButtons();
                closeModal();
            });
            fragment.append(row);
        }
        if (!items.length) fragment.append(el('p', 'pdm-empty', 'Ничего не найдено'));
        list.replaceChildren(fragment);
    }

    function openModal(select) {
        if (active) closeModal();
        lastFocus = document.activeElement;
        const api = getApi(select);
        active = { select, api };
        modal = buildModal();
        modal.querySelector('.pdm-sort').value = getSort(api);
        document.body.append(modal);
        previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        renderList();
        modal.querySelector('.pdm-search').focus({ preventScroll: true });
        refreshMetadata(true);
    }

    function closeModal() {
        if (!active) return;
        modal?.remove();
        modal = null;
        active = null;
        document.body.style.overflow = previousOverflow ?? '';
        previousOverflow = null;
        if (lastFocus?.isConnected) lastFocus.focus({ preventScroll: true });
        lastFocus = null;
    }

    function init() {
        scan();
        const observer = new MutationObserver((records) => {
            if (records.some(record => Array.from(record.addedNodes).some(node =>
                node.nodeType === Node.ELEMENT_NODE && (node.matches?.(SELECTOR) || node.querySelector?.(SELECTOR))))) {
                scheduleScan();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // The selected option can change through original ST features such as /preset.
        const context = window.SillyTavern?.getContext?.();
        if (context?.eventSource && context?.eventTypes) {
            for (const key of ['PRESET_CHANGED', 'MAIN_API_CHANGED', 'SETTINGS_UPDATED']) {
                const type = context.eventTypes[key];
                if (type) context.eventSource.on(type, updateButtons);
            }
        }
        refreshMetadata();
        console.info('[Preset Date Manager] Ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
