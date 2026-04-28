/**
 * Page script: resilient element locator for complex SPA pages.
 *
 * Unlike snapshot(), this scans with node/time budgets, crosses open Shadow DOM
 * and same-origin iframes, and stores target descriptors so later interactions
 * can recover after a ref attribute disappears.
 */

export interface LocateOptions {
  query: string
  scope?: 'auto' | 'page' | 'viewport' | 'interactive'
  visibleOnly?: boolean
  viewportOnly?: boolean
  maxResults?: number
  timeoutMs?: number
  maxNodes?: number
}

export interface LocateMatch {
  targetId: string
  tag: string
  role?: string
  label?: string
  text?: string
  rect: { x: number; y: number; width: number; height: number }
  center: { x: number; y: number }
  score: number
  selectorHint?: string
  shadowPath?: string[]
  framePath?: string[]
  visible: boolean
  inViewport: boolean
  interactive: boolean
}

export interface LocateResult {
  query: string
  matches: LocateMatch[]
  scannedNodes: number
  truncated: boolean
  elapsedMs: number
  inaccessibleFrames: number
  warnings: string[]
}

export interface ResolvedTarget {
  found: boolean
  targetId?: string
  x?: number
  y?: number
  width?: number
  height?: number
  centerX?: number
  centerY?: number
  tagName?: string
  visible?: boolean
  inViewport?: boolean
  selectorHint?: string
  message?: string
}

export interface TargetFormFillResult {
  success: boolean
  error?: string
  elementType?: string
  inputType?: string
}

