/**
 * Page script: a11y tree snapshot
 * Extracted from browser-extension/src/tools/dom-reader.ts (readDOMFromTab)
 *
 * Generates an accessibility tree representation of the page,
 * assigning data-mcp-ref attributes to each element for later interaction.
 *
 * Usage:
 *   - Extension mode: callExtensionTool("read_page", opts)
 *   - CDP mode: Runtime.evaluate(buildSnapshotExpression(opts))
 */

export interface SnapshotOptions {
  depth?: number
  filter?: 'all' | 'interactive' | 'visible'
  refId?: string
  maxChars?: number
  viewportOnly?: boolean
  maxNodes?: number
  includeShadow?: boolean
}

/**
 * Build a JS expression string that generates an a11y tree snapshot.
 * The expression is self-contained and returns a JSON string.
 */
export function buildSnapshotExpression(opts: SnapshotOptions = {}): string {
  const options = {
    depth: opts.depth ?? 10,
    filter: opts.filter ?? 'all',
    refId: opts.refId,
    maxChars: opts.maxChars ?? 50000,
    viewportOnly: opts.viewportOnly ?? false,
    maxNodes: opts.maxNodes ?? 3000,
    includeShadow: opts.includeShadow ?? false,
  }

  return `(function(opts) {
    var depth = opts.depth;
    var filter = opts.filter;
    var refId = opts.refId;
    var maxChars = opts.maxChars;
    var viewportOnly = opts.viewportOnly;
    var maxNodes = opts.maxNodes;
    var includeShadow = opts.includeShadow;
    var scannedNodes = 0;
    var truncatedByNodes = false;

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

    function getAccessibilityInfo(element) {
      var tagName = element.tagName.toLowerCase();
      var role = element.getAttribute('role') || getImplicitRole(tagName);
      var label = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.getAttribute('alt')
        || element.placeholder
        || '';
      var text = (element.textContent || '').slice(0, 100).trim();

      var ref = 'ref_' + Math.random().toString(36).slice(2, 9);
      element.setAttribute('data-mcp-ref', ref);

      var info = { tag: tagName, ref: ref };

      if (role) info.role = role;
      if (label) info.label = label;
      if (text && text !== label) info.text = text;

      if (element instanceof HTMLInputElement) {
        info.type = element.type;
        if (element.value) info.value = element.value;
        if (element.name) info.name = element.name;
      }
      if (element instanceof HTMLAnchorElement && element.href) {
        info.href = element.href;
      }
      if (element instanceof HTMLButtonElement) {
        info.disabled = element.disabled;
      }
      if (element.id) info.id = element.id;
      if (element.className && typeof element.className === 'string') info.class = element.className;

      return info;
    }

    function isInteractive(element) {
      var tagName = element.tagName.toLowerCase();
      var interactiveTags = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'];
      if (interactiveTags.indexOf(tagName) !== -1) return true;
      var role = element.getAttribute('role') || '';
      if (/button|link|checkbox|radio|textbox|combobox|listbox|menu|menuitem|tab|switch/.test(role)) return true;
      if (element.getAttribute('tabindex')) return true;
      if (element.getAttribute('onclick') || element.getAttribute('onkeydown')) return true;
      return false;
    }

    function isVisible(element) {
      var style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      var rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    function isInViewport(element) {
      var rect = element.getBoundingClientRect();
      return rect.x < window.innerWidth && rect.y < window.innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0;
    }

    function getChildren(element) {
      var children = [];
      for (var i = 0; i < element.children.length; i++) children.push(element.children[i]);
      if (includeShadow && element.shadowRoot) {
        for (var j = 0; j < element.shadowRoot.children.length; j++) children.push(element.shadowRoot.children[j]);
      }
      if (includeShadow && element.tagName && element.tagName.toLowerCase() === 'slot' && typeof element.assignedElements === 'function') {
        var assigned = element.assignedElements({ flatten: true });
        for (var k = 0; k < assigned.length; k++) children.push(assigned[k]);
      }
      return children;
    }

    function traverse(element, currentDepth) {
      if (currentDepth > depth) return null;
      if (scannedNodes >= maxNodes) {
        truncatedByNodes = true;
        return null;
      }
      scannedNodes++;

      if (filter === 'visible' && !isVisible(element)) return null;
      if (viewportOnly && !isInViewport(element)) return null;
      if (filter === 'interactive' && !isInteractive(element) && currentDepth > 0) {
        var children = [];
        var interactiveChildren = getChildren(element);
        for (var i = 0; i < interactiveChildren.length; i++) {
          var childInfo = traverse(interactiveChildren[i], currentDepth);
          if (childInfo) children.push(childInfo);
        }
        if (children.length === 0) return null;
        return { children: children };
      }

      var info = getAccessibilityInfo(element);
      if (!info) return null;

      if (currentDepth < depth) {
        var ch = [];
        var childElements = getChildren(element);
        for (var j = 0; j < childElements.length; j++) {
          var ci = traverse(childElements[j], currentDepth + 1);
          if (ci) ch.push(ci);
        }
        if (ch.length > 0) info.children = ch;
      }

      return info;
    }

    var rootElement = document.body;
    if (refId) {
      rootElement = document.querySelector('[data-mcp-ref="' + refId + '"]');
      if (!rootElement) {
        return JSON.stringify({ error: 'Element with ref "' + refId + '" not found' });
      }
    }

    var result = traverse(rootElement, 0);
    if (result && typeof result === 'object') {
      result.scannedNodes = scannedNodes;
      if (truncatedByNodes) {
        result.truncated = true;
        result.message = 'Snapshot stopped at maxNodes=' + maxNodes + '. Use browser_locate for targeted element lookup.';
      }
    }
    var jsonString = JSON.stringify(result, null, 2);

    if (jsonString.length > maxChars) {
      return JSON.stringify({
        error: 'Output exceeds ' + maxChars + ' characters. Use browser_locate for targeted lookup, or specify a smaller depth/maxNodes/viewportOnly/ref_id.',
        truncated: true,
        actualLength: jsonString.length,
      });
    }

    return jsonString;
  })(${JSON.stringify(options)})`
}
