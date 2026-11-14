import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { validateSsrfUrl } from './security';
import { InteractiveElement, ObjectiveEvidence, RunCredentials } from './types';

export interface BrowserManagerOptions {
  viewport?: { width: number; height: number };
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleErrors: string[] = [];
  private pageErrors: string[] = [];
  private failedRequests: string[] = [];
  private httpErrors: string[] = [];

  /**
   * Initializes Chromium with required sandbox flags and isolated context.
   */
  public async init(options?: BrowserManagerOptions): Promise<Page> {
    const viewport = options?.viewport || { width: 1280, height: 720 };

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    this.context = await this.browser.newContext({
      viewport,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 TestPilot-QA-Agent/1.0',
      ignoreHTTPSErrors: false,
    });

       // Fix for tsx: define the __name helper inside the browser pages
    await this.context.addInitScript('window.__name = window.__name || function (fn) { return fn; };');
    this.page = await this.context.newPage();

    // 1. SSRF Protection via Playwright Route Interception
    // Every outbound request (including redirects, XHR, fetch, iframes, stylesheets, assets)
    // is checked against the SSRF validator.
    await this.page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();

      // Allow data: and blob: URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return route.continue();
      }

      const ssrfCheck = await validateSsrfUrl(url);
      if (!ssrfCheck.valid) {
        return route.abort('blockedbyclient');
      }