const LOCATOR_RUNTIME = String.raw`
function __nine1EnsureLocatorRuntime() {
  var w = window;
  var state = w.__nine1Locator;
  if (!state) {
    state = {
      next: 1,
      targets: {},
      elements: {},
      weak: typeof WeakMap !== 'undefined' ? new WeakMap() : null
    };
    w.__nine1Locator = state;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function(ch) { return '\\' + ch; });
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getWindowFor(element) {
    return element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView : window;
  }

  function getImplicitRole(tagName) {
    var roleMap = {
      a: 'link', button: 'button', input: 'textbox', select: 'combobox',
      textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading',
      h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      nav: 'navigation', main: 'main', aside: 'complementary',
      footer: 'contentinfo', header: 'banner', form: 'form',
      table: 'table', ul: 'list', ol: 'list', li: 'listitem',
    };
    return roleMap[tagName] || '';
  }

  function getRole(element) {
    var tagName = element.tagName ? element.tagName.toLowerCase() : '';
    var role = element.getAttribute('role') || getImplicitRole(tagName);
    if (tagName === 'input') {
      var type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'search') role = 'searchbox';
      if (type === 'checkbox') role = 'checkbox';
      if (type === 'radio') role = 'radio';
      if (type === 'button' || type === 'submit') role = 'button';
    }
    return role || '';
  }

  function getLabel(element) {
    var label = element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('alt')
      || element.getAttribute('placeholder')
      || '';
    if (!label && element.id) {
      try {
        var doc = element.ownerDocument || document;
        var labelEl = doc.querySelector('label[for="' + cssEscape(element.id) + '"]');
        if (labelEl) label = labelEl.textContent || '';
      } catch {}
    }
    return String(label || '').replace(/\s+/g, ' ').trim();
  }

  function getText(element) {
    var text = '';
    for (var i = 0; i < element.childNodes.length; i++) {
      var child = element.childNodes[i];
      if (child.nodeType === 3) text += child.textContent || '';
    }
    text = text.trim();
    if (!text && (element.children.length <= 8 || isInteractive(element))) {
      text = (element.textContent || '').trim();
    }
    return text.replace(/\s+/g, ' ').slice(0, 240);
  }

  function getRect(element, offsetX, offsetY) {
    var rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x + offsetX),
      y: Math.round(rect.y + offsetY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function isVisible(element, rect) {
    var view = getWindowFor(element);
    var style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    return true;
  }

  function isInViewport(rect) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.x < vw && rect.y < vh && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  }

  function isInteractive(element) {
    var tagName = element.tagName ? element.tagName.toLowerCase() : '';
    if (/^(a|button|input|select|textarea|details|summary)$/.test(tagName)) return true;
    var role = getRole(element);
    if (/button|link|checkbox|radio|textbox|searchbox|combobox|listbox|menu|menuitem|tab|switch|option/.test(role)) return true;
    if (element.hasAttribute('contenteditable')) return true;
    var tabIndex = element.getAttribute('tabindex');
    if (tabIndex !== null && tabIndex !== '-1') return true;
    var style = getWindowFor(element).getComputedStyle(element);
    return style.cursor === 'pointer';
  }

  function selectorFor(element) {
    if (!element || !element.tagName) return '';
    var doc = element.ownerDocument || document;
    var tag = element.tagName.toLowerCase();
    if (element.id) {
      var byId = tag + '#' + cssEscape(element.id);
      try {
        if (doc.querySelectorAll(byId).length === 1) return byId;
      } catch {}
    }
    var stableAttrs = ['data-testid', 'data-test-id', 'data-qa', 'aria-label', 'name', 'role', 'title', 'placeholder'];
    for (var i = 0; i < stableAttrs.length; i++) {
      var attr = stableAttrs[i];
      var value = element.getAttribute(attr);
      if (!value || value.length > 80) continue;
      var selector = tag + '[' + attr + '="' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
      try {
        if (doc.querySelectorAll(selector).length === 1) return selector;
      } catch {}
    }
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1 && parts.length < 5) {
      var currentTag = current.tagName.toLowerCase();
      var part = currentTag;
      if (current.id) {
        part += '#' + cssEscape(current.id);
        parts.unshift(part);
        break;
      }
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function(child) {
          return child.tagName && child.tagName.toLowerCase() === currentTag;
        });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }

  function elementSignature(element, info) {
    return {
      tag: info.tag,
      role: info.role || '',
      label: normalize(info.label || ''),
      text: normalize(info.text || '').slice(0, 160),
      id: element.id || '',
      className: typeof element.className === 'string' ? element.className.slice(0, 160) : ''
    };
  }

  function descriptorMatches(element, descriptor) {
    if (!descriptor || !descriptor.signature) return false;
    var tag = element.tagName ? element.tagName.toLowerCase() : '';
    var role = getRole(element);
    var label = normalize(getLabel(element));
    var text = normalize(getText(element)).slice(0, 160);
    var sig = descriptor.signature;
    if (sig.tag && sig.tag !== tag) return false;
    if (sig.role && sig.role !== role) return false;
    if (sig.label && label.indexOf(sig.label) !== -1) return true;
    if (sig.text && text.indexOf(sig.text) !== -1) return true;
    if (sig.id && element.id === sig.id) return true;
    return false;
  }

  function childEntries(entry) {
    var element = entry.element;
    var children = [];
    for (var i = element.children.length - 1; i >= 0; i--) {
      children.push({
        element: element.children[i],
        offsetX: entry.offsetX,
        offsetY: entry.offsetY,
        shadowPath: entry.shadowPath,
        framePath: entry.framePath
      });
    }
    if (element.shadowRoot) {
      var hostSelector = selectorFor(element) || (element.tagName ? element.tagName.toLowerCase() : 'host');
      for (var s = element.shadowRoot.children.length - 1; s >= 0; s--) {
        children.push({
          element: element.shadowRoot.children[s],
          offsetX: entry.offsetX,
          offsetY: entry.offsetY,
          shadowPath: entry.shadowPath.concat(hostSelector),
          framePath: entry.framePath
        });
      }
    }
    if (element.tagName && element.tagName.toLowerCase() === 'slot') {
      var assigned = typeof element.assignedElements === 'function' ? element.assignedElements({ flatten: true }) : [];
      for (var a = assigned.length - 1; a >= 0; a--) {
        children.push({
          element: assigned[a],
          offsetX: entry.offsetX,
          offsetY: entry.offsetY,
          shadowPath: entry.shadowPath,
          framePath: entry.framePath
        });
      }
    }
    return children;
  }

  function rootEntriesFromDocument(doc, offsetX, offsetY, framePath) {
    var body = doc && doc.body;
    return body ? [{ element: body, offsetX: offsetX || 0, offsetY: offsetY || 0, shadowPath: [], framePath: framePath || [] }] : [];
  }

  function scanElements(options, visitor) {
    var start = Date.now();
    var maxNodes = Math.max(1, options.maxNodes || 6000);
    var timeoutMs = Math.max(25, options.timeoutMs || 350);
    var stack = rootEntriesFromDocument(document, 0, 0, []);
    var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var scanned = 0;
    var truncated = false;
    var inaccessibleFrames = 0;

    while (stack.length > 0) {
      if (scanned >= maxNodes || Date.now() - start > timeoutMs) {
        truncated = true;
        break;
      }
      var entry = stack.pop();
      var element = entry && entry.element;
      if (!element || !element.tagName) continue;
      if (seen) {
        if (seen.has(element)) continue;
        seen.add(element);
      }
      scanned++;
      visitor(element, entry);

      if (element.tagName.toLowerCase() === 'iframe') {
        try {
          var frameDoc = element.contentDocument;
          if (frameDoc && frameDoc.body) {
            var frameRect = element.getBoundingClientRect();
            var frameSelector = selectorFor(element) || 'iframe';
            stack = stack.concat(rootEntriesFromDocument(
              frameDoc,
              entry.offsetX + frameRect.x,
              entry.offsetY + frameRect.y,
              entry.framePath.concat(frameSelector)
            ));
          }
        } catch {
          inaccessibleFrames++;
        }
      }

      var children = childEntries(entry);
      for (var i = 0; i < children.length; i++) stack.push(children[i]);
    }

    return {
      scanned: scanned,
      truncated: truncated,
      inaccessibleFrames: inaccessibleFrames,
      elapsed: Date.now() - start
    };
  }

  function describe(element, entry) {
    var tag = element.tagName.toLowerCase();
    var role = getRole(element);
    var label = getLabel(element);
    var text = getText(element);
    var rect = getRect(element, entry.offsetX, entry.offsetY);
    var visible = isVisible(element, rect);
    var inViewport = isInViewport(rect);
    var interactive = isInteractive(element);
    return {
      tag: tag,
      role: role,
      label: label,
      text: text,
      rect: rect,
      center: {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2)
      },
      selectorHint: selectorFor(element),
      shadowPath: entry.shadowPath,
      framePath: entry.framePath,
      visible: visible,
      inViewport: inViewport,
      interactive: interactive
    };
  }

  function remember(element, info) {
    var targetId = state.weak && state.weak.get(element);
    if (!targetId) targetId = element.getAttribute('data-nine1-target-id') || '';
    if (!targetId) {
      targetId = 'target_' + (state.next++).toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      try { element.setAttribute('data-nine1-target-id', targetId); } catch {}
      if (state.weak) state.weak.set(element, targetId);
    }
    var descriptor = {
      targetId: targetId,
      selectorHint: info.selectorHint || '',
      signature: elementSignature(element, info),
      rect: info.rect,
      center: info.center,
      shadowPath: info.shadowPath || [],
      framePath: info.framePath || []
    };
    state.targets[targetId] = descriptor;
    state.elements[targetId] = element;
    return targetId;
  }

  function resolveElement(targetId) {
    if (!targetId) return null;
    var direct = state.elements && state.elements[targetId];
    if (direct && direct.isConnected) return direct;
    try {
      var byTarget = document.querySelector('[data-nine1-target-id="' + targetId + '"]');
      if (byTarget) return byTarget;
      var byRef = document.querySelector('[data-mcp-ref="' + targetId + '"]');
      if (byRef) return byRef;
    } catch {}
    var descriptor = state.targets && state.targets[targetId];
    if (descriptor && descriptor.selectorHint) {
      try {
        var selected = document.querySelector(descriptor.selectorHint);
        if (selected && descriptorMatches(selected, descriptor)) return selected;
      } catch {}
    }
    if (descriptor) {
      var found = null;
      scanElements({ maxNodes: 4000, timeoutMs: 250 }, function(element) {
        if (!found && descriptorMatches(element, descriptor)) found = element;
      });
      if (found) {
        state.elements[targetId] = found;
        try { found.setAttribute('data-nine1-target-id', targetId); } catch {}
      }
      return found;
    }
    return null;
  }

  state.resolveElement = resolveElement;
  state.describeElement = function(element) {
    return describe(element, { element: element, offsetX: 0, offsetY: 0, shadowPath: [], framePath: [] });
  };
  state.scanElements = scanElements;
  state.remember = remember;
  state.normalize = normalize;
  return state;
}
`

