<script lang="ts">
	let { children = $bindable() }: { children?: import("svelte").Snippet } =
		$props();
</script>

<div data-slot="filter-field" class="flex w-full items-center gap-3">
	{@render children?.()}
</div>
