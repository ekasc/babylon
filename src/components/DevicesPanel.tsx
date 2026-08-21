import { useState } from "react";
import {
  ALL_DEVICE_SCOPES,
  listDevices,
  pairDevice,
  revokeDevice,
  type DeviceRegistry,
  type DeviceScope,
} from "../device-pairing";

const SCOPE_LABELS: Record<DeviceScope, string> = {
  view_tasks: "View tasks",
  view_state: "View agent state",
  receive_attention: "Receive attention",
  approve_deny: "Approve / deny",
  answer_questions: "Answer questions",
  stop_resume: "Stop / pause / resume",
  view_diffs: "View diffs",
};

/**
 * Device pairing surface (Phase 7). Lists paired remote devices, pairs new
 * ones with an explicit scope grant, and revokes grants. The pairing token is
 * shown exactly once; only its hash is stored in the registry. Hashing is
 * injected because the pure registry stays renderer-safe.
 */
export function DevicesPanel({
  registry,
  setRegistry,
  onClose,
  pairingCrypto,
}: {
  registry: DeviceRegistry;
  setRegistry: (next: DeviceRegistry | ((prev: DeviceRegistry) => DeviceRegistry)) => void;
  onClose: () => void;
  pairingCrypto: {
    newToken: () => string;
    hash: (token: string) => Promise<string>;
  };
}) {
  const devices = listDevices(registry);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<DeviceScope[]>(["view_tasks"]);
  const [error, setError] = useState<string | null>(null);
  const [shownToken, setShownToken] = useState<{ name: string; token: string } | null>(null);

  const toggleScope = (s: DeviceScope) =>
    setScope((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const pair = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Give the device a name first.");
      return;
    }
    if (scope.length === 0) {
      setError("Pick at least one scope.");
      return;
    }
    const token = pairingCrypto.newToken();
    const tokenHash = await pairingCrypto.hash(token);
    const id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const result = pairDevice(registry, { id, name: name.trim(), scope, tokenHash, now: Date.now() });
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setRegistry(result);
    setShownToken({ name: name.trim(), token });
    setName("");
    setScope(["view_tasks"]);
  };

  const revoke = (id: string) => setRegistry((prev) => revokeDevice(prev, id));

  return (
    <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/50 p-6" onMouseDown={onClose}>
      <div className="modal-surface w-full max-w-lg p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold tracking-tight">Paired devices</h3>
          <button onClick={onClose} className="rounded-lg border border-line px-2 py-1 text-[12.5px] hover:border-accent">
            Close
          </button>
        </div>

        {shownToken ? (
          <div className="mt-3 rounded-lg border border-warn bg-warn/10 p-3">
            <div className="text-[12.5px] font-semibold text-warn">
              Pairing token for {shownToken.name} — shown once
            </div>
            <code className="mt-2 block break-all rounded-md bg-bg px-2 py-1.5 text-[12px]">{shownToken.token}</code>
            <p className="mt-2 text-[11.5px] text-dim">
              Enter this token on the device to sign in. Babylon stores only a hash; losing it means pairing again.
            </p>
            <button
              onClick={() => setShownToken(null)}
              className="mt-2 rounded-lg bg-accent px-3 py-1 text-[12px] font-semibold text-bg hover:opacity-90"
            >
              I saved it
            </button>
          </div>
        ) : null}

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Devices</div>
          {devices.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-dim">No paired devices yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {devices.map((d) => (
                <li key={d.id} className="rounded-lg border border-line bg-bg/40 px-2.5 py-1.5 text-[12.5px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{d.name}</span>
                    {d.revoked ? (
                      <span className="pill bg-err/10 text-err">revoked</span>
                    ) : (
                      <span className="pill bg-ok/10 text-ok">active</span>
                    )}
                    {!d.revoked ? (
                      <button
                        onClick={() => revoke(d.id)}
                        className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11.5px] hover:border-err hover:text-err"
                      >
                        Revoke
                      </button>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.scope.map((s) => (
                      <span key={s} className="pill bg-raised text-dim">
                        {SCOPE_LABELS[s]}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 text-[11px] text-dim">Last seen {new Date(d.lastSeenAt).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 border-t border-line pt-3">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-dim">Pair a device</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Device name, e.g. Ekas phone"
            className="mt-2 w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
          />
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {ALL_DEVICE_SCOPES.map((s) => {
              const active = scope.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleScope(s)}
                  className={`rounded-lg border px-2 py-1.5 text-left text-[12px] ${
                    active ? "border-accent bg-accent/10 text-accent" : "border-line text-dim hover:border-accent"
                  }`}
                >
                  {SCOPE_LABELS[s]}
                </button>
              );
            })}
          </div>
          {error ? <p className="mt-2 text-[12px] text-err">{error}</p> : null}
          <button
            onClick={() => void pair()}
            className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-90"
          >
            Pair device
          </button>
        </div>
      </div>
    </div>
  );
}
