<script lang="ts">
  import { RAMPS, rampCss } from "../ramp";

  let { rampId = $bindable(RAMPS[0].id) }: { rampId?: string } = $props();
</script>

<label class="ramp-field">
  Colour ramp
  <select class="ramp-select" bind:value={rampId}>
    <button type="button" class="ramp-trigger">
      <selectedcontent></selectedcontent>
    </button>

    {#each RAMPS as r (r.id)}
      <option value={r.id} class="ramp-option">
        <span
          class="ramp-swatch"
          aria-hidden="true"
          style:background={rampCss(r)}
        ></span>
        <span class="ramp-name">{r.name}</span>
      </option>
    {/each}
  </select>
</label>

<style>
  .ramp-field {
    display: inline-flex;
    flex-direction: column;
    gap: var(--size-sm);
  }

  /* Opt into customizable select + popover picker */
  .ramp-select,
  .ramp-select::picker(select) {
    appearance: base-select;
  }

  .ramp-select {
    min-width: 15rem;
    padding: 0.4rem 0.6rem;
    background-color: var(--color-well);
    border: 1px solid var(--color-edge);
    border-radius: var(--size-sm);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  /* Style both the closed trigger and open options consistently */
  .ramp-select selectedcontent,
  .ramp-option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .ramp-select::picker(select) {
    margin-top: 0.25rem;
    padding: 0.25rem;
    border: 1px solid currentColor;
    border-radius: 0.375rem;
    background: var(--color-bg);
    color: var(--color-ink);
  }

  .ramp-option {
    padding: 0.375rem 0.5rem;
    border-radius: 0.25rem;
    cursor: pointer;
  }

  .ramp-option:hover,
  .ramp-option:focus-visible {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }

  .ramp-option:checked {
    font-weight: 600;
  }

  /* Gradient bar */
  .ramp-swatch {
    flex: 0 0 4.5rem;
    height: 0.85rem;
    border-radius: 0.2rem;
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, currentColor 25%, transparent);
  }

  .ramp-name {
    white-space: nowrap;
  }
</style>
