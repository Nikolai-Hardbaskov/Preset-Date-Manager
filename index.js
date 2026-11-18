/* Preset Date Manager — client UI for SillyTavern.
 * IMPORTANT: never edit native <option> labels. SillyTavern reads those labels
 * as actual preset names for importing, renaming, slash commands and deletion.
 */
(() => {
    'use strict';

    const NS = 'preset-date-manager';
    const SELECTOR = 'select[data-preset-manager-for]';
    const PREFS_KEY = 'pdm:prefs:v1';
    const DATES_STORAGE_KEY = 'preset-date-manager';
    const DATES_FALLBACK_KEY = 'pdm:dates:v2';
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
    let localBackup = null;
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

    // Preset creation/import dates are not included in SillyTavern's regular preset API.
    // Store the first moment this extension sees each preset in the user's normal
    // SillyTavern extension settings. No server plugin, filesystem access or new API required.
    function getDateStore() {
        const context = window.SillyTavern?.getContext?.();
        const settings = context?.extensionSettings;
        if (settings && typeof settings === 'object') {
            const holder = settings[DATES_STORAGE_KEY] ??= { dates: {} };
            if (!holder.dates || typeof holder.dates !== 'object') holder.dates = {};
            return holder;
        }
        if (!localBackup) {
            try {
                localBackup = JSON.parse(localStorage.getItem(DATES_FALLBACK_KEY) || '{}');
            } catch {
                localBackup = {};
            }
            localBackup.dates ||= {};
        }
        return localBackup;
    }

    function saveDateStore() {
        const context = window.SillyTavern?.getContext?.();
        if (context?.extensionSettings && typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        } else {
            try {
                localStorage.setItem(DATES_FALLBACK_KEY, JSON.stringify(getDateStore()));
            } catch (error) {
                console.warn('[Preset Date Manager] Cannot persist dates:', error);
            }
        }
    }

    function getRecord(api, name) {
        return getDateStore().dates?.[api]?.[name] ?? null;
    }

    function watchNewPresets(select) {
        const api = getApi(select);
        if (!api) return;
        const store = getDateStore();
        const group = store.dates[api] ??= {};
        const now = new Date().toISOString();
        let changed = false;
        for (const item of nativeItems(select)) {
            if (!item.name || group[item.name]) continue;
            group[item.name] = { at: now, source: 'first-seen' };
            changed = true;
        }
        if (changed) saveDateStore();
    }

    function timestamp(api, name) {
        const raw = getRecord(api, name)?.at;
        if (!raw) return null;
        const ms = new Date(raw).getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    function formatDate(ms) {
        return ms === null ? 'Дата неизвестна' : new Intl.DateTimeFormat('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
        }).format(new Date(ms));
    }

    function dateNote(api, name) {
        const record = getRecord(api, name);
        if (!record) return 'Дата неизвестна';
        return record.source === 'manual'
            ? 'Дата указана вручную'
            : 'Впервые замечен расширением. Это может быть не дата импорта.';
    }

    function displayDate(api, name) {
        const record = getRecord(api, name);
        const date = formatDate(timestamp(api, name));
        return record?.source === 'manual'
            ? date + ' · указана вручную'
            : date + ' · первое обнаружение';
    }

    function changeDate(api, name) {
        const old = timestamp(api, name);
        const proposed = old === null ? '' : formatDate(old);
        const input = prompt(
            'Дата для пресета "' + name + '" в формате ДД.ММ.ГГГГ.\n' +
            'Оставь поле пустым, чтобы сбросить дату на сегодняшнюю дату обнаружения.',
            proposed,
        );
        if (input === null) return;
        const text = input.trim();
        let iso;
        let source;
        if (!text) {
            iso = new Date().toISOString();
            source = 'first-seen';
        } else {
            const match = /^(\\d{2})\\.(\\d{2})\\.(\\d{4})$/.exec(text);
            if (!match) {
                alert('Некорректная дата. Введи её в формате ДД.ММ.ГГГГ');
                return;
            }
            const [, dayText, monthText, yearText] = match;
            const day = Number(dayText), month = Number(monthText), year = Number(yearText);
            const date = new Date(Date.UTC(year, month - 1, day, 12));
            if (year < 1900 || year > 9999 || date.getUTCFullYear() !== year ||
                date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
                alert('Укажи существующую календарную дату');
                return;
            }
            iso = date.toISOString();
            source = 'manual';
        }
        const store = getDateStore();
        (store.dates[api] ??= {})[name] = { at: iso, source };
        saveDateStore();
        updateButtons();
        renderList();
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
        watchNewPresets(select);
        button.addEventListener('click', () => openModal(select));
        select.addEventListener('change', updateButtons);
        // ST triggers some changes with jQuery, which do not always reach DOM listeners.
        if (typeof window.jQuery === 'function') {
            window.jQuery(select).on('change.presetDateManager', updateButtons);
        }
        const observer = new MutationObserver(() => {
            watchNewPresets(select);
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
        note.textContent = 'Для старых пресетов дата показывает первый запуск расширения, а не реальный импорт. Нажми ✎ рядом с датой, чтобы указать правильную.';
        const fragment = document.createDocumentFragment();
        for (const item of items) {
            const shell = el('div', 'pdm-item-wrap');
            const row = el('button', 'pdm-item');
            row.type = 'button';
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(item.value === select.value));
            row.disabled = item.disabled;
            if (item.value === select.value) row.classList.add('pdm-active');
            const text = el('span', 'pdm-item-content');
            text.append(el('span', 'pdm-item-name', item.name));
            const date = el('small', 'pdm-item-date', displayDate(api, item.name));
            date.title = dateNote(api, item.name);
            text.append(date);
            row.append(text, el('span', 'pdm-item-indicator', item.value === select.value ? '●' : '○'));
            row.addEventListener('click', () => {
                if (select.value !== item.value) {
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
            const edit = el('button', 'pdm-date-edit', '✎');
            edit.type = 'button';
            edit.title = 'Изменить дату';
            edit.setAttribute('aria-label', 'Изменить дату пресета ' + item.name);
            edit.addEventListener('click', () => changeDate(api, item.name));
            shell.append(row, edit);
            fragment.append(shell);
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
        console.info('[Preset Date Manager] Ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
