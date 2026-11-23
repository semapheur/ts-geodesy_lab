<script lang="ts" generics="T = string">
  import type { HTMLSelectAttributes } from "svelte/elements";
  import type { SelectGroup, SelectOption } from "../types";

  type OptionInput<T> = T | SelectOption<T>;

  interface Props<T> extends HTMLSelectAttributes {
    label?: string | null;
    value?: T | null;
    options?: readonly OptionInput<T>[];
    groups?: readonly SelectGroup<T>[];
  }

  const uid = $props.id();
  let {
    label,
    value = $bindable(),
    options,
    groups,
    ...rest
  }: Props<T> = $props();

  const normalizedOptions = $derived(
    options.map((o): SelectOption<T> => {
      if (typeof o === "object" && o !== null && "label" in o) {
        return o as SelectOption<T>;
      }

      if (typeof o === "string") {
        return {
          label: o,
          value: o.toLowerCase() as T,
        };
      }

      return {
        label: String(o),
        value: o as T,
      };
    }),
  );
</script>

<label for={uid}>
  {label}
  <select id={uid} bind:value {...rest}>
    {#if groups}
      {#each groups as g (g.label)}
        <optgroup label={g.label}>
          {#each g.options as o (o.value)}
            <option value={o.value}>{o.label}</option>
          {/each}
        </optgroup>
      {/each}
    {:else}
      {#each normalizedOptions as o}
        <option value={o.value}>{o.label}</option>
      {/each}
    {/if}
  </select>
</label>

<style>
  label {
    font-size: var(--text-sm);
  }

  select {
    padding: var(--size-sm);
    color: var(--color-ink);
    background-color: var(--color-well);
    border: 1px solid var(--line);
    border-radius: var(--size-sm);
  }
</style>
