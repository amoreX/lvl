import assert from 'node:assert/strict';
import { chessSquareRef, parseBrowserScript, parseBrowserTool } from '../src/server/browserActionParser.js';

const fencedJson = parseBrowserTool(`
Here is the action:

\`\`\`json
{
  "tool": "browser",
  "arguments": {
    "mode": "run",
    "max_actions": 8,
    "script": "const tab = await browser.currentTab(); await tab.click(213); await tab.click(229);"
  }
}
\`\`\`
`);

assert.equal(fencedJson?.mode, 'run');
assert.equal(fencedJson?.mode === 'run' ? fencedJson.max_actions : 0, 8);
assert.match(fencedJson?.mode === 'run' ? fencedJson.script : '', /click\(213\)/);

const scriptOnly = parseBrowserTool(`
const tab = await browser.currentTab();
await tab.snapshot();
await tab.click("e2");
await tab.click("e4");
`);

assert.equal(scriptOnly?.mode, 'run');

const parsed = parseBrowserScript(`
const tab = await browser.currentTab();
await tab.snapshot();
await tab.click({ ref: 1 });
await tab.input({ index: 2, text: "hello" });
await tab.safeInput(3, "world");
await tab.keys("Enter");
await tab.clickAt(10, 20);
await tab.click("e2");
await tab.click("e4");
`);

assert.deepEqual(parsed.clicks, [1, chessSquareRef('e2'), chessSquareRef('e4')]);
assert.deepEqual(parsed.inputs, [{ ref: 3, text: 'world' }, { ref: 2, text: 'hello' }]);
assert.deepEqual(parsed.keys, ['Enter']);
assert.deepEqual(parsed.coordinateClicks, [{ x: 10, y: 20 }]);
assert.equal(parsed.snapshots, 1);

const state = parseBrowserTool('mode: state');
assert.equal(state?.mode, 'state');

console.log('Browser parser tests passed');
