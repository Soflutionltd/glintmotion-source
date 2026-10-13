export interface DesktopProject {
  path: string;
  name: string;
  openedAt: string | null;
  modifiedAt: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; target: string }
  | {
      kind: "done";
      error: string | null;
      stopped?: boolean;
      costUsd: number | null;
      durationMs: number | null;
    };

export interface ClaudeStatus {
  installed: boolean;
  loggedIn: boolean;
  email: string | null;
  busy: boolean;
}

export type ClaudeAccountAction = "install" | "login" | "logout" | "switch";

export type DeliveryPreset = "reel" | "post" | "square" | "original";

export type MotionIssue = "late_start" | "stall" | "tail_tick" | "early_finish" | "judder";

/** One badly-reading tween, as apps/desktop/motion-check.mjs reports it (times in seconds). */
export interface MotionFinding {
  issue: MotionIssue;
  target: string;
  start: number;
  end: number;
  message: string;
  hint: string;
}

export interface MotionCheckReport {
  tweensChecked: number;
  seconds: number;
  findings: MotionFinding[];
}

export interface DesktopHost {
  listProjects: () => Promise<DesktopProject[]>;
  currentProject: () => Promise<DesktopProject | null>;
  openProject: (dir: string) => Promise<void>;
  home: (action?: "new") => Promise<void>;
  music: {
    hasKey: () => Promise<boolean>;
    saveKey: (key: string) => Promise<void>;
    clearKey: () => Promise<void>;
    /** Resolves to the new track's project-relative path. */
    generate: (request: { prompt: string; seconds: number }) => Promise<string>;
  };
  motion: {
    /** Watches every tween of the saved project frame by frame; about 0.3 s per tween. */
    check: () => Promise<MotionCheckReport>;
  };
  deliver: {
    /** Resolves to the delivered file's absolute path. */
    render: (request: {
      filename: string;
      preset: DeliveryPreset;
      color: string;
    }) => Promise<string>;
    reveal: (file: string) => Promise<void>;
  };
  claude: {
    status: () => Promise<ClaudeStatus>;
    account: (action: ClaudeAccountAction) => Promise<ClaudeStatus>;
    cancel: () => Promise<void>;
  };
  updates: {
    /** Playback or an export running: the app holds a downloaded update until it is false. */
    reportBusy: (busy: boolean) => void;
    /** Runs just before an update restart; the restart waits for the promise (up to 8 s). */
    onPrepare: (prepare: () => Promise<void>) => () => void;
  };
  agent: {
    models: () => Promise<string[]>;
    send: (request: { prompt: string; model: string }) => Promise<void>;
    stop: () => Promise<void>;
    reset: () => Promise<void>;
    onEvent: (callback: (event: AgentEvent) => void) => () => void;
  };
}

/** A host call's failure as the person should read it, without Electron's IPC wrapper. */
export function hostErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** The bridge the Glintmotion Mac app injects; null when the studio runs in a plain browser. */
export function getDesktopHost(): DesktopHost | null {
  if (typeof window === "undefined") return null;
  const host = (window as Window & { glintmotion?: DesktopHost }).glintmotion;
  return host?.agent ? host : null;
}
