"use server";

import { revalidatePath } from "next/cache";
import { db } from "./db";

/**
 * Write paths for the console.
 *
 * These are the only mutations in the whole system that a human performs, and
 * the approval one is the gate the entire pipeline is built around: nothing
 * reaches the public site without a person passing through here.
 *
 * There is no authentication because the console is never deployed - it runs on
 * localhost against a key held on one machine. That is a deliberate tradeoff,
 * and it is only safe while the "never deployed" half stays true. Putting this
 * behind a public URL without adding auth would expose unrestricted write
 * access to the article table.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Approve an article for publication.
 *
 * The database enforces completeness independently through a CHECK constraint,
 * so a missing meta description or tool SKU fails here rather than producing a
 * broken page downstream. The error is surfaced verbatim rather than
 * translated: "violates check constraint" is more useful to whoever is fixing
 * it than a friendly paraphrase that hides which rule was broken.
 */
export async function approveArticle(id: string): Promise<ActionResult> {
  const { error } = await db()
    .from("fault_code_articles")
    .update({ status: "approved" })
    .eq("id", id);

  if (error) {
    return {
      ok: false,
      message: error.message.includes("ready_for_approval")
        ? "Incomplete: an article needs content, a meta description, a tool SKU and at least one taxonomy tag before it can be approved."
        : error.message,
    };
  }

  // Both paths are revalidated: the queue's counts change and the detail page's
  // status badge changes, and a reviewer moving between them should not see a
  // cached version of the state they just left.
  revalidatePath("/review");
  revalidatePath(`/review/${id}`);
  revalidatePath("/");
  return { ok: true, message: "Approved. It will sync to Webflow as a draft on the next run." };
}

/**
 * Send an article back.
 *
 * Rejected articles are set to `failed` rather than deleted. The row is the
 * record of what the pipeline produced and why it was not good enough - the
 * most useful debugging artefact the system generates. Deleting it would throw
 * away the evidence needed to fix the prompt that caused it.
 */
export async function rejectArticle(id: string, reason: string): Promise<ActionResult> {
  const supabase = db();

  const { data: existing } = await supabase
    .from("fault_code_articles")
    .select("provenance_audit")
    .eq("id", id)
    .maybeSingle<{ provenance_audit: Record<string, unknown> | null }>();

  const audit = existing?.provenance_audit ?? {};

  const { error } = await supabase
    .from("fault_code_articles")
    .update({
      status: "failed",
      provenance_audit: {
        ...audit,
        human_rejection: {
          reason,
          at: new Date().toISOString(),
        },
      },
    })
    .eq("id", id);

  if (error) return { ok: false, message: error.message };

  revalidatePath("/review");
  revalidatePath(`/review/${id}`);
  revalidatePath("/");
  return { ok: true, message: "Rejected. The article and its audit are kept for diagnosis." };
}

/**
 * Save a reviewer's edits to the article body.
 *
 * Editing does not change status. A reviewer fixing a sentence has not thereby
 * approved the article, and conflating the two would let an approval happen by
 * accident - which is the one thing this interface must never do.
 *
 * Touching updated_at flips the generated `needs_sync` column, so an edit to an
 * already-published article re-syncs on the next run without anyone having to
 * remember that.
 */
export async function saveArticleBody(
  id: string,
  markdown: string,
): Promise<ActionResult> {
  if (markdown.trim().length === 0) {
    return { ok: false, message: "Refusing to save an empty article body." };
  }

  const { error } = await db()
    .from("fault_code_articles")
    .update({ content_markdown: markdown, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return { ok: false, message: error.message };

  revalidatePath(`/review/${id}`);
  return { ok: true, message: "Saved. Status unchanged." };
}

/**
 * Return a previously rejected article to the queue.
 *
 * The escape hatch for a wrong call. Without it a mis-rejection is permanent
 * and the only remedy is regenerating the article, which costs money and
 * discards a draft that was probably fine.
 */
export async function requeueArticle(id: string): Promise<ActionResult> {
  const { error } = await db()
    .from("fault_code_articles")
    .update({ status: "pending_review" })
    .eq("id", id);

  if (error) return { ok: false, message: error.message };

  revalidatePath("/review");
  revalidatePath(`/review/${id}`);
  return { ok: true, message: "Back in the review queue." };
}
