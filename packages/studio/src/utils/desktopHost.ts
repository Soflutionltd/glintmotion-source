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

export interface DesktopHost {
  listProjects: () => Promise<DesktopProject[]>;
  currentProject: () => Promise<DesktopProject | null>;
  openProject: (dir: string) => Promise<void>;
  home: (action?: "new") => Promise<void>;
  claude: {
    status: () => Promise<ClaudeStatus>;
    account: (action: ClaudeAccountAction) => Promise<ClaudeStatus>;
    cancel: () => Promise<void>;
  };
  agent: {
    models: () => Promise<string[]>;
    send: (request: { prompt: string; model: string }) => Promise<void>;
    stop: () => Promise<void>;
    reset: () => Promise<void>;
    onEvent: (callback: (event: AgentEvent) => void) => () => void;
  };
}

/** The bridge the Glintmotion Mac app injects; null when the studio runs in a plain browser. */
export function getDesktopHost(): DesktopHost | null {
  if (typeof window === "undefined") return null;
  const host = (window as Window & { glintmotion?: DesktopHost }).glintmotion;
  return host?.agent ? host : null;
}