export function buildLocateExpression(options: LocateOptions): string {
  const opts = {
    query: options.query,
    scope: options.scope ?? 'auto',
    visibleOnly: options.visibleOnly ?? true,
    viewportOnly: options.viewportOnly ?? false,
    maxResults: options.maxResults ?? 20,
    timeoutMs: options.timeoutMs ?? 350,
    maxNodes: options.maxNodes ?? 6000,
  }

  return `(function(opts) {
    ${LOCATOR_RUNTIME}
    var state = __nine1EnsureLocatorRuntime();
    var query = state.normalize(opts.query || '');
    var words = query.split(/\\s+/).filter(function(word) { return word.length > 0; });
    var semanticSearch = /search|find|query|lookup|搜索|查找|检索/.test(query);
    var semanticClose = /close|dismiss|cancel|关闭|取消/.test(query);
    var semanticDocs = /docs?|document|文档/.test(query);
    var matches = [];
    var warnings = [];

    function scoreElement(element, info) {
      var label = state.normalize(info.label || '');
      var text = state.normalize(info.text || '');
      var role = state.normalize(info.role || '');
      var tag = state.normalize(info.tag || '');
      var id = state.normalize(element.id || '');
      var className = state.normalize(typeof element.className === 'string' ? element.className : '');
      var placeholder = state.normalize(element.getAttribute('placeholder') || '');
      var haystack = [label, text, role, tag, id, className, placeholder].join(' ');
      var score = 0;

      if (!query) {
        score = info.interactive ? 10 : 1;
      } else {
        if (label === query || placeholder === query) score += 120;
        if (text === query) score += 100;
        if (label.indexOf(query) !== -1 || placeholder.indexOf(query) !== -1) score += 80;
        if (text.indexOf(query) !== -1) score += 55;
        if (role === query || tag === query) score += 35;
        if (id.indexOf(query) !== -1 || className.indexOf(query) !== -1) score += 18;
        for (var i = 0; i < words.length; i++) {
          var word = words[i];
          if (!word) continue;
          if (label.indexOf(word) !== -1 || placeholder.indexOf(word) !== -1) score += 18;
          if (text.indexOf(word) !== -1) score += 10;
          if (role.indexOf(word) !== -1 || tag.indexOf(word) !== -1) score += 8;
          if (id.indexOf(word) !== -1 || className.indexOf(word) !== -1) score += 5;
        }
        if (score === 0 && words.length > 1 && words.every(function(word) { return haystack.indexOf(word) !== -1; })) {
          score += 18;
        }
      }

      if (semanticSearch) {
        if (/input|textarea/.test(tag) || element.hasAttribute('contenteditable')) score += 30;
        if (/searchbox|textbox|combobox/.test(role)) score += 26;
        if (/search|query|搜索|检索/.test(label + ' ' + placeholder + ' ' + id + ' ' + className)) score += 35;
      }
      if (semanticClose) {
        if (info.interactive) score += 18;
        if (/close|dismiss|cancel|关闭|取消|×|x/.test(label + ' ' + text + ' ' + id + ' ' + className)) score += 35;
      }
      if (semanticDocs && /docs?|document|wiki|文档/.test(label + ' ' + text + ' ' + id + ' ' + className)) score += 20;

      if (info.interactive) score += 12;
      if (info.inViewport) score += 10;
      if (info.visible) score += 6;
      if (!info.interactive && text.length > 500) score -= 24;
      if (!info.interactive && info.rect.width > window.innerWidth * 0.85 && info.rect.height > window.innerHeight * 0.5) score -= 18;
      return score;
    }

    var scan = state.scanElements(opts, function(element, entry) {
      var info = state.describeElement ? state.describeElement(element) : null;
      info = info || {};
      info = (function() {
        var original = info;
        var rect = element.getBoundingClientRect();
        return {
          tag: original.tag || element.tagName.toLowerCase(),
          role: original.role || '',
          label: original.label || '',
          text: original.text || '',
          rect: {
            x: Math.round(rect.x + entry.offsetX),
            y: Math.round(rect.y + entry.offsetY),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          center: {
            x: Math.round(rect.x + entry.offsetX + rect.width / 2),
            y: Math.round(rect.y + entry.offsetY + rect.height / 2)
          },
          selectorHint: original.selectorHint || '',
          shadowPath: entry.shadowPath || [],
          framePath: entry.framePath || [],
          visible: original.visible,
          inViewport: original.inViewport,
          interactive: original.interactive
        };
      })();

      // Re-describe with the traversal offsets; state.describeElement intentionally
      // describes top-document elements only, so iframe children need corrected rects.
      var localInfo = (function() {
        var role = element.getAttribute('role') || info.role || '';
        var label = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('placeholder') || info.label || '';
        var text = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        return {
          tag: element.tagName.toLowerCase(),
          role: role,
          label: String(label).replace(/\\s+/g, ' ').trim(),
          text: text,
          rect: info.rect,
          center: info.center,
          selectorHint: info.selectorHint,
          shadowPath: info.shadowPath,
          framePath: info.framePath,
          visible: info.visible,
          inViewport: info.inViewport,
          interactive: info.interactive
        };
      })();

      if (opts.visibleOnly && !localInfo.visible) return;
      if ((opts.viewportOnly || opts.scope === 'viewport') && !localInfo.inViewport) return;
      if (opts.scope === 'interactive' && !localInfo.interactive) return;

      var score = scoreElement(element, localInfo);
      if (score <= 0) return;

      var targetId = state.remember(element, localInfo);
      matches.push({
        targetId: targetId,
        tag: localInfo.tag,
        role: localInfo.role || undefined,
        label: localInfo.label || undefined,
        text: localInfo.text || undefined,
        rect: localInfo.rect,
        center: localInfo.center,
        score: Math.round(score),
        selectorHint: localInfo.selectorHint || undefined,
        shadowPath: localInfo.shadowPath && localInfo.shadowPath.length ? localInfo.shadowPath : undefined,
        framePath: localInfo.framePath && localInfo.framePath.length ? localInfo.framePath : undefined,
        visible: localInfo.visible,
        inViewport: localInfo.inViewport,
        interactive: localInfo.interactive
      });
    });

    matches.sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      if (a.interactive !== b.interactive) return a.interactive ? -1 : 1;
      return (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x);
    });
    matches = matches.slice(0, Math.max(1, opts.maxResults || 20));
    if (scan.truncated) warnings.push('Locator stopped early due to time/node budget.');
    if (scan.inaccessibleFrames > 0) warnings.push(scan.inaccessibleFrames + ' cross-origin frame(s) could not be scanned.');

    return JSON.stringify({
      query: opts.query || '',
      matches: matches,
      scannedNodes: scan.scanned,
      truncated: scan.truncated,
      elapsedMs: scan.elapsed,
      inaccessibleFrames: scan.inaccessibleFrames,
      warnings: warnings
    });
  })(${JSON.stringify(opts)})`
}

