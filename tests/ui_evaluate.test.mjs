// tests/ui_evaluate.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

test('js/ui/evaluate.js: exportuje funkci mountEvaluate', async () => {
  const mod = await import('../js/ui/evaluate.js');
  assert.equal(typeof mod.mountEvaluate, 'function');
});

test('js/ui/evaluate.js: mountEvaluate s mock DOM funguje bez chyb', async () => {
  const mod = await import('../js/ui/evaluate.js');

  // Vytvoříme minimální mock DOM
  const elements = [];
  function createMockElement(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: '',
      id: '',
      style: {},
      children: [],
      innerHTML: '',
      textContent: '',
      setAttribute() {},
      getAttribute() { return null; },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
    };
    elements.push(el);
    return el;
  }

  // Uložíme a dočasně nastavíme globální document
  const origDoc = globalThis.document;
  globalThis.document = {
    createElement: createMockElement,
    body: createMockElement('body'),
    querySelectorAll: () => [],
    querySelector: () => null,
  };

  try {
    const mockSection = createMockElement('div');
    const project = {
      name: 'Testovací závod',
      teams: [
        { name: 'Červení', color: '#f00' },
        { name: 'Modří', color: '#00f' }
      ],
      results: {
        sheets: {},
        game: []
      }
    };

    let saved = null;
    mod.mountEvaluate(mockSection, {
      getProject: () => project,
      saveProject: (p) => { saved = p; return true; }
    });

    assert.ok(mockSection.children.length > 0);
  } finally {
    globalThis.document = origDoc;
  }
});
