"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  approveArticle,
  rejectArticle,
  requeueArticle,
  saveArticleBody,
  type ActionResult,
} from "../../lib/actions";

/**
 * The decision bar.
 *
 * The only client component in the console. Everything else renders on the
 * server and ships no JavaScript; this needs state because approving is
 * destructive-ish and rejecting requires a reason, and neither should happen on
 * a mis-click.
 *
 * useTransition rather than a hand-rolled loading flag: it keeps the buttons
 * responsive and disabled for exactly as long as the server action is in
 * flight, including the revalidation that follows it. A manual boolean would
 * clear on the action's return and let a second click through while the page
 * was still re-rendering.
 */
export function ReviewActions({
  articleId,
  status,
  markdown,
}: {
  articleId: string;
  status: string;
  markdown: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  // Rejection is two-step. A single "Reject" button next to "Approve" is a
  // mis-click away from discarding work, and the reason field is what makes a
  // rejected article useful later for diagnosing the prompt that caused it.
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);

  const run = (action: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const outcome = await action();
      setResult(outcome);
      if (outcome.ok) {
        setRejecting(false);
        setEditing(false);
        router.refresh();
      }
    });
  };

  const decided = status === "approved" || status === "published";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!decided ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => approveArticle(articleId))}
            className="rounded-full bg-pass px-4 py-2 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Working…" : "Approve"}
          </button>
        ) : (
          <span className="text-[13px] text-pass">
            Approved — syncs to Webflow as a draft on the next run.
          </span>
        )}

        {status === "failed" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => requeueArticle(articleId))}
            className="rounded-full bg-inset px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-raised disabled:opacity-50"
          >
            Return to queue
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setRejecting((open) => !open)}
            className="rounded-full bg-inset px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-raised disabled:opacity-50"
          >
            Reject…
          </button>
        )}

        <button
          type="button"
          disabled={pending}
          onClick={() => setEditing((open) => !open)}
          className="rounded-full border border-hairline px-4 py-2 text-[13px] font-semibold text-ink-dim transition-colors hover:text-ink disabled:opacity-50"
        >
          {editing ? "Cancel edit" : "Edit body"}
        </button>
      </div>

      {rejecting ? (
        <div className="rounded-xl border border-hairline bg-raised p-4">
          <label
            htmlFor="reject-reason"
            className="block text-[12px] font-medium text-ink-dim"
          >
            Why is this being rejected? Stored with the article for diagnosing the
            prompt that produced it.
          </label>
          <textarea
            id="reject-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. invented a pin voltage the sources never state"
            className="mt-2 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint"
          />
          <button
            type="button"
            disabled={pending || reason.trim().length === 0}
            onClick={() => run(() => rejectArticle(articleId, reason.trim()))}
            className="mt-3 rounded-full bg-fail px-4 py-2 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Confirm rejection
          </button>
        </div>
      ) : null}

      {editing ? (
        <div className="rounded-xl border border-hairline bg-raised p-4">
          <label htmlFor="body-edit" className="block text-[12px] font-medium text-ink-dim">
            Article markdown. Saving does not approve — status is left untouched
            deliberately, so fixing a sentence can never publish something by accident.
          </label>
          <textarea
            id="body-edit"
            rows={22}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="mt-2 w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-[12px] leading-relaxed text-ink"
          />
          <button
            type="button"
            disabled={pending || draft.trim().length === 0}
            onClick={() => run(() => saveArticleBody(articleId, draft))}
            className="mt-3 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-deep hover:text-ink disabled:opacity-40"
          >
            Save changes
          </button>
        </div>
      ) : null}

      {result ? (
        <p
          role="status"
          className={`text-[13px] ${result.ok ? "text-pass" : "text-fail"}`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