      return route.continue();
    });

    // 2. Evidence Collectors
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text().slice(0, 500);
        if (text && !this.consoleErrors.includes(text)) {
          this.consoleErrors.push(text);
          if (this.consoleErrors.length > 50) this.consoleErrors.shift();
        }
      }
    });

    this.page.on('pageerror', (err) => {
      const message = (err.stack || err.message || String(err)).slice(0, 500);
      if (message && !this.pageErrors.includes(message)) {
        this.pageErrors.push(message);
        if (this.pageErrors.length > 30) this.pageErrors.shift();
      }
    });

    this.page.on('response', (res) => {
      const status = res.status();
      if (status >= 400) {
        const url = res.url().slice(0, 200);
        const method = res.request().method();
        const entry = `${method} ${url} -> ${status}`;
        if (!this.httpErrors.includes(entry)) {
          this.httpErrors.push(entry);
          if (this.httpErrors.length > 50) this.httpErrors.shift();
        }
      }
    });

    this.page.on('requestfailed', (req) => {
      const failure = req.failure();
      if (failure?.errorText && !failure.errorText.includes('BLOCKED_BY_CLIENT')) {
        const url = req.url().slice(0, 200);
        const entry = `${req.method()} ${url} (${failure.errorText})`;
        if (!this.failedRequests.includes(entry)) {
          this.failedRequests.push(entry);
          if (this.failedRequests.length > 50) this.failedRequests.shift();
        }
      }
    });

    return this.page;
  }

  public getPage(): Page {
    if (!this.page) throw new Error('Browser page not initialized');
    return this.page;
  }

  /**
   * Resizes viewport (e.g. for responsive testing in full_qa mode)
   */
  public async setViewportSize(width: number, height: number): Promise<void> {
    if (this.page) {
      await this.page.setViewportSize({ width, height });
    }
  }

  /**
   * Navigates to a URL safely with SSRF verification
   */
  public async navigate(url: string): Promise<void> {
    const check = await validateSsrfUrl(url);
    if (!check.valid) {
      throw new Error(`Navigation blocked by SSRF protection: ${check.reason}`);
    }

    const page = this.getPage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Settle delay
    await page.waitForTimeout(1000);
  }

  /**
   * Takes a JPEG screenshot of the current page viewport (quality 70).
   */
  public async takeScreenshot(): Promise<Buffer> {
    const page = this.getPage();
    return await page.screenshot({
      type: 'jpeg',
      quality: 70,
      fullPage: false,
    });
  }

  /**
   * Scans the DOM for visible, interactive elements and produces a numbered list.
   */
  public async extractInteractiveElements(): Promise<InteractiveElement[]> {
    const page = this.getPage();

    const elements = await page.evaluate(() => {
      const isVisible = (elem: HTMLElement): boolean => {
        if (!elem) return false;
        const style = window.getComputedStyle(elem);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          parseFloat(style.opacity) < 0.1
        ) {
          return false;
        }
        const rect = elem.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.right > 0;
      };

      const selectors = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'textarea',
        'select',
        '[role="button"]',
        '[role="link"]',
        '[role="checkbox"]',
        '[role="menuitem"]',
        '[role="tab"]',
        '[onclick]',
        '[tabindex="0"]',
      ];

      const allMatches = document.querySelectorAll<HTMLElement>(selectors.join(', '));
      const results: Array<{
        tagName: string;
        role: string;
        accessibleName: string;
        type?: string;
        textSnippet?: string;
        selector: string;
        isDangerous?: boolean;
      }> = [];

      let index = 0;
      for (const el of Array.from(allMatches)) {
        if (!isVisible(el)) continue;

        const tagName = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type || undefined;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const name = (el as HTMLInputElement).name || undefined;
        const placeholder = (el as HTMLInputElement).placeholder || undefined;
        const role = el.getAttribute('role') || tagName;
        const ariaLabel = el.getAttribute('aria-label') || '';
        const accessibleName = ariaLabel || text || placeholder || name || '';

        // Detect destructive / dangerous actions
        const lowerDesc = `${text} ${name || ''} ${placeholder || ''} ${ariaLabel}`.toLowerCase();
        const isDangerous =
          /\b(delete|remove|destroy|terminate|cancel subscription|wipe|purge|pay now|checkout|buy now|place order)\b/i.test(
            lowerDesc
          );

        // Build a unique CSS selector path
        let selector = '';
        if (el.id) {
          selector = `#${CSS.escape(el.id)}`;
        } else if (name && (tagName === 'input' || tagName === 'select' || tagName === 'textarea')) {
          selector = `${tagName}[name="${CSS.escape(name)}"]`;
        } else {
          let current: HTMLElement | null = el;
          const path: string[] = [];
          while (current && current !== document.body && current.parentElement) {
            const currentTag = current.tagName.toLowerCase();
            const parentEl: HTMLElement = current.parentElement;
            const siblings = Array.from(parentEl.children).filter(
              (c) => (c as HTMLElement).tagName?.toLowerCase() === currentTag
            );
            if (siblings.length > 1) {
              const idx = siblings.indexOf(current) + 1;
              path.unshift(`${currentTag}:nth-of-type(${idx})`);
            } else {
              path.unshift(currentTag);
            }
            if (path.length >= 3) break;
            current = parentEl;
          }
          selector = path.join(' > ');
        }

        results.push({
          tagName,
          role,
          accessibleName: accessibleName.slice(0, 100),
          type,
          textSnippet: text.slice(0, 60),
          selector,
          isDangerous,
        });

        index++;
        if (index >= 60) break;
      }

      return results;
    });

    return elements.map((el, i) => ({
      index: i + 1,
      tagName: el.tagName,
      role: el.role,
      accessibleName: el.accessibleName,
      type: el.type,
      textSnippet: el.textSnippet,
      selector: el.selector,
      isDangerous: el.isDangerous,
    }));
  }

  /**
   * Checks for broken images on current page
   */
  public async checkBrokenImages(): Promise<string[]> {
    const page = this.getPage();
    return await page.evaluate(() => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
      const broken: string[] = [];
      for (const img of images) {
        if (!img.complete || img.naturalWidth === 0) {
          const src = img.src || img.getAttribute('src') || 'unknown';
          broken.push(src.slice(0, 150));
        }
      }
      return broken.slice(0, 10);
    });
  }

  /**
   * Retrieves summary of runtime errors and network issues collected so far.
   */
  public async getEvidenceSummary(): Promise<ObjectiveEvidence> {
    const brokenImages = await this.checkBrokenImages();
    return {
      consoleErrors: [...this.consoleErrors],
      pageErrors: [...this.pageErrors],
      failedRequests: [...this.failedRequests],
      httpErrors: [...this.httpErrors],
      brokenImages,
    };
  }

  /**
   * Executes a safe UI action determined by the QA agent
   */
  public async executeAction(
    action: {
      type: string;
      elementIndex?: number;
      text?: string;
      field?: 'email' | 'password';
      url?: string;
      key?: string;
    },
    credentials?: RunCredentials | null,
    elementsList?: InteractiveElement[]
  ): Promise<{ success: boolean; description: string; error?: string }> {
    const page = this.getPage();

    // Resolve target element selector from index
    let targetSelector: string | undefined;
    if (action.elementIndex && elementsList) {
      const match = elementsList.find((e) => e.index === action.elementIndex);
      if (match) targetSelector = match.selector;
    }

    try {
      switch (action.type) {
        case 'click': {
          if (!targetSelector) throw new Error('Target element not found for click');
          const locator = page.locator(targetSelector).first();
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await locator.click({ timeout: 8000 });
          await page.waitForTimeout(800);
          return { success: true, description: `Clicked #${action.elementIndex || 0} (${targetSelector})` };
        }

        case 'type': {
          if (!targetSelector) throw new Error('Target element not found for typing');
          const textToType = action.text || '';
          const locator = page.locator(targetSelector).first();
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await locator.fill('');
          await locator.type(textToType, { delay: 40 });
          await page.waitForTimeout(500);
          return { success: true, description: `Typed "${textToType}" into ${targetSelector}` };
        }

        case 'type_credential': {
          if (!targetSelector) throw new Error('Target element not found for credential injection');
          if (!credentials) throw new Error('No test credentials configured');

          const isPassword = action.field === 'password';
          const secretValue = isPassword ? credentials.password || '' : credentials.email || '';
          const locator = page.locator(targetSelector).first();
          await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await locator.fill('');
          await locator.type(secretValue, { delay: 35 });
          await page.waitForTimeout(500);

          return {
            success: true,
            description: isPassword ? 'Entered test password' : 'Entered test email',
          };
        }

        case 'select': {
          if (!targetSelector) throw new Error('Target element not found for select');
          const value = action.text || '';
          await page.selectOption(targetSelector, value, { timeout: 5000 });
          await page.waitForTimeout(500);
          return { success: true, description: `Selected "${value}" in ${targetSelector}` };
        }

        case 'scroll': {
          await page.mouse.wheel(0, 500);
          await page.waitForTimeout(800);
          return { success: true, description: 'Scrolled down page' };
        }

        case 'press': {
          const key = action.key || 'Enter';
          await page.keyboard.press(key);
          await page.waitForTimeout(600);
          return { success: true, description: `Pressed ${key}` };
        }

        case 'navigate': {
          if (!action.url) throw new Error('Missing URL for navigate action');
          await this.navigate(action.url);
          return { success: true, description: `Navigated to ${action.url}` };
        }

        case 'wait': {
          await page.waitForTimeout(2000);
          return { success: true, description: 'Waited 2s for page update' };
        }

        case 'finish': {
          return { success: true, description: 'Testing complete' };
        }

        default:
          return { success: false, description: `Unknown action: ${action.type}`, error: 'Unsupported action' };
      }
    } catch (err: unknown) {
      return {
        success: false,
        description: `Failed to execute ${action.type}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Safely closes the browser context and instance.
   */
  public async close(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } catch {
      // Ignore closing errors
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }
}
