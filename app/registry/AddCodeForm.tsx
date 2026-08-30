"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addRegistryCode } from "../lib/actions-registry";

/**
 * Manual registry entry.
 *
 * The registry is normally filled in bulk - from a licensed SPN dictionary, or
 * from the unmet-demand list on the overview page. This form exists so the
 * pipeline can be exercised end to end without either of those being in place
 * yet, and so a one-off code can be added without opening a SQL client.
 *
 * The two description fields are required by the schema on purpose: a bare code
 * number is a topic, not a registry entry. Promotion into the registry means
 * knowing what the code actually is, and the researcher works far better when
 * told what it is looking for than when handed two integers.
 */
export function AddCodeForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);

  const [form, setForm] = useState({
    spn_code: "",
    fmi_code: "",
    engine_platform: "",
    spn_description: "",
    fmi_description: "",
    demand_rank: "0",
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const submit = () => {
    startTransition(async () => {
      const result = await addRegistryCode({
        spn_code: Number(form.spn_code),
        fmi_code: Number(form.fmi_code),
        engine_platform: form.engine_platform.trim(),
        spn_description: form.spn_description.trim(),
        fmi_description: form.fmi_description.trim(),
        demand_rank: Number(form.demand_rank) || 0,
      });

      setMessage({ ok: result.ok, text: result.message });

      if (result.ok) {
        // Codes are usually added in runs of several, so the platform and
        // descriptions are kept and only the numbers cleared.
        setForm((previous) => ({ ...previous, spn_code: "", fmi_code: "" }));
        router.refresh();
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-deep hover:text-ink"
      >
        Add a code
      </button>
    );
  }

  const complete =
    form.spn_code &&
    form.fmi_code &&
    form.engine_platform.trim() &&
    form.spn_description.trim() &&
    form.fmi_description.trim();

  return (
    <div className="rounded-2xl border border-hairline bg-surface p-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="SPN" value={form.spn_code} onChange={set("spn_code")} type="number" />
        <Field label="FMI (0-31)" value={form.fmi_code} onChange={set("fmi_code")} type="number" />
        <Field
          label="Demand rank"
          value={form.demand_rank}
          onChange={set("demand_rank")}
          type="number"
          hint="higher runs first"
        />
        <Field
          label="Engine platform"
          value={form.engine_platform}
          onChange={set("engine_platform")}
          placeholder="Detroit Diesel DD15"
        />
        <Field
          label="What the SPN identifies"
          value={form.spn_description}
          onChange={set("spn_description")}
          placeholder="Intake NOx sensor"
        />
        <Field
          label="What the FMI means"
          value={form.fmi_description}
          onChange={set("fmi_description")}
          placeholder="Voltage below normal or shorted to low source"
        />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled={pending || !complete}
          onClick={submit}
          className="rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-canvas transition-colors hover:bg-accent-deep hover:text-ink disabled:opacity-40"
        >
          {pending ? "Adding…" : "Add to registry"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full px-4 py-2 text-[13px] text-ink-dim hover:text-ink"
        >
          Done
        </button>
        {message ? (
          <span
            role="status"
            className={`text-[13px] ${message.ok ? "text-pass" : "text-fail"}`}
          >
            {message.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  ...input
}: {
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = `field-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-medium text-ink-dim">
        {label}
        {hint ? <span className="ml-1.5 text-ink-faint">{hint}</span> : null}
      </label>
      <input
        id={id}
        {...input}
        className="mt-1 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint"
      />
    </div>
  );
}
