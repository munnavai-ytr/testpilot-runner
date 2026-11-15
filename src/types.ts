export type TestMode = 'smoke' | 'user_flow' | 'full_qa';

export type StepStatus = 'running' | 'passed' | 'failed' | 'warning';

export type RunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Step {
  index: number;
  action: string;
  status: StepStatus;
  durationMs: number;
  screenshot: string | null;
}

export interface Bug {
  id: string;
  title: string;
  severity: BugSeverity;
  pageUrl: string;
  screenshot: string;
  whatHappened: string;
  whyItHappened: string;
  howToFix: string;
}

export interface RunSummary {
  score: number;
}

export interface RunError {
  code: string;
  message: string;
}

export interface RunCredentials {
  email?: string;
  password?: string;
}

export interface RunRecord {
  id: string;
  url: string;
  command: string;
  mode: TestMode;
  status: RunStatus;
  steps: Step[];
  bugs: Bug[];
  score: number;
  error: RunError | null;
  createdAt: string;
  updatedAt: string;
}

export interface InteractiveElement {
  index: number;
  tagName: string;
  role: string;
  accessibleName: string;
  type?: string;
  textSnippet?: string;
  selector: string;
  isDangerous?: boolean;
}

export interface ActionDecision {
  observation: string;  caption?: string;
  say?: string;
  issues: Array<{
    title: string;
    severity: BugSeverity;
    evidence: string;
  }>;
  next: {
    type:
      | 'click'
      | 'type'
      | 'type_credential'
      | 'select'
      | 'scroll'
      | 'press'
      | 'navigate'
      | 'wait'
      | 'finish';
    elementIndex?: number;
    text?: string;
    field?: 'email' | 'password';
    url?: string;
    key?: string;
  };
}

export interface ObjectiveEvidence {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  httpErrors: string[];
  brokenImages: string[];
}
