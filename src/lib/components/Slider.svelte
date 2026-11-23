<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends Omit<HTMLInputAttributes, "type"> {
    label: string;
    neutral?: number;
    unit?: string;
    labelPosition?: "inline" | "top";
    showOutput?: boolean;
  }

  let {
    label,
    value = $bindable(),
    min,
    max,
    step,
    neutral,
    unit = "",
    labelPosition = "inline",
    showOutput = true,
    ...rest
  }: Props = $props();
</script>

<label class={["slider", { top: labelPosition === "top" }]}>
  <span>{label}</span>
  <input
    type="range"
    {min}
    {max}
    {step}
    bind:value
    ondblclick={() => {
      if (neutral !== undefined) value = String(neutral);
    }}
    {...rest}
  />
  {#if showOutput}
    <output>
      {Number(value).toFixed(Number.isInteger(Number(step)) ? 0 : 1)}
      {unit}
    </output>
  {/if}
</label>

<style>
  .slider {
    display: grid;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
  }

  .slider:not(.top) {
    grid-template-columns: 8rem minmax(0, 1fr) 3rem;
  }

  input {
    padding: 0;
    accent-color: var(--color-ink);
  }
</style>
