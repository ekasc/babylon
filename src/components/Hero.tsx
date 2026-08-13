import type { ProjectGroup, SessionStatus } from "../bridge";

interface Props {
  status: SessionStatus;
  groups: ProjectGroup[];
  onOpen(path: string | undefined, cwd: string): void;
  onNew(): void;
}

export default function Hero({ status, onNew }: Props) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-8">
      <div className="w-full max-w-[440px]">
        <h1 className="text-[22px] font-semibold tracking-[-0.025em]">Start working with Pi</h1>
        <p className="mt-2 text-[15px] leading-6 text-dim">
          Open an existing session from a project, or choose a folder for a new one.
        </p>
        {status.status === "starting" ? (
          <p className="mt-4 text-[13px] text-accent">Preparing Pi…</p>
        ) : null}
        {status.status === "error" ? (
          <p className="mt-4 text-[14px] leading-6 text-err">{status.message}</p>
        ) : null}
        <button onClick={onNew} className="primary-button mt-6 px-5">
          New session
        </button>
        <p className="mt-3 text-[13px] text-dim">Press ⌘K to search sessions and commands.</p>
      </div>
    </div>
  );
}
