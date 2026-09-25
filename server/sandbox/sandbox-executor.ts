export type SandboxJob = {
  language: "python";
  code: string;
  files?: { name: string; content: Buffer }[];
  timeoutMs?: number;
};

export type SandboxResult = { stdout: string; stderr: string; files: { name: string; content: Buffer }[] };

/** Reserved extension point. No host process execution is enabled in the current release. */
export interface SandboxExecutor {
  run(job: SandboxJob): Promise<SandboxResult>;
}

export class DisabledSandboxExecutor implements SandboxExecutor {
  async run(_job: SandboxJob): Promise<SandboxResult> {
    throw new Error("Sandbox 尚未启用");
  }
}
