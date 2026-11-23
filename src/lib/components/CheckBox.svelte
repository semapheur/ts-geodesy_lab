<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    checked: boolean;
    children: Snippet;
  }

  let { checked = $bindable(), children }: Props = $props();
</script>

<label>
  <input type="checkbox" bind:checked />
  <span>
    {@render children()}
  </span>
</label>

<style>
  label {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--size-lg);
    font-size: var(--text-sm);
  }

  input {
    display: grid;
    place-content: center;
    appearance: none;
    width: 1rem;
    height: 1rem;
    background: var(--color-bg);
    border: 1px solid var(--color-edge);
    border-radius: var(--size-xs);

    &:checked {
      &::before {
        transform: scale(1);
      }
    }

    &::before {
      content: "";
      width: 0.65rem;
      height: 0.65rem;
      transform: scale(0);
      transition: 120ms transform ease-in-out;
      border-radius: var(--size-xs);
      box-shadow: inset 1rem 1rem var(--color-ink);
    }
  }
</style>