export function buildResolveTargetExpression(targetId: string, options: { scrollIntoView?: boolean } = {}): string {
  return `(function(targetId, opts) {
    ${LOCATOR_RUNTIME}
    var state = __nine1EnsureLocatorRuntime();
    var element = state.resolveElement ? state.resolveElement(targetId) : null;
    if (!element) {
      return JSON.stringify({ found: false, targetId: targetId, message: 'Target "' + targetId + '" not found' });
    }
    if (opts && opts.scrollIntoView && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    }
    var info = state.describeElement(element);
    var result = {
      found: true,
      targetId: targetId,
      x: info.rect.x,
      y: info.rect.y,
      width: info.rect.width,
      height: info.rect.height,
      centerX: info.center.x,
      centerY: info.center.y,
      tagName: info.tag,
      visible: info.visible,
      inViewport: info.inViewport,
      selectorHint: info.selectorHint
    };
    return JSON.stringify(result);
  })(${JSON.stringify(targetId)}, ${JSON.stringify(options)})`
}

export function buildTargetFormFillExpression(targetId: string, value: unknown): string {
  return `(function(targetId, inputValue) {
    ${LOCATOR_RUNTIME}
    var state = __nine1EnsureLocatorRuntime();
    var element = state.resolveElement ? state.resolveElement(targetId) : null;
    if (!element) {
      return JSON.stringify({ success: false, error: 'Target "' + targetId + '" not found' });
    }
    try {
      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      }
      if (element instanceof HTMLInputElement) {
        var inputType = element.type.toLowerCase();
        if (inputType === 'checkbox' || inputType === 'radio') {
          element.checked = Boolean(inputValue);
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (inputType === 'file') {
          return JSON.stringify({ success: false, error: 'Cannot set file input value programmatically. Use browser_upload instead.' });
        } else {
          element.focus();
          element.value = String(inputValue);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (element instanceof HTMLTextAreaElement) {
        element.focus();
        element.value = String(inputValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element instanceof HTMLSelectElement) {
        if (Array.isArray(inputValue)) {
          for (var i = 0; i < element.options.length; i++) {
            element.options[i].selected = inputValue.indexOf(element.options[i].value) !== -1;
          }
        } else {
          element.value = String(inputValue);
        }
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.getAttribute('contenteditable') === 'true' || element.hasAttribute('contenteditable')) {
        element.focus();
        element.textContent = String(inputValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        element.focus();
        element.value = String(inputValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return JSON.stringify({
        success: true,
        elementType: element.tagName.toLowerCase(),
        inputType: element.type || undefined
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: String(error) });
    }
  })(${JSON.stringify(targetId)}, ${JSON.stringify(value)})`
}
