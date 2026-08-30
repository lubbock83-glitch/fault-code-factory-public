"use server";

import { revalidatePath } from "next/cache";
import { db } from "./db";
import type { ActionResult } from "./actions";

/**
 * Registry mutations.
 *
 * Split from actions.ts because the two files have different blast radii.
 * actions.ts decides what reaches the public site; this one only decides what
 * the pipeline will look at next. Keeping them apart makes the review gate easy
 * to audit as a unit - everything that can publish lives in one file.
 */

export interface NewRegistryCode {
  spn_code: number;
  fmi_code: number;
  engine_platform: string;
  spn_description: string;
  fmi_description: string;
  demand_rank: number;
}

export async function addRegistryCode(input: NewRegistryCode): Promise<ActionResult> {
  // Validated here rather than trusted from the form. Server actions are
  // ordinary HTTP endpoints - client-side validation is a convenience for the
  // person typing, never a guarantee about what arrives.
  if (!Number.isInteger(input.spn_code) || input.spn_code < 0) {
    return { ok: false, message: "SPN must be a non-negative whole number." };
  }
  if (!Number.isInteger(input.fmi_code) || input.fmi_code < 0 || input.fmi_code > 31) {
    return { ok: false, message: "FMI must be a whole number between 0 and 31." };
  }
  if (!input.engine_platform || !input.spn_description || !input.fmi_description) {
    return {
      ok: false,
      message: "Platform and both descriptions are required - the researcher needs to know what it is looking for.",
    };
  }

  const { error } = await db().from("fault_code_registry").insert({
    spn_code: input.spn_code,
    fmi_code: input.fmi_code,
    engine_platform: input.engine_platform,
    spn_description: input.spn_description,
    fmi_description: input.fmi_description,
    demand_rank: input.demand_rank,
  });

  if (error) {
    // 23505 is Postgres' unique_violation. The UNIQUE constraint on
    // (spn, fmi, platform) is what stops the same page being generated twice,
    // so hitting it is the constraint working - worth saying plainly rather
    // than surfacing as a database error.
    if (error.code === "23505") {
      return {
        ok: false,
        message: `SPN ${input.spn_code} FMI ${input.fmi_code} on ${input.engine_platform} is already in the registry.`,
      };
    }
    return { ok: false, message: error.message };
  }

  revalidatePath("/registry");
  revalidatePath("/");
  return {
    ok: true,
    message: `Added SPN ${input.spn_code} FMI ${input.fmi_code}.`,
  };
}
