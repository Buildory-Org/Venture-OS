// Where the QA scripts get Playwright and their output folder, on any computer.
// Playwright is looked for, in order: PLAYWRIGHT_DIR (a node_modules folder), ~/.vso-dev/qa/node_modules (a scratch install:
// `npm i playwright` there), then gstack's bundled copy. Nothing is downloaded here.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const candidates = [process.env.PLAYWRIGHT_DIR, join(homedir(), ".vso-dev/qa/node_modules"), join(homedir(), ".claude/skills/gstack/node_modules")].filter(Boolean);
const found = candidates.find((dir) => existsSync(join(dir, "playwright")));
if (!found) throw new Error(`Playwright not found. Looked in: ${candidates.join(", ")}. Run "npm i playwright" in ~/.vso-dev/qa, or set PLAYWRIGHT_DIR.`);
const real = createRequire(join(found, "/"))("playwright").chromium;

/**
 * Every page the QA scripts open starts with the app's one-time "Get notified about new messages" card already dismissed: it is a second
 * dialog on the page and floats over the buttons the scripts press. (The card itself is not what these scripts test.)
 */
function quietContexts(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(() => { try { window.localStorage.setItem("vso-alerts-prompt", "dismissed"); } catch { /* A page without storage shows the card. */ } });
    return context;
  };
  return browser;
}

/** Launches Playwright's Chromium; where its headless shell or the cached browser is missing, the full cached browser, then the installed Chrome or Edge. */
export const chromium = {
  async launch(options = {}) {
    let last;
    for (const channel of [undefined, "chromium", "chrome", "msedge"]) {
      try { return quietContexts(await real.launch(channel ? { ...options, channel } : options)); } catch (error) { last = error; }
    }
    throw last;
  },
};

/** The folder screenshots and reports go to: QA_OUT, else the system temp folder. */
export const qaOut = (name) => join(process.env.QA_OUT ?? join(tmpdir(), "vso-qa"), name);
