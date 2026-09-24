import { useEffect, useState } from "react";
import { bridge } from "../bridge";

/** A recorded design review round, exactly as `design_review` returned it. */
export interface DesignReviewDetails {
  round: number;
  verdict: "pass" | "fail";
  punchlist: string[];
  note?: string;
  escalated?: boolean;
  /** `round` is carried on each shot so the renderer can address the capture
   *  without knowing where it lives on disk. */
  shots: Array<{ viewport: string; path: string; round: number; width: number; height: number }>;
  at?: string;
}

export function isDesignReviewDetails(value: unknown): value is DesignReviewDetails {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<DesignReviewDetails>;
  return (
    typeof d.round === "number" &&
    (d.verdict === "pass" || d.verdict === "fail") &&
    Array.isArray(d.punchlist) &&
    Array.isArray(d.shots)
  );
}

/** Screenshots are files next to the design artifacts; they load on demand so
 *  a long transcript never holds every capture in memory (or in the session
 *  log, which is why the tool records paths rather than image bytes). */
function useShot(
  cwd: string | null,
  slug: string | null,
  round: number,
  viewport: string
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!cwd || !slug) return;
    let cancelled = false;
    void bridge
      // Addressed by identity: the round's record owns the file path.
      .designReviewShot({ cwd, slug, round, viewport })
      .then((r) => {
        if (!cancelled) setUrl(r.dataUrl);
      })
      .catch(() => {
        /* a missing capture must not break the transcript */
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, slug, round, viewport]);
  return url;
}

function Shot({
  cwd,
  slug,
  shot,
}: {
  cwd: string | null;
  slug: string | null;
  shot: DesignReviewDetails["shots"][number];
}) {
  const url = useShot(cwd, slug, shot.round, shot.viewport);
  return (
    <figure className="m-0 min-w-0 flex-1">
      <div className="overflow-hidden rounded-md border border-line bg-bg-soft">
        {url ? (
          <img
            src={url}
            alt={`${shot.viewport} capture`}
            width={shot.width}
            height={shot.height}
            className="block h-auto w-full"
            loading="lazy"
          />
        ) : (
          <div
            className="flex items-center justify-center text-[11px] text-dim"
            style={{ aspectRatio: `${shot.width} / ${shot.height}` }}
          >
            {shot.viewport}
          </div>
        )}
      </div>
      <figcaption className="mt-1 text-[11px] text-dim">
        {shot.viewport} · {shot.width}×{shot.height}
      </figcaption>
    </figure>
  );
}

/** The review surface: the screenshots the verdict was made from, next to the
 *  concrete punchlist. This is the loop made tangible — without it, a
 *  multi-round visual review is indistinguishable from ordinary chat. */
export default function DesignReviewCard({
  details,
  cwd,
  slug,
}: {
  details: DesignReviewDetails;
  cwd: string | null;
  slug: string | null;
}) {
  const failed = details.verdict === "fail";
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-line bg-bg-soft/40">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[12px] font-semibold text-fg">Design review {details.round}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
            failed ? "bg-warn/15 text-warn" : "bg-ok/15 text-ok"
          }`}
        >
          {failed ? "Needs work" : "Passes"}
        </span>
        {details.escalated ? (
          <span className="text-[11px] text-dim">round budget reached — escalated</span>
        ) : null}
      </div>

      {details.shots.length > 0 ? (
        <div className="flex flex-col gap-3 p-3 sm:flex-row">
          {details.shots.map((shot) => (
            <Shot key={`${shot.round}-${shot.viewport}`} cwd={cwd} slug={slug} shot={shot} />
          ))}
        </div>
      ) : null}

      {details.punchlist.length > 0 ? (
        <div className="border-t border-line px-3 py-2">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-dim">Review</p>
          <ul className="m-0 list-disc pl-4 text-[13px] leading-5 text-fg">
            {details.punchlist.map((item, i) => (
              <li key={`${i}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {details.note ? <p className="border-t border-line px-3 py-2 text-[13px] text-fg">{details.note}</p> : null}
    </div>
  );
}
