import { BrowserManager } from './browser';
import { decideNextAction, generateFinalBugReport } from './gemini';
import { uploadScreenshot, updateRunStepRow, finalizeRunRow } from './supabase';
import { calculateScore } from './scoring';
import { releaseRunLock } from './security';
import { config, redactSecrets } from './config';
import { ChatLog } from './chat';
import {
  ActionDecision,
  Bug,
  BugSeverity,
  RunCredentials,
  RunStatus,
  Step,
  TestMode,
} from './types';

// Map of stopped run IDs to gracefully terminate background execution
const stopRequestedSet = new Set<string>();

export function requestRunStop(runId: string): boolean {
  stopRequestedSet.add(runId);
  return true;
}

export function isRunStopRequested(runId: string): boolean {
  return stopRequestedSet.has(runId);
}

export interface AgentRunParams {
  runId: string;
  url: string;
  command: string;
  mode: TestMode;
  credentials?: RunCredentials | null;
  geminiKey: string;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class QaAgent {
  private runId: string;
  private url: string;
  private command: string;
  private mode: TestMode;
  private credentials?: RunCredentials | null;
  private geminiKey: string;
  private browserManager: BrowserManager;
  private maxSteps: number;
  private chat: ChatLog;
  private steps: Step[] = [];
  private seenFindings = new Set<string>();
  private rawIssues: Array<{
    title: string;
    severity: BugSeverity;
    evidence: string;
    pageUrl: string;
    screenshotUrl: string;
    stepIndex: number;
  }> = [];

  constructor(params: AgentRunParams) {
    this.runId = params.runId;
    this.url = params.url;
    this.command = params.command;
    this.mode = params.mode;
    this.credentials = params.credentials;
    this.geminiKey = params.geminiKey;
    this.browserManager = new BrowserManager();
    this.maxSteps = config.stepLimits[this.mode] || 15;
    this.chat = new ChatLog(this.runId, this.maxSteps + 3);
  }

  private safeText(value: unknown): string {
    return redactSecrets(String(value), [this.geminiKey]);
  }

  /**
   * Executes the autonomous QA test loop.
   */
  public async execute(): Promise<void> {
    const startTime = Date.now();
    let currentStatus: RunStatus = 'running';
    let runError: { code: string; message: string } | null = null;
    let finalBugs: Bug[] = [];

    try {
      this.chat.addMessage({
        type: 'system',
        text: `Test started. Model: ${config.geminiModel}. Mode: ${this.mode}, up to ${this.maxSteps} steps.`,
      });

      // 1. Launch browser and isolated page
      this.chat.setStatus('Starting the browser...');
      await this.browserManager.init({ viewport: { width: 1280, height: 720 } });

      // 2. Initial navigation to target site
      this.chat.setStatus('Opening the site...');
      const navStart = Date.now();
      let initialStepScreenshotUrl: string | null = null;
      try {
        await this.browserManager.navigate(this.url);
        this.chat.setStatus('Taking a screenshot...');
        const screenshotBuf = await this.browserManager.takeScreenshot();
        initialStepScreenshotUrl = await uploadScreenshot(this.runId, 1, screenshotBuf);

        this.steps.push({
          index: 1,
          action: `Opened ${this.url}`,
          status: 'passed',
          durationMs: Date.now() - navStart,
          screenshot: initialStepScreenshotUrl,
        });
        this.chat.addMessage({
          type: 'system',
          text: `Opened ${hostLabel(this.url)}`,
          stepIndex: 1,
          screenshot: initialStepScreenshotUrl,
          state: 'done',
        });
      } catch (navErr: unknown) {
        this.steps.push({
          index: 1,
          action: `Failed to open ${this.url}`,
          status: 'failed',
          durationMs: Date.now() - navStart,
          screenshot: null,
        });
        throw new Error(`Initial page navigation failed: ${navErr instanceof Error ? navErr.message : String(navErr)}`);
      }

      // Sync initial step to DB
      await updateRunStepRow(this.runId, this.steps, currentStatus);

      // 3. Autonomous agent exploration loop
      let stepCounter = 1;
      let isMobileTested = false;

      while (stepCounter < this.maxSteps) {
        // Check timeout
        if (Date.now() - startTime > config.hardTimeLimitMs) {
          console.warn(`[Agent] Run ${this.runId} hit execution limit.`);
          this.chat.addMessage({ type: 'system', text: 'Time limit reached. Wrapping up with what I found.' });
          break;
        }

        // Check if user requested stop
        if (isRunStopRequested(this.runId)) {
          currentStatus = 'stopped';
          console.log(`[Agent] Run ${this.runId} stopped by user request.`);
          break;
        }

        // In full_qa mode, test mobile responsiveness around step 6
        if (this.mode === 'full_qa' && stepCounter === 6 && !isMobileTested) {
          isMobileTested = true;
          this.chat.addMessage({ type: 'system', text: 'Switching to a phone-sized screen (375px) to check the mobile layout.' });
          await this.browserManager.setViewportSize(375, 667);
          await new Promise((r) => setTimeout(r, 600));
        } else if (isMobileTested && stepCounter === 10) {
          await this.browserManager.setViewportSize(1280, 720);
          await new Promise((r) => setTimeout(r, 600));
        }

        const stepStartTime = Date.now();

        // Capture current state screenshot & evidence
        this.chat.setStatus('Looking at the page...');
        const screenshotBuf = await this.browserManager.takeScreenshot();
        const screenshotBase64 = screenshotBuf.toString('base64');
        const evidence = await this.browserManager.getEvidenceSummary();
        const interactiveElements = await this.browserManager.extractInteractiveElements();
        const currentUrl = this.browserManager.getPage().url();

        // Ask Gemini for next action
        this.chat.setStatus('Thinking about the next step...');
        let decision: ActionDecision;
        try {
          decision = await decideNextAction({
            apiKey: this.geminiKey,
            command: this.command,
            mode: this.mode,
            currentUrl,
            stepsSoFar: this.steps,
            screenshotJpegBase64: screenshotBase64,
            elements: interactiveElements,
            evidence,
          });
          this.chat.countRequest();
        } catch (geminiErr: unknown) {
          this.chat.countRequest();
          console.error(`[Agent] Gemini decision error:`, this.safeText(geminiErr));
          const code = (geminiErr as { code?: string } | null)?.code;
          this.chat.addMessage({
            type: 'system',
            text:
              code === 'gemini_quota_exceeded'
                ? 'Your Gemini free quota ran out, so I stopped early and saved what I found so far.'
                : 'The AI did not answer, so I stopped early and saved what I found so far.',
            state: 'failed',
          });
          break;
        }

        if (!decision || !decision.next || !decision.next.type) {
          this.chat.addMessage({
            type: 'system',
            text: 'The AI gave an unreadable answer, so I stopped early and saved what I found so far.',
            state: 'failed',
          });
          break;
        }

        // Record any issues identified in this step
        if (decision.issues && decision.issues.length > 0) {
          for (const issue of decision.issues) {
            const lastShot = this.steps[this.steps.length - 1]?.screenshot || '';
            this.rawIssues.push({
              title: issue.title,
              severity: issue.severity,
              evidence: issue.evidence,
              pageUrl: currentUrl,
              screenshotUrl: lastShot,
              stepIndex: stepCounter,
            });

            const key = String(issue.title || '').trim().toLowerCase();
            if (key && !this.seenFindings.has(key)) {
              this.seenFindings.add(key);
              this.chat.addMessage({
                type: 'finding',
                caption: issue.title,
                text: issue.evidence,
                severity: issue.severity,
                stepIndex: stepCounter,
                screenshot: lastShot || null,
              });
            }
          }
        }

        const isFinish = decision.next.type === 'finish';
        const narration = this.chat.addMessage({
          type: 'ai',
          caption: decision.caption || undefined,
          text: (decision.say || decision.observation || '').trim() || 'Continuing the test.',
          stepIndex: isFinish ? undefined : stepCounter + 1,
          state: isFinish ? 'done' : 'running',
        });

        // If goal complete or finished
        if (isFinish) {
          console.log(`[Agent] Exploration completed by decision: ${decision.observation}`);
          break;
        }

        // Execute chosen action
        this.chat.setStatus(`Doing: ${(decision.caption || decision.next.type).slice(0, 60)}...`);
        const actionResult = await this.browserManager.executeAction(
          decision.next,
          this.credentials,
          interactiveElements
        );

        stepCounter++;
        this.chat.setStatus('Taking a screenshot...');
        const postScreenshotBuf = await this.browserManager.takeScreenshot();
        const postScreenshotUrl = await uploadScreenshot(this.runId, stepCounter, postScreenshotBuf);

        const stepStatus = actionResult.success
          ? 'passed'
          : decision.next.type === 'wait'
          ? 'warning'
          : 'failed';

        const stepObj: Step = {
          index: stepCounter,
          action: actionResult.description || decision.observation || `Step ${stepCounter}`,
          status: stepStatus,
          durationMs: Date.now() - stepStartTime,
          screenshot: postScreenshotUrl,
        };

        this.steps.push(stepObj);

        this.chat.updateMessage(narration.id, {
          screenshot: postScreenshotUrl,
          state: actionResult.success ? 'done' : 'failed',
        });
        if (!actionResult.success) {
          this.chat.addMessage({
            type: 'system',
            text: `That action did not work: ${this.safeText(actionResult.description || 'unknown reason').slice(0, 200)}`,
            state: 'failed',
          });
        }

        // Update database immediately after every step for live streaming
        await updateRunStepRow(this.runId, this.steps, currentStatus);
      }

      if (currentStatus !== 'stopped') {
        currentStatus = 'completed';
      }

      // 4. Synthesize final bug report from evidence and steps
      this.chat.setStatus('Writing the report...');
      const finalEvidence = await this.browserManager.getEvidenceSummary();

      if (this.rawIssues.length > 0) this.chat.countRequest();
      finalBugs = await generateFinalBugReport({
        apiKey: this.geminiKey,
        command: this.command,
        url: this.url,
        steps: this.steps,
        rawIssues: this.rawIssues,
        evidence: finalEvidence,
      });
    } catch (err: unknown) {
      console.error(`[Agent] Run ${this.runId} encountered error:`, this.safeText(err));
      if (currentStatus !== 'stopped') {
        currentStatus = 'failed';
      }
      const rawMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
          ? String((err as { message: string }).message)
          : 'An unexpected error occurred during test execution.';
      runError = {
        code: 'run_failed',
        message: this.safeText(rawMessage).slice(0, 500),
      };
    } finally {
      // 5. Clean up browser
      await this.browserManager.close();

      // Clean up stop flag
      stopRequestedSet.delete(this.runId);

      // Release concurrency lock
      releaseRunLock(this.runId);

      // Calculate deterministic score
      const score = calculateScore(finalBugs);

      // Closing messages in the chat
      if (currentStatus === 'stopped') {
        this.chat.addMessage({ type: 'system', text: 'Stopped by you. Saved what I found so far.' });
      } else if (runError) {
        this.chat.addMessage({ type: 'system', text: `The test failed: ${runError.message}`, state: 'failed' });
      } else {
        this.chat.addMessage({
          type: 'summary',
          text: `Test finished: ${this.steps.length} steps, ${finalBugs.length} bug(s), score ${score}/100.`,
        });
      }
      this.chat.setStatus(null);
      await this.chat.flush();

      // Finalize run in Supabase
      await finalizeRunRow(this.runId, {
        status: currentStatus,
        steps: this.steps,
        bugs: finalBugs,
        score,
        error: runError,
      });
    }
  }
}
